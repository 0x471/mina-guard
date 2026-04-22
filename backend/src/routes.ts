import { Router } from 'express';
import { z } from 'zod';
import { PublicKey, fetchAccount } from 'o1js';

import { prisma } from './db.js';
import type { MinaGuardIndexer } from './indexer.js';
import type { BackendConfig } from './config.js';
import { serializeProposalRecord } from './proposal-record.js';
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

type OwnersQuery = z.infer<typeof ownersQuerySchema>;
type ProposalsQuery = z.infer<typeof proposalsQuerySchema>;
type EventsQuery = z.infer<typeof eventsQuerySchema>;

/** Creates the read-only API router bound to shared indexer status and Prisma data. */
export function createApiRouter(indexer: MinaGuardIndexer, config?: BackendConfig): Router {
  const router = Router();
  const safe = wrapAsyncRoute();
  router.use(requestLoggerMiddleware());

  /** Returns basic health and process liveness metadata. */
  router.get('/health', safe(async (_req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  }));

  /** Returns current polling indexer status and latest sync metadata. */
  router.get('/api/indexer/status', safe(async (_req, res) => {
    res.json(indexer.getStatus());
  }));

  /** Lists tracked contracts with owner/proposal aggregate counts. */
  router.get('/api/contracts', safe(async (_req, res) => {
    const contracts = await prisma.contract.findMany({
      orderBy: { discoveredAt: 'desc' },
      include: {
        _count: {
          select: {
            owners: true,
            proposals: true,
            events: true,
          },
        },
      },
    });

    res.json(contracts);
  }));

  /** Returns one tracked contract by base58 address. */
  router.get('/api/contracts/:address', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const contract = await prisma.contract.findUnique({
      where: { address },
      include: {
        _count: {
          select: {
            owners: true,
            proposals: true,
            events: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    res.json(contract);
  }));

  /** Lists child contracts (subaccounts) whose `parent` points at the given address. */
  router.get('/api/contracts/:address/children', addressParamsMiddleware, safe(async (req, res) => {
    const { address } = addressParamsSchema.parse(req.params) as AddressParams;

    const children = await prisma.contract.findMany({
      where: { parent: address },
      orderBy: { discoveredAt: 'asc' },
    });

    res.json(children);
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
      delegationKey?: unknown;
      recipientAllowlistRoot?: unknown;
      enforceRecipientAllowlist?: unknown;
    };
    const owners = Array.isArray(body.owners)
      ? body.owners.filter((v): v is string => typeof v === 'string')
      : [];
    const threshold = Number(body.threshold);
    const networkId = typeof body.networkId === 'string' ? body.networkId : '';
    const delegationKey = typeof body.delegationKey === 'string' ? body.delegationKey : null;
    const recipientAllowlistRoot =
      typeof body.recipientAllowlistRoot === 'string' ? body.recipientAllowlistRoot : null;
    const enforceRecipientAllowlist = body.enforceRecipientAllowlist === true;
    if (!owners.length || !Number.isFinite(threshold) || !networkId) {
      res.status(400).json({ error: 'owners[], threshold, networkId required' });
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
    const body = (req.body ?? {}) as { proposal?: unknown; proposer?: unknown; signatureBase58?: unknown };
    if (!body.proposal || typeof body.proposer !== 'string' || typeof body.signatureBase58 !== 'string') {
      res.status(400).json({ error: 'proposal, proposer, signatureBase58 required' });
      return;
    }
    const { proposeBackend } = await import('./tx-service.js');
    try {
      const result = await proposeBackend(config, {
        proposal: body.proposal as never,
        proposer: body.proposer,
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
    };
    if (!body.proposal || typeof body.proposal.txType !== 'string') {
      res.status(400).json({ error: 'proposal required' });
      return;
    }
    const txType = body.proposal.txType;
    const destination = body.proposal.destination;
    const childAddress = typeof body.childAddress === 'string' && body.childAddress
      ? body.childAddress
      : (typeof body.proposal.childAccount === 'string' ? body.proposal.childAccount : '');
    const svc = await import('./tx-service.js');
    try {
      let result: { txHash: string };
      if (destination === '1' || destination === 'remote') {
        if (!childAddress) { res.status(400).json({ error: 'childAddress required for REMOTE' }); return; }
        if (txType === '7') {
          result = await svc.executeReclaimToParentBackend(config, { proposal: body.proposal as never, childAddress });
        } else if (txType === '8') {
          result = await svc.executeDestroyBackend(config, { proposal: body.proposal as never, childAddress });
        } else if (txType === '9') {
          result = await svc.executeEnableChildMultiSigBackend(config, {
            proposal: body.proposal as never,
            childAddress,
            enabled: body.enabled !== false,
          });
        } else {
          res.status(400).json({ error: `REMOTE txType ${txType} not executable via backend (use wizard for CREATE_CHILD)` });
          return;
        }
      } else {
        // LOCAL
        if (txType === '0') {
          result = await svc.executeTransferBackend(config, { proposal: body.proposal as never });
        } else if (txType === '1' || txType === '2') {
          result = await svc.executeOwnerChangeBackend(config, { proposal: body.proposal as never });
        } else if (txType === '3') {
          result = await svc.executeThresholdChangeBackend(config, { proposal: body.proposal as never });
        } else if (txType === '4') {
          result = await svc.executeDelegateBackend(config, { proposal: body.proposal as never });
        } else if (txType === '6') {
          result = await svc.executeAllocateToChildrenBackend(config, { proposal: body.proposal as never });
        } else if (txType === '10' || txType === '11') {
          result = await svc.executeUpdateRecipientAllowlistBackend(config, { proposal: body.proposal as never });
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
    const body = (req.body ?? {}) as { proposal?: unknown };
    if (!body.proposal) { res.status(400).json({ error: 'proposal required' }); return; }
    const { executeTransferBackend } = await import('./tx-service.js');
    try {
      const result = await executeTransferBackend(config, { proposal: body.proposal as never });
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
    };
    const guardAddress = typeof body.guardAddress === 'string' ? body.guardAddress : '';
    const delegationKeyPub = typeof body.delegationKeyPub === 'string' ? body.delegationKeyPub : '';
    const signatureBase58 = typeof body.signatureBase58 === 'string' ? body.signatureBase58 : '';
    const delegate = typeof body.delegate === 'string' && body.delegate ? body.delegate : null;
    const expiryBlock = typeof body.expiryBlock === 'string' ? body.expiryBlock : null;
    if (!guardAddress || !delegationKeyPub || !signatureBase58) {
      res.status(400).json({ error: 'guardAddress, delegationKeyPub, signatureBase58 required' });
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
        select: { id: true },
      });

      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const owners = await prisma.owner.findMany({
        where: {
          contractId: contract.id,
          ...(active === undefined ? {} : { active }),
        },
        orderBy: [{ index: 'asc' }, { createdAt: 'asc' }],
      });

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
        select: { id: true },
      });

      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      const proposals = await prisma.proposal.findMany({
        where: {
          contractId: contract.id,
          ...(status ? { status } : {}),
        },
        include: {
          receivers: {
            orderBy: { idx: 'asc' },
          },
        },
        orderBy: [{ createdAtBlock: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      });

      res.json(proposals.map((proposal) => serializeProposalRecord(proposal)));
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
        select: { id: true },
      });

      if (!contract) {
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
          receivers: {
            orderBy: { idx: 'asc' },
          },
        },
      });

      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      res.json(serializeProposalRecord(proposal));
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
        select: { id: true },
      });

      if (!contract) {
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
        select: { id: true },
      });

      if (!contract) {
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
