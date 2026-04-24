import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { PublicKey, fetchAccount } from 'o1js';

/**
 * Validates a B62-format Mina pubkey. Catches garbage submitted in the
 * `feePayer` field before it reaches o1js's Mina.transaction(), which
 * would otherwise throw a cryptic binding-level error.
 */
function isValidB62Pubkey(addr: string): boolean {
  if (typeof addr !== 'string' || !addr.startsWith('B62') || addr.length < 50) {
    return false;
  }
  try {
    PublicKey.fromBase58(addr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rate limiter for `/api/tx/*` — each tx call triggers 7-60s of CPU
 * in tx.prove(). A single authenticated client flooding this path could
 * pin a CPU core and block every other user. 20 proves/minute per
 * originating IP is a generous cap for any legitimate operator.
 */
const txRouteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many tx build requests; try again in a minute.' },
});

import { prisma } from './db.js';
import { deleteContract, type MinaGuardIndexer } from './indexer.js';
import type { BackendConfig } from './config.js';
import { fetchLatestBlockHeight, fetchVerificationKeyHash } from './mina-client.js';
import { serializeProposalRecord, type ContractState } from './proposal-record.js';
import {
  acquireLightnetAccount,
  computeFundingAmount,
  LightnetAcquireError,
  releaseLightnetAccount,
  sendSignedLightnetPayment,
  withLightnetAccount,
} from './lightnet.js';
import {
  clampedIntQuerySchema,
  nullableBlockQuerySchema,
  optionalBooleanQuerySchema,
  optionalNonEmptyStringQuerySchema,
  addressParamsSchema,
  proposalParamsSchema,
  addressParamsMiddleware,
  proposalParamsMiddleware,
  type AddressParams,
  type ProposalParams,
  validateQuery,
} from './request-validation.js';
import { wrapAsyncRoute } from './route-utils.js';

const ownersQuerySchema = z.object({
  active: optionalBooleanQuerySchema,
});

const proposalsQuerySchema = z.object({
  status: optionalNonEmptyStringQuerySchema,
  limit: clampedIntQuerySchema(50, 1, 200),
  offset: clampedIntQuerySchema(0, 0, 10_000),
});

const eventsQuerySchema = z.object({
  fromBlock: nullableBlockQuerySchema,
  toBlock: nullableBlockQuerySchema,
  limit: clampedIntQuerySchema(100, 1, 500),
  offset: clampedIntQuerySchema(0, 0, 50_000),
});

const submissionBodySchema = z.object({
  action: z.enum(['approve', 'execute']),
  txHash: z.string().min(1).max(200),
});

type OwnersQuery = z.infer<typeof ownersQuerySchema>;
type ProposalsQuery = z.infer<typeof proposalsQuerySchema>;
type EventsQuery = z.infer<typeof eventsQuerySchema>;

/** Creates the read-only API router bound to shared indexer status and Prisma data. */
export function createApiRouter(indexer: MinaGuardIndexer, config?: BackendConfig): Router {
  const router = Router();
  const safe = wrapAsyncRoute();
  router.use(requestLoggerMiddleware());

  // Rate-limit the CPU-heavy proving endpoints. See `txRouteLimiter`.
  router.use('/api/tx', txRouteLimiter);

  /**
   * Shared middleware for `/api/tx/*`: validates `feePayer` in the body
   * as a real B62 pubkey before any tx-service code tries to build a
   * transaction. Saves ~7-60s of wasted prove time on malformed input.
   * Skipped for `deploy-and-setup` (uses `feePayer` at a different
   * validation point inside that handler).
   */
  router.use('/api/tx', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const body = (req.body ?? {}) as { feePayer?: unknown };
    if (body.feePayer === undefined) return next(); // handler will reject
    if (typeof body.feePayer !== 'string' || !isValidB62Pubkey(body.feePayer)) {
      res.status(400).json({
        error: 'feePayer must be a valid B62… Mina public key',
      });
      return;
    }
    next();
  });

  /** Returns basic health and process liveness metadata. */
  router.get('/health', safe(async (_req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  }));

  /** Returns current polling indexer status and latest sync metadata. */
  router.get('/api/indexer/status', safe(async (_req, res) => {
    res.json({ ...indexer.getStatus(), indexerMode: config?.indexerMode ?? 'full' });
  }));

  /** Lists tracked contracts with derived config + aggregate counts. */
  router.get('/api/contracts', safe(async (_req, res) => {
    const contracts = await prisma.contract.findMany({
      where: { ready: true },
      orderBy: { discoveredAt: 'desc' },
      include: {
        _count: {
          select: {
            proposals: true,
            events: true,
          },
        },
      },
    });

    const enriched = await Promise.all(
      contracts.map(async (contract) => {
        const [config, ownerCount] = await Promise.all([
          latestContractConfig(contract.id),
          currentOwnerCount(contract.id),
        ]);
        return decorateContract(contract, config, ownerCount);
      })
    );

    res.json(enriched);
  }));

  /** Returns one tracked contract by base58 address. */
  router.get('/api/contracts/:address', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({
      where: { address },
      include: {
        _count: {
          select: {
            proposals: true,
            events: true,
          },
        },
      },
    });

    if (!contract || !contract.ready) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const [config, ownerCount] = await Promise.all([
      latestContractConfig(contract.id),
      currentOwnerCount(contract.id),
    ]);
    res.json(decorateContract(contract, config, ownerCount));
  }));

  /** Lists child contracts (subaccounts) whose `parent` points at the given address. */
  router.get('/api/contracts/:address/children', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const children = await prisma.contract.findMany({
      where: { parent: address, ready: true },
      orderBy: { discoveredAt: 'asc' },
    });

    const enriched = await Promise.all(
      children.map(async (child) => {
        const config = await latestContractConfig(child.id);
        return decorateContract(child, config, null);
      })
    );

    res.json(enriched);
  }));

  /** Lists single-key delegation events ordered by nonce descending. */
  router.get('/api/contracts/:address/single-key-delegations', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;
    const contract = await prisma.contract.findUnique({ where: { address }, select: { id: true } });
    if (!contract) { res.status(404).json({ error: 'Contract not found' }); return; }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500);
    const rows = await prisma.singleKeyDelegation.findMany({
      where: { contractId: contract.id },
      orderBy: { nonce: 'desc' },
      take: limit,
    });
    res.json(rows);
  }));

  /** Lists recipient-allowlist entries for a contract. Optional active filter. */
  router.get('/api/contracts/:address/recipient-allowlist', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;
    const contract = await prisma.contract.findUnique({ where: { address }, select: { id: true } });
    if (!contract) { res.status(404).json({ error: 'Contract not found' }); return; }
    const activeFilter = req.query.active;
    const active = activeFilter === 'true' ? true : activeFilter === 'false' ? false : undefined;
    const rows = await prisma.recipientAllowlistEntry.findMany({
      where: {
        contractId: contract.id,
        ...(active === undefined ? {} : { active }),
      },
      orderBy: [{ active: 'desc' }, { addedAt: 'desc' }],
    });
    res.json(rows);
  }));

  /** Lists saved recipient aliases (off-chain address book). */
  router.get('/api/contracts/:address/recipient-aliases', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;
    const contract = await prisma.contract.findUnique({ where: { address }, select: { id: true } });
    if (!contract) { res.status(404).json({ error: 'Contract not found' }); return; }
    const rows = await prisma.recipientAlias.findMany({
      where: { contractId: contract.id },
      orderBy: { alias: 'asc' },
    });
    res.json(rows);
  }));

  /** Creates a recipient alias ({ alias, address }). */
  router.post('/api/contracts/:address/recipient-aliases', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;
    const contract = await prisma.contract.findUnique({ where: { address }, select: { id: true } });
    if (!contract) { res.status(404).json({ error: 'Contract not found' }); return; }
    const body = (req.body ?? {}) as { alias?: unknown; address?: unknown; createdBy?: unknown };
    const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
    const aliasTarget = typeof body.address === 'string' ? body.address.trim() : '';
    const createdBy = typeof body.createdBy === 'string' ? body.createdBy.trim() : null;
    if (!alias || !aliasTarget) {
      res.status(400).json({ error: 'alias and address required' });
      return;
    }
    const row = await prisma.recipientAlias.upsert({
      where: { contractId_alias: { contractId: contract.id, alias } },
      create: { contractId: contract.id, alias, address: aliasTarget, createdBy },
      update: { address: aliasTarget, createdBy },
    });
    res.status(201).json(row);
  }));

  /** Deletes a recipient alias by id. */
  router.delete('/api/contracts/:address/recipient-aliases/:aliasId', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;
    const aliasId = Number(req.params.aliasId);
    if (!Number.isFinite(aliasId) || aliasId <= 0) {
      res.status(400).json({ error: 'invalid aliasId' });
      return;
    }
    const contract = await prisma.contract.findUnique({ where: { address }, select: { id: true } });
    if (!contract) { res.status(404).json({ error: 'Contract not found' }); return; }
    const row = await prisma.recipientAlias.findFirst({ where: { id: aliasId, contractId: contract.id } });
    if (!row) { res.status(404).json({ error: 'Alias not found' }); return; }
    await prisma.recipientAlias.delete({ where: { id: row.id } });
    res.json({ ok: true });
  }));

  /**
   * Backend-proving deploy + setup. Moves MinaGuard.compile() out of the
   * browser WebWorker so the UI stays fast. Server compiles once per
   * process, proves + submits, returns the fresh zkApp keypair to the UI
   * (UI persists the private key locally for later child-lifecycle steps).
   *
   * Lightnet-only right now (backend fetches a funded fee-payer from the
   * lightnet account manager). Devnet/mainnet paths are a follow-up.
   */
  router.post('/api/tx/deploy-and-setup', safe(async (req, res) => {
    if (!config) {
      res.status(500).json({ error: 'Backend config unavailable' });
      return;
    }
    const body = (req.body ?? {}) as {
      owners?: unknown;
      threshold?: unknown;
      networkId?: unknown;
      feePayer?: unknown;
      delegationKey?: unknown;
      recipientAllowlistRoot?: unknown;
      enforceRecipientAllowlist?: unknown;
    };
    const owners = Array.isArray(body.owners)
      ? body.owners.filter((v): v is string => typeof v === 'string')
      : [];
    const threshold = Number(body.threshold);
    const networkId = typeof body.networkId === 'string' ? body.networkId : '';
    const feePayer = typeof body.feePayer === 'string' ? body.feePayer : '';
    const delegationKey = typeof body.delegationKey === 'string' ? body.delegationKey : null;
    const recipientAllowlistRoot =
      typeof body.recipientAllowlistRoot === 'string' ? body.recipientAllowlistRoot : null;
    const enforceRecipientAllowlist = body.enforceRecipientAllowlist === true;
    if (!owners.length || !Number.isFinite(threshold) || !networkId || !feePayer) {
      res.status(400).json({
        error: 'owners[], threshold, networkId, feePayer required',
      });
      return;
    }
    // Lazy-load the tx-service to avoid paying the MinaGuard.compile() boot
    // cost for processes that only serve read routes.
    const { deployGuard } = await import('./tx-service.js');
    try {
      const result = await deployGuard(config, {
        owners,
        threshold,
        networkId,
        feePayer,
        delegationKey,
        recipientAllowlistRoot,
        enforceRecipientAllowlist,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  }));

  /**
   * Backend-proving propose. UI collects Auro signature of the proposalHash
   * (single Field — Ledger-compatible). Backend rebuilds off-chain stores
   * from indexed events, constructs + proves + submits.
   */
  router.post('/api/tx/propose', safe(async (req, res) => {
    if (!config) { res.status(500).json({ error: 'Backend config unavailable' }); return; }
    const body = (req.body ?? {}) as {
      proposal?: unknown;
      proposer?: unknown;
      signatureBase58?: unknown;
      memo?: unknown;
    };
    if (!body.proposal || typeof body.proposer !== 'string' || typeof body.signatureBase58 !== 'string') {
      res.status(400).json({ error: 'proposal, proposer, signatureBase58 required' });
      return;
    }
    const memo = typeof body.memo === 'string' ? body.memo : undefined;
    if (memo && new TextEncoder().encode(memo).length > 32) {
      res.status(400).json({ error: 'memo must be ≤ 32 utf-8 bytes' });
      return;
    }
    const { proposeBackend } = await import('./tx-service.js');
    try {
      const result = await proposeBackend(config, {
        proposal: body.proposal as never,
        proposer: body.proposer,
        signatureBase58: body.signatureBase58,
        memo,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tx-service] ${req.path} error: ${msg}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      res.status(500).json({ error: msg });
    }
  }));

  /** Backend-proving approve. */
  router.post('/api/tx/approve', safe(async (req, res) => {
    if (!config) { res.status(500).json({ error: 'Backend config unavailable' }); return; }
    const body = (req.body ?? {}) as { proposal?: unknown; approver?: unknown; signatureBase58?: unknown };
    if (!body.proposal || typeof body.approver !== 'string' || typeof body.signatureBase58 !== 'string') {
      res.status(400).json({ error: 'proposal, approver, signatureBase58 required' });
      return;
    }
    const { approveBackend } = await import('./tx-service.js');
    try {
      const result = await approveBackend(config, {
        proposal: body.proposal as never,
        approver: body.approver,
        signatureBase58: body.signatureBase58,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tx-service] ${req.path} error: ${msg}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      res.status(500).json({ error: msg });
    }
  }));

  /**
   * Backend-proving dispatcher for every execute* @method on MinaGuard.
   * The UI sends a single POST per proposal; server picks the right zkApp
   * method based on `proposal.txType` (and `destination` for child-lifecycle).
   *
   * LOCAL txTypes: executeTransfer / executeOwnerChange / executeThresholdChange
   * / executeDelegate / executeAllocateToChildren / executeUpdateRecipientAllowlist
   * REMOTE txTypes: executeReclaimToParent / executeDestroy /
   * executeEnableChildMultiSig (run on the child guard, need childAddress).
   */
  router.post('/api/tx/execute', safe(async (req, res) => {
    if (!config) { res.status(500).json({ error: 'Backend config unavailable' }); return; }
    const body = (req.body ?? {}) as {
      proposal?: { txType?: string; destination?: string; childAccount?: string } & Record<string, unknown>;
      childAddress?: string;
      enabled?: boolean;
      feePayer?: string;
    };
    if (!body.proposal || typeof body.proposal.txType !== 'string') {
      res.status(400).json({ error: 'proposal required' });
      return;
    }
    const feePayer = typeof body.feePayer === 'string' ? body.feePayer : '';
    if (!feePayer) {
      res.status(400).json({ error: 'feePayer (connected wallet pubkey) required' });
      return;
    }
    const txType = body.proposal.txType;
    const destination = body.proposal.destination;
    const childAddress = typeof body.childAddress === 'string' && body.childAddress
      ? body.childAddress
      : (typeof body.proposal.childAccount === 'string' ? body.proposal.childAccount : '');
    const svc = await import('./tx-service.js');
    try {
      let result: { transactionJson: string };
      if (destination === '1' || destination === 'remote') {
        if (!childAddress) { res.status(400).json({ error: 'childAddress required for REMOTE' }); return; }
        if (txType === '7') {
          result = await svc.executeReclaimToParentBackend(config, { proposal: body.proposal as never, childAddress, feePayer });
        } else if (txType === '8') {
          result = await svc.executeDestroyBackend(config, { proposal: body.proposal as never, childAddress, feePayer });
        } else if (txType === '9') {
          result = await svc.executeEnableChildMultiSigBackend(config, {
            proposal: body.proposal as never,
            childAddress,
            enabled: body.enabled !== false,
            feePayer,
          });
        } else {
          res.status(400).json({ error: `REMOTE txType ${txType} not executable via backend (use wizard for CREATE_CHILD)` });
          return;
        }
      } else {
        // LOCAL
        if (txType === '0') {
          result = await svc.executeTransferBackend(config, { proposal: body.proposal as never, feePayer });
        } else if (txType === '1' || txType === '2') {
          result = await svc.executeOwnerChangeBackend(config, { proposal: body.proposal as never, feePayer });
        } else if (txType === '3') {
          result = await svc.executeThresholdChangeBackend(config, { proposal: body.proposal as never, feePayer });
        } else if (txType === '4') {
          result = await svc.executeDelegateBackend(config, { proposal: body.proposal as never, feePayer });
        } else if (txType === '6') {
          result = await svc.executeAllocateToChildrenBackend(config, { proposal: body.proposal as never, feePayer });
        } else if (txType === '10' || txType === '11') {
          result = await svc.executeUpdateRecipientAllowlistBackend(config, { proposal: body.proposal as never, feePayer });
        } else {
          res.status(400).json({ error: `Unknown LOCAL txType ${txType}` });
          return;
        }
      }
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tx-service] ${req.path} error: ${msg}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      res.status(500).json({ error: msg });
    }
  }));

  /** Back-compat alias for the original executeTransfer-only endpoint. */
  router.post('/api/tx/execute-transfer', safe(async (req, res) => {
    if (!config) { res.status(500).json({ error: 'Backend config unavailable' }); return; }
    const body = (req.body ?? {}) as { proposal?: unknown; feePayer?: string };
    if (!body.proposal) { res.status(400).json({ error: 'proposal required' }); return; }
    const feePayer = typeof body.feePayer === 'string' ? body.feePayer : '';
    if (!feePayer) { res.status(400).json({ error: 'feePayer required' }); return; }
    const { executeTransferBackend } = await import('./tx-service.js');
    try {
      const result = await executeTransferBackend(config, { proposal: body.proposal as never, feePayer });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tx-service] ${req.path} error: ${msg}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      res.status(500).json({ error: msg });
    }
  }));

  /**
   * Backend-proving `executeDelegateSingleKey`. UI collects the Auro signature
   * over the canonical 7-field message client-side; backend assembles the tx
   * and proves. Lightnet-only for now (operator-pays fee-payer).
   */
  router.post('/api/tx/delegate-single-key', safe(async (req, res) => {
    if (!config) {
      res.status(500).json({ error: 'Backend config unavailable' });
      return;
    }
    const body = (req.body ?? {}) as {
      guardAddress?: unknown;
      delegate?: unknown;
      delegationKeyPub?: unknown;
      expiryBlock?: unknown;
      signatureBase58?: unknown;
      feePayer?: unknown;
    };
    const guardAddress = typeof body.guardAddress === 'string' ? body.guardAddress : '';
    const delegationKeyPub = typeof body.delegationKeyPub === 'string' ? body.delegationKeyPub : '';
    const signatureBase58 = typeof body.signatureBase58 === 'string' ? body.signatureBase58 : '';
    const delegate = typeof body.delegate === 'string' && body.delegate ? body.delegate : null;
    const expiryBlock = typeof body.expiryBlock === 'string' ? body.expiryBlock : null;
    const feePayer = typeof body.feePayer === 'string' ? body.feePayer : '';
    if (!guardAddress || !delegationKeyPub || !signatureBase58 || !feePayer) {
      res.status(400).json({ error: 'guardAddress, delegationKeyPub, signatureBase58, feePayer required' });
      return;
    }
    const { delegateSingleKey } = await import('./tx-service.js');
    try {
      const result = await delegateSingleKey(config, {
        guardAddress,
        delegate,
        delegationKeyPub,
        expiryBlock,
        signatureBase58,
        feePayer,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  }));

  /** Lists incoming transfers to this guard (deposits, rewards, etc). */
  router.get('/api/contracts/:address/incoming', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;
    const contract = await prisma.contract.findUnique({ where: { address }, select: { id: true } });
    if (!contract) { res.status(404).json({ error: 'Contract not found' }); return; }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500);
    const rows = await prisma.incomingTransfer.findMany({
      where: { contractId: contract.id },
      orderBy: [{ blockHeight: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    res.json(rows);
  }));

  /** Lists owner records for a contract with optional active-state filter. */
  router.get(
    '/api/contracts/:address/owners',
    addressParamsMiddleware,
    validateQuery(ownersQuerySchema),
    safe(async (req, res) => {
      const { address } = addressParamsSchema.parse(req.params) as AddressParams;
      const { active } = ownersQuerySchema.parse(req.query) as OwnersQuery;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const owners = await listOwners(contract.id, active);
      res.json(owners);
    })
  );

  /** Lists proposals for a contract with optional status filter and pagination. */
  router.get(
    '/api/contracts/:address/proposals',
    addressParamsMiddleware,
    validateQuery(proposalsQuerySchema),
    safe(async (req, res) => {
      const { address } = addressParamsSchema.parse(req.params) as AddressParams;
      const { status, limit, offset } = proposalsQuerySchema.parse(req.query) as ProposalsQuery;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const latestHeight = indexer.getStatus().latestChainHeight;

      // Status is derived at read time from ProposalExecution existence +
      // expiry + nonce/config staleness vs current ContractConfig. The status
      // filter passes through to in-memory filtering after serialization.
      const dbFilter = buildProposalStatusWhere(status);

      const proposals = await prisma.proposal.findMany({
        where: {
          contractId: contract.id,
          ...dbFilter,
        },
        include: {
          receivers: { orderBy: { idx: 'asc' } },
          executions: { select: { blockHeight: true, txHash: true } },
          _count: { select: { approvals: true } },
        },
        orderBy: [{ createdAtBlock: 'desc' }, { createdAt: 'desc' }],
        // Over-fetch when status requires in-memory filtering; clamp after.
        take: needsInMemoryStatusFilter(status) ? undefined : limit,
        skip: needsInMemoryStatusFilter(status) ? undefined : offset,
      });

      const parentState = toContractState(await latestContractConfig(contract.id));
      const childStateByAddress = await buildChildStateMap(proposals);

      const serialized = proposals.map((p) =>
        serializeProposalRecord(
          p,
          latestHeight,
          parentState,
          p.childAccount ? childStateByAddress.get(p.childAccount) ?? null : null,
        ),
      );
      const filtered = status
        ? serialized.filter((s) => s.status === status)
        : serialized;
      const paged = needsInMemoryStatusFilter(status)
        ? filtered.slice(offset, offset + limit)
        : filtered;

      res.json(paged);
    })
  );

  /** Returns one proposal by contract + proposalHash identity. */
  router.get(
    '/api/contracts/:address/proposals/:proposalHash',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: {
          contractId_proposalHash: {
            contractId: contract.id,
            proposalHash,
          },
        },
        include: {
          receivers: { orderBy: { idx: 'asc' } },
          executions: { select: { blockHeight: true, txHash: true } },
          _count: { select: { approvals: true } },
        },
      });

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      const latestHeight = indexer.getStatus().latestChainHeight;
      const parentState = toContractState(await latestContractConfig(contract.id));
      const childState =
        proposal.destination === 'remote' && proposal.txType !== '5' && proposal.childAccount
          ? await resolveChildState(proposal.childAccount)
          : null;

      res.json(serializeProposalRecord(proposal, latestHeight, parentState, childState));
    })
  );

  /** Records a freshly-submitted approve/execute tx hash for later status polling.
   *  Clears any prior error for that action so the UI banner disappears on retry. */
  router.post(
    '/api/contracts/:address/proposals/:proposalHash/submissions',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;
      const parsed = submissionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid submission payload' });
        return;
      }
      const { action, txHash } = parsed.data;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true },
      });
      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const update = action === 'approve'
        ? { lastApproveTxHash: txHash, lastApproveError: null }
        : { lastExecuteTxHash: txHash, lastExecuteError: null };

      const result = await prisma.proposal.updateMany({
        where: { contractId: contract.id, proposalHash },
        data: update,
      });

      if (result.count === 0) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      res.json({ ok: true });
    })
  );

  /** Lists per-approver records for a given proposal hash. */
  router.get(
    '/api/contracts/:address/proposals/:proposalHash/approvals',
    proposalParamsMiddleware,
    safe(async (req, res) => {
      const { address, proposalHash } = proposalParamsSchema.parse(req.params) as ProposalParams;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: {
          contractId_proposalHash: {
            contractId: contract.id,
            proposalHash,
          },
        },
        select: { id: true },
      });

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      const approvals = await prisma.approval.findMany({
        where: { proposalId: proposal.id },
        orderBy: [{ blockHeight: 'asc' }, { createdAt: 'asc' }],
      });

      res.json(approvals);
    })
  );

  /** Returns raw indexed events for a contract with block and pagination filters. */
  router.get(
    '/api/contracts/:address/events',
    addressParamsMiddleware,
    validateQuery(eventsQuerySchema),
    safe(async (req, res) => {
      const { address } = addressParamsSchema.parse(req.params) as AddressParams;
      const { fromBlock, toBlock, limit, offset } = eventsQuerySchema.parse(req.query) as EventsQuery;

      const contract = await prisma.contract.findUnique({
        where: { address },
        select: { id: true, ready: true },
      });

      if (!contract || !contract.ready) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const blockHeightFilter = {
        ...(fromBlock === null ? {} : { gte: fromBlock }),
        ...(toBlock === null ? {} : { lte: toBlock }),
      };

      const events = await prisma.eventRaw.findMany({
        where: {
          contractId: contract.id,
          ...(Object.keys(blockHeightFilter).length === 0 ? {} : { blockHeight: blockHeightFilter }),
        },
        orderBy: [{ blockHeight: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      });

      res.json(events);
    })
  );

  /** Returns MINA token balance for an account address via daemon GraphQL. */
  router.get('/api/account/:address/balance', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const endpoint = config?.minaEndpoint;
    if (!endpoint) {
      res.status(503).json({ error: 'Mina endpoint not configured' });
      return;
    }

    const query = `query($publicKey: PublicKey!) { account(publicKey: $publicKey) { balance { total } } }`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { publicKey: address } }),
    });

    if (!response.ok) {
      res.status(502).json({ error: 'Daemon request failed' });
      return;
    }

    const json = (await response.json()) as {
      data?: { account?: { balance?: { total?: string } } };
    };

    const totalNano = json.data?.account?.balance?.total ?? '0';
    res.json({ balance: totalNano });
  }));

  /** Funds an account on lightnet by acquiring a pre-funded keypair from the account manager. */
  router.post('/api/fund', safe(async (req, res) => {
    const accountManagerUrl = config?.lightnetAccountManager;
    if (!accountManagerUrl) {
      res.status(503).json({ error: 'LIGHTNET_ACCOUNT_MANAGER not configured' });
      return;
    }

    const { address } = req.body as { address?: string };
    if (!address || typeof address !== 'string') {
      res.status(400).json({ error: 'address is required' });
      return;
    }

    try {
      PublicKey.fromBase58(address);
    } catch {
      res.status(400).json({ error: 'Invalid Mina public key' });
      return;
    }

    try {
      const result = await withLightnetAccount(accountManagerUrl, async (acquired) => {
        const funderPub = PublicKey.fromBase58(acquired.pk);
        const { account: funderAccount } = await fetchAccount({ publicKey: funderPub });
        const funderBalance = BigInt(funderAccount?.balance?.toBigInt() ?? 0n);
        const amountNano = computeFundingAmount(funderBalance);
        if (amountNano <= 0n) {
          return null;
        }
        const nonce = String(funderAccount?.nonce.toBigint() ?? 0n);

        const txHash = await sendSignedLightnetPayment({
          minaEndpoint: config.minaEndpoint,
          from: acquired.pk,
          to: address,
          amount: amountNano.toString(),
          fee: '100000000',
          nonce,
          privateKey: acquired.sk,
        });

        return { txHash };
      }, {
        acquireLightnetAccount,
        releaseLightnetAccount,
      });

      if (!result) {
        res.status(503).json({ error: 'No funded Lightnet accounts are currently available' });
        return;
      }

      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to acquire funded account';
      const status = error instanceof LightnetAcquireError ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }));

  /**
   * Subscribes the indexer to a contract address. Lite mode only — full
   * mode auto-discovers contracts on every tick. Idempotent: re-subscribing
   * an already-tracked address returns the existing row unchanged (the
   * original discoveredAtBlock is preserved).
   *
   * The address is not required to be deployed on-chain yet. The contract
   * row is inserted with ready=false; the indexer tick's unready-rescan
   * loop then scans [discoveredAtBlock, latestHeight] every tick until
   * events are ingested and ready flips to true.
   *
   * Body: { address: string, fromBlock?: number }
   *   - fromBlock, when supplied, sets discoveredAtBlock directly. Use
   *     this for historical subscribes (e.g. fromBlock: 0 for full
   *     history). When supplied, the address MUST already resolve to a
   *     deployed zkApp on-chain — this path is the manual "add existing
   *     account" flow, where a typo or wrong-network address would
   *     otherwise silently backfill an empty address forever.
   *   - When omitted, discoveredAtBlock defaults to
   *     `latestHeight - SUBSCRIBE_MARGIN` so a block landing between
   *     submitTx and this handler doesn't push the lower bound past the
   *     deploy. The zkApp existence check is intentionally skipped here:
   *     the auto-subscribe after a fresh deploy races the tx landing
   *     on-chain.
   */
  router.post('/api/subscribe', safe(async (req, res) => {
    if (config?.indexerMode !== 'lite') {
      res.status(404).json({ error: 'Subscribe API is only available in lite mode' });
      return;
    }

    const { address, fromBlock } = req.body as {
      address?: string;
      fromBlock?: unknown;
    };
    if (!address || typeof address !== 'string') {
      res.status(400).json({ error: 'address is required' });
      return;
    }

    try {
      PublicKey.fromBase58(address);
    } catch {
      res.status(400).json({ error: 'Invalid Mina public key' });
      return;
    }

    let fromBlockNum: number | null = null;
    if (fromBlock !== undefined) {
      if (
        typeof fromBlock !== 'number' ||
        !Number.isInteger(fromBlock) ||
        fromBlock < 0
      ) {
        res.status(400).json({ error: 'fromBlock must be a non-negative integer' });
        return;
      }
      fromBlockNum = fromBlock;
    }

    const existing = await prisma.contract.findUnique({ where: { address } });
    if (existing) {
      res.json(existing);
      return;
    }

    if (fromBlockNum !== null) {
      const verificationKeyHash = await fetchVerificationKeyHash(address);
      if (!verificationKeyHash) {
        res.status(404).json({ error: 'Account not found on-chain or not a zkApp' });
        return;
      }
    }

    // Safety margin on the default path: the UI calls subscribe right
    // after submitTx, but a block may land between submitTx and this
    // handler's fetchLatestBlockHeight. Without the margin, the unready
    // rescan's lower bound could sit one block past the deploy and
    // permanently miss it. Mirrors DISCOVERY_MARGIN in tick().
    const SUBSCRIBE_MARGIN = 5;
    const discoveredAtBlock =
      fromBlockNum ??
      Math.max(0, (await fetchLatestBlockHeight(config)) - SUBSCRIBE_MARGIN);

    const created = await prisma.contract.create({
      data: { address, discoveredAtBlock },
    });

    res.json(created);
  }));

  /**
   * Unsubscribes from a contract and deletes all of its tracked history
   * (events, configs, memberships, proposals, approvals, executions).
   * Lite mode only.
   */
  router.delete('/api/subscribe/:address', addressParamsMiddleware, safe(async (req, res) => {
    if (config?.indexerMode !== 'lite') {
      res.status(404).json({ error: 'Subscribe API is only available in lite mode' });
      return;
    }

    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({ where: { address } });
    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    // Cascade to children: the MinaGuard hierarchy is capped at two levels, so
    // one layer of child deletion is sufficient (no recursion needed).
    const children = await prisma.contract.findMany({
      where: { parent: contract.address },
      select: { id: true },
    });
    for (const child of children) {
      await deleteContract(child.id);
    }
    await deleteContract(contract.id);
    res.json({ ok: true });
  }));

  router.use((error: unknown, req: any, res: any, _next: any) => {
    const requestId = getRequestId(res);
    console.error(
      `[api:${requestId}] !! ${req.method} ${req.originalUrl}`,
      error instanceof Error ? error.stack ?? error.message : error
    );

    if ((error as { code?: string })?.code === 'P2021') {
      res.status(503).json({
        error: 'Database schema not initialized',
        hint: 'Run `bun run --filter backend prisma:push` or restart backend to auto-sync schema.',
      });
      return;
    }

    const message =
      error instanceof Error ? error.message : 'Unknown backend error';
    res.status(500).json({ error: message });
  });

  return router;
}

/** Emits request start/end logs with request id, status code, and duration. */
function requestLoggerMiddleware() {
  return (req: any, res: any, next: any) => {
    const startedAt = Date.now();
    const requestId = createRequestId();
    res.locals.requestId = requestId;

    console.info(
      `[api:${requestId}] -> ${req.method} ${req.originalUrl}`,
      compactMeta({
        query: req.query,
      })
    );

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      console.info(
        `[api:${requestId}] <- ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
      );
    });

    next();
  };
}

/** Returns request id from response locals or a fallback label. */
function getRequestId(res: any): string {
  return typeof res?.locals?.requestId === 'string' ? res.locals.requestId : 'no-id';
}

/** Generates a short random request id for log correlation. */
function createRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Removes empty metadata fields to keep logs compact and readable. */
function compactMeta(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'object') {
        return Object.keys(value as object).length > 0;
      }
      return true;
    })
  );
}

/** Returns the latest ContractConfig snapshot for a contract, or null. */
async function latestContractConfig(contractId: number) {
  return prisma.contractConfig.findFirst({
    where: { contractId },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }],
  });
}

/** Projects a ContractConfig row (or null) to the slim shape the proposal
 *  invalidation check consumes. */
function toContractState(
  config: Awaited<ReturnType<typeof latestContractConfig>>,
): ContractState | null {
  if (!config) return null;
  return {
    nonce: config.nonce,
    parentNonce: config.parentNonce,
    configNonce: config.configNonce,
  };
}

/** One-shot lookup of a child's current state by address, used by the
 *  single-proposal route. */
async function resolveChildState(address: string): Promise<ContractState | null> {
  const child = await prisma.contract.findUnique({
    where: { address },
    select: { id: true },
  });
  if (!child) return null;
  return toContractState(await latestContractConfig(child.id));
}

/** Batches child-state lookups for a list of proposals. Only REMOTE
 *  non-CREATE_CHILD proposals target a child guard; the rest map to null. */
async function buildChildStateMap(
  proposals: ReadonlyArray<{ destination: string | null; txType: string | null; childAccount: string | null }>,
): Promise<Map<string, ContractState>> {
  const childAddresses = [
    ...new Set(
      proposals
        .filter((p) => p.destination === 'remote' && p.txType !== '5' && p.childAccount)
        .map((p) => p.childAccount as string),
    ),
  ];
  if (childAddresses.length === 0) return new Map();

  const childContracts = await prisma.contract.findMany({
    where: { address: { in: childAddresses } },
    select: { id: true, address: true },
  });
  if (childContracts.length === 0) return new Map();

  const configs = await prisma.contractConfig.findMany({
    where: { contractId: { in: childContracts.map((c) => c.id) } },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }],
  });

  // Pick the first (latest) row per contract — configs is already sorted desc.
  const latestByContractId = new Map<number, typeof configs[number]>();
  for (const row of configs) {
    if (!latestByContractId.has(row.contractId)) latestByContractId.set(row.contractId, row);
  }

  const result = new Map<string, ContractState>();
  for (const child of childContracts) {
    const state = toContractState(latestByContractId.get(child.id) ?? null);
    if (state) result.set(child.address, state);
  }
  return result;
}

/** Returns the count of currently-active owners for a contract. */
async function currentOwnerCount(contractId: number): Promise<number> {
  const owners = await listOwners(contractId, true);
  return owners.length;
}

type ContractRow = { id: number; address: string; parent: string | null };

/** Merges a Contract row with its latest config snapshot and an owners count for the API shape. */
function decorateContract<T extends ContractRow & { _count?: Record<string, number> }>(
  contract: T,
  config: Awaited<ReturnType<typeof latestContractConfig>>,
  ownerCount: number | null,
) {
  const { _count, ...rest } = contract;
  return {
    ...rest,
    threshold: config?.threshold ?? null,
    numOwners: config?.numOwners ?? null,
    nonce: config?.nonce ?? null,
    parentNonce: config?.parentNonce ?? null,
    configNonce: config?.configNonce ?? null,
    delegate: config?.delegate ?? null,
    childMultiSigEnabled: config?.childMultiSigEnabled ?? null,
    ownersCommitment: config?.ownersCommitment ?? null,
    networkId: config?.networkId ?? null,
    ...(_count !== undefined || ownerCount !== null
      ? {
          _count: {
            ...(_count ?? {}),
            ...(ownerCount !== null ? { owners: ownerCount } : {}),
          },
        }
      : {}),
  };
}

/**
 * Returns current owners for a contract by collapsing OwnerMembership history
 * to the latest row per address. If `active` is defined, filters to `added`
 * (true) or `removed` (false); otherwise returns every address ever present.
 */
async function listOwners(contractId: number, active?: boolean) {
  const memberships = await prisma.ownerMembership.findMany({
    where: { contractId },
    orderBy: [{ validFromBlock: 'desc' }, { eventOrder: 'desc' }, { id: 'desc' }],
  });

  const latestByAddress = new Map<string, typeof memberships[number]>();
  for (const m of memberships) {
    if (!latestByAddress.has(m.address)) latestByAddress.set(m.address, m);
  }

  const shaped = [...latestByAddress.values()]
    .map((m) => ({
      contractId: m.contractId,
      address: m.address,
      index: m.index,
      ownerHash: m.ownerHash,
      active: m.action === 'added',
      createdAt: m.createdAt,
    }))
    .sort((a, b) => {
      const ai = a.index ?? Number.MAX_SAFE_INTEGER;
      const bi = b.index ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

  if (active === undefined) return shaped;
  return shaped.filter((o) => o.active === active);
}

/**
 * Maps a status filter to a Prisma `where` fragment where possible. Only
 * `executed` is expressible directly via the `executions` relation; `pending`,
 * `expired`, and `invalidated` require an additional in-memory pass (they
 * depend on `latestHeight` and the latest ContractConfig snapshot).
 */
function buildProposalStatusWhere(status: string | undefined) {
  if (status === 'executed') return { executions: { some: {} } };
  return {};
}

function needsInMemoryStatusFilter(status: string | undefined): boolean {
  return status === 'pending' || status === 'expired' || status === 'invalidated';
}
