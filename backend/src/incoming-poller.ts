import { prisma } from './db.js';
import type { BackendConfig } from './config.js';
import { decodeMinaMemo } from './memo-decode.js';

/**
 * Polls the Mina daemon for incoming MINA transfers targeting any tracked
 * MinaGuard contract. Populates the `IncomingTransfer` table so the UI's
 * Activity tab can surface inbound payments alongside outgoing proposals.
 *
 * Only regular userCommands (direct payments) are captured — zkApp-initiated
 * inter-account transfers are out of scope for M0 (low volume; users can
 * navigate into the originating proposal from the outgoing side).
 *
 * Idempotent via `IncomingTransfer.@@unique([contractId, txHash])`, so
 * re-polling the same block range is safe.
 */
export class IncomingPoller {
  private readonly config: BackendConfig;
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(config: BackendConfig) {
    this.config = config;
  }

  /** Starts periodic polling. First tick runs immediately. */
  async start(): Promise<void> {
    if (this.intervalHandle) return;
    await this.tick();
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.config.indexPollIntervalMs);
  }

  /** Stops the polling loop. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** One poll cycle: fetch recent blocks, extract payments, upsert rows. */
  async tick(): Promise<void> {
    try {
      const tracked = await prisma.contract.findMany({
        select: { id: true, address: true },
      });
      if (tracked.length === 0) return;

      const addressToId = new Map(tracked.map((c) => [c.address, c.id]));
      const cursor = await this.getCursor();

      // Fetch the last 50 best-chain blocks — enough buffer for a 15s
      // poll against a 30s-block lightnet. Devnet/mainnet should route
      // this through an archive node instead (follow-up).
      const blocks = await this.fetchRecentBlocks(50);
      if (blocks.length === 0) return;

      let newCursor = cursor;
      for (const block of blocks) {
        const height = Number(block.protocolState.consensusState.blockHeight);
        if (height <= cursor) continue;

        for (const uc of block.transactions.userCommands ?? []) {
          const recipient = uc.receiver?.publicKey;
          if (!recipient) continue;
          const contractId = addressToId.get(recipient);
          if (contractId === undefined) continue;
          if (uc.kind && uc.kind !== 'PAYMENT') continue;

          await prisma.incomingTransfer.upsert({
            where: { contractId_txHash: { contractId, txHash: uc.hash } },
            create: {
              contractId,
              fromAddress: uc.source?.publicKey ?? 'unknown',
              amount: uc.amount,
              memo: decodeMinaMemo(uc.memo) ?? uc.memo ?? null,
              blockHeight: height,
              txHash: uc.hash,
            },
            update: {},
          });
        }

        // zkappCommands also encode payments in modern o1js: e.g.
        // AccountUpdate.createSigned(sender).send({ to, amount }) lands as a
        // zkappCommand whose accountUpdates include a positive balanceChange
        // on `to`. We sum all positive balanceChanges per tracked address.
        for (const zk of block.transactions.zkappCommands ?? []) {
          if (zk.failureReason?.failures?.length) continue;
          const aus = zk.zkappCommand?.accountUpdates ?? [];
          const perContract = new Map<number, bigint>();
          for (const au of aus) {
            const pk = au.body?.publicKey;
            if (!pk) continue;
            const contractId = addressToId.get(pk);
            if (contractId === undefined) continue;
            const bc = au.body?.balanceChange;
            if (!bc) continue;
            const magnitude = BigInt(bc.magnitude ?? '0');
            if (magnitude === 0n) continue;
            const positive = (bc.sgn ?? 'Positive') === 'Positive';
            if (!positive) continue;
            perContract.set(
              contractId,
              (perContract.get(contractId) ?? 0n) + magnitude,
            );
          }
          if (perContract.size === 0) continue;
          const fromAddress =
            zk.zkappCommand?.feePayer?.body?.publicKey ?? 'unknown';
          for (const [contractId, total] of perContract) {
            await prisma.incomingTransfer.upsert({
              where: { contractId_txHash: { contractId, txHash: zk.hash } },
              create: {
                contractId,
                fromAddress,
                amount: total.toString(),
                memo:
                  decodeMinaMemo(zk.zkappCommand?.memo) ??
                  zk.zkappCommand?.memo ??
                  null,
                blockHeight: height,
                txHash: zk.hash,
              },
              update: {},
            });
          }
        }

        if (height > newCursor) newCursor = height;
      }

      if (newCursor > cursor) {
        await this.setCursor(newCursor);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.error('[incoming-poller] tick failed:', this.lastError);
    }
  }

  /** Last error surfaced by the most recent tick, if any. */
  getLastError(): string | null {
    return this.lastError;
  }

  private async getCursor(): Promise<number> {
    const row = await prisma.indexerCursor.findUnique({
      where: { key: 'incoming_height' },
    });
    return row ? Number(row.value) : this.config.indexStartHeight;
  }

  private async setCursor(height: number): Promise<void> {
    await prisma.indexerCursor.upsert({
      where: { key: 'incoming_height' },
      create: { key: 'incoming_height', value: String(height) },
      update: { value: String(height) },
    });
  }

  private async fetchRecentBlocks(n: number): Promise<BestChainBlock[]> {
    const query = `{
      bestChain(maxLength: ${n}) {
        protocolState { consensusState { blockHeight } }
        transactions {
          userCommands {
            hash
            kind
            amount
            memo
            source { publicKey }
            receiver { publicKey }
          }
          zkappCommands {
            hash
            failureReason { failures }
            zkappCommand {
              memo
              feePayer { body { publicKey } }
              accountUpdates {
                body {
                  publicKey
                  balanceChange { magnitude sgn }
                }
              }
            }
          }
        }
      }
    }`;
    const res = await fetch(this.config.minaEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(`Mina GraphQL returned ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: { bestChain?: BestChainBlock[] };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) {
      throw new Error(body.errors.map((e) => e.message ?? 'GraphQL error').join('; '));
    }
    return body.data?.bestChain ?? [];
  }
}

interface BestChainBlock {
  protocolState: { consensusState: { blockHeight: string } };
  transactions: {
    userCommands?: UserCommand[];
    zkappCommands?: ZkappCommand[];
  };
}

interface UserCommand {
  hash: string;
  kind?: string;
  amount: string;
  memo?: string | null;
  source?: { publicKey?: string };
  receiver?: { publicKey?: string };
}

interface ZkappCommand {
  hash: string;
  failureReason?: { failures?: unknown[] } | null;
  zkappCommand?: {
    memo?: string | null;
    feePayer?: { body?: { publicKey?: string } };
    accountUpdates?: Array<{
      body?: {
        publicKey?: string;
        balanceChange?: { magnitude?: string; sgn?: string };
      };
    }>;
  };
}
