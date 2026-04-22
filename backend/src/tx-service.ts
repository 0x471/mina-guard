import {
  AccountUpdate,
  Cache,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  Signature,
  UInt32,
  UInt64,
  fetchAccount,
} from 'o1js';
import {
  MinaGuard,
  SetupOwnersInput,
  OwnerStore,
  MAX_OWNERS,
  EMPTY_MERKLE_MAP_ROOT,
} from 'contracts';
import type { BackendConfig } from './config.js';

/**
 * Backend-side proving for MinaGuard. Moves the heavy `MinaGuard.compile()`
 * cost out of the browser so the UI can stay a thin signing client. The VK
 * is computed once on first request and cached in memory for the life of the
 * process.
 *
 * For lightnet / dev, fee payment is delegated to a funded account fetched
 * from the lightnet account manager. Devnet/mainnet operator-pays mode and
 * user-pays mode are Phase X follow-ups.
 */

let compileCache: { vk: unknown } | null = null;
let compilePromise: Promise<void> | null = null;

/**
 * Compiles MinaGuard once per process. Subsequent calls return the cached
 * verification key immediately.
 */
async function ensureCompiled(): Promise<void> {
  if (compileCache) return;
  if (!compilePromise) {
    compilePromise = (async () => {
      console.log('[tx-service] compiling MinaGuard (first-time, may take minutes)...');
      const start = Date.now();
      // Heartbeat: logs per-method cache growth so an external watcher can
      // tell if the compile is making progress without having to sample the
      // process. Clears itself when compile resolves/rejects.
      const cacheDir = './cache';
      let lastCount = -1;
      const heartbeat = setInterval(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('node:fs');
          const count = fs.readdirSync(cacheDir).filter((f: string) => f.startsWith('step-pk-minaguard-') && !f.endsWith('.header')).length;
          if (count !== lastCount) {
            console.log(`[tx-service] compile progress: ${count}/14 methods cached (elapsed ${((Date.now() - start) / 1000).toFixed(0)}s)`);
            lastCount = count;
          }
        } catch {
          /* cache dir not created yet */
        }
      }, 10_000);
      try {
        const { verificationKey } = await MinaGuard.compile({
          cache: Cache.FileSystem(cacheDir),
        });
        compileCache = { vk: verificationKey };
        console.log(`[tx-service] MinaGuard compiled in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      } finally {
        clearInterval(heartbeat);
      }
    })();
  }
  await compilePromise;
}

/**
 * Acquires a funded account from the lightnet account manager. Only usable
 * on lightnet; devnet / mainnet need an operator key supplied via env.
 */
async function acquireLightnetFeePayer(config: BackendConfig): Promise<{
  pub: PublicKey;
  key: PrivateKey;
}> {
  if (!config.lightnetAccountManager) {
    throw new Error('LIGHTNET_ACCOUNT_MANAGER not configured — backend proving is lightnet-only right now');
  }
  const resp = await fetch(`${config.lightnetAccountManager}/acquire-account`);
  if (!resp.ok) {
    throw new Error(`Lightnet account manager returned ${resp.status}`);
  }
  const body = (await resp.json()) as { pk: string; sk: string };
  return {
    pub: PublicKey.fromBase58(body.pk),
    key: PrivateKey.fromBase58(body.sk),
  };
}

export interface DeployGuardInput {
  owners: string[];
  threshold: number;
  networkId: string;
  delegationKey?: string | null;
  recipientAllowlistRoot?: string | null;
  enforceRecipientAllowlist?: boolean;
}

export interface DeployGuardOutput {
  zkAppAddress: string;
  zkAppPrivateKey: string;
  txHash: string;
  feePayerAddress: string;
}

/**
 * Generates a fresh zkApp keypair, deploys MinaGuard at that address, and
 * runs `setup` in the same transaction. Returns the new address + its
 * private key (UI is responsible for persisting the private key securely —
 * needed later for `executeSetupChild` if the guard ever spawns children).
 */
export async function deployGuard(
  config: BackendConfig,
  input: DeployGuardInput,
): Promise<DeployGuardOutput> {
  if (input.threshold < 2) {
    throw new Error('Threshold must be >= 2 (separation of duties)');
  }
  if (input.owners.length < input.threshold) {
    throw new Error('Fewer owners than threshold — cannot ever reach quorum');
  }
  if (input.owners.length > MAX_OWNERS) {
    throw new Error(`Maximum ${MAX_OWNERS} owners allowed`);
  }

  await ensureCompiled();

  const feePayer = await acquireLightnetFeePayer(config);
  await fetchAccount({ publicKey: feePayer.pub });

  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();
  const zkApp = new MinaGuard(zkAppAddress);

  const ownerStore = new OwnerStore();
  const ownerKeys = input.owners.map((a) => PublicKey.fromBase58(a));
  for (const owner of ownerKeys) ownerStore.addSorted(owner);

  const paddedOwners = [...ownerStore.owners];
  while (paddedOwners.length < MAX_OWNERS) paddedOwners.push(PublicKey.empty());

  const delegationKey = input.delegationKey
    ? PublicKey.fromBase58(input.delegationKey)
    : PublicKey.empty();
  const allowlistRoot = input.recipientAllowlistRoot
    ? Field(input.recipientAllowlistRoot)
    : EMPTY_MERKLE_MAP_ROOT;
  const enforceAllowlist = input.enforceRecipientAllowlist ? Field(1) : Field(0);

  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      AccountUpdate.fundNewAccount(feePayer.pub);
      await zkApp.deploy();
      await zkApp.setup(
        ownerStore.getCommitment(),
        Field(input.threshold),
        Field(ownerKeys.length),
        Field(input.networkId),
        new SetupOwnersInput({ owners: paddedOwners.slice(0, MAX_OWNERS) }),
        delegationKey,
        allowlistRoot,
        enforceAllowlist,
      );
    },
  );

  console.log('[tx-service] proving deploy+setup...');
  const proveStart = Date.now();
  await tx.prove();
  console.log(`[tx-service] proved in ${((Date.now() - proveStart) / 1000).toFixed(1)}s`);

  const pending = await tx.sign([feePayer.key, zkAppKey]).send();
  if (pending.status !== 'pending') {
    const errors = (pending as { errors?: unknown[] }).errors ?? [];
    throw new Error(`Submission rejected: ${JSON.stringify(errors)}`);
  }

  return {
    zkAppAddress: zkAppAddress.toBase58(),
    zkAppPrivateKey: zkAppKey.toBase58(),
    txHash: pending.hash,
    feePayerAddress: feePayer.pub.toBase58(),
  };
}

export interface DelegateSingleKeyInput {
  guardAddress: string;
  delegate: string | null; // null/empty → undelegate to self
  delegationKeyPub: string;
  expiryBlock: string | null; // UInt32 string, null/0 = no expiry
  signatureBase58: string; // Auro's `signFields` base58 signature over the canonical 7-field message
}

export interface DelegateSingleKeyOutput {
  txHash: string;
  feePayerAddress: string;
}

/**
 * Backend-proving `executeDelegateSingleKey`. UI collects the user's Auro
 * signature over the canonical 7-field message
 *   [...delegate.toFields(), ...guardAddress.toFields(), networkId, nonce, expiryBlock.value]
 * and POSTs it here. Backend reads on-chain state, builds + proves + submits.
 *
 * Signature verification still happens on-chain — the backend cannot forge
 * the user's signature, only relay it.
 */
export async function delegateSingleKey(
  config: BackendConfig,
  input: DelegateSingleKeyInput,
): Promise<DelegateSingleKeyOutput> {
  await ensureCompiled();

  const guardAddress = PublicKey.fromBase58(input.guardAddress);
  const delegationKeyPub = PublicKey.fromBase58(input.delegationKeyPub);
  const delegatePk = input.delegate ? PublicKey.fromBase58(input.delegate) : PublicKey.empty();
  const expiryBlock = UInt32.from(input.expiryBlock ?? '0');
  const signature = Signature.fromBase58(input.signatureBase58);

  const feePayer = await acquireLightnetFeePayer(config);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });

  const zkApp = new MinaGuard(guardAddress);

  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeDelegateSingleKey(
        delegatePk,
        delegationKeyPub,
        expiryBlock,
        signature,
      );
    },
  );

  console.log('[tx-service] proving delegateSingleKey...');
  const start = Date.now();
  await tx.prove();
  console.log(`[tx-service] proved in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') {
    const errors = (pending as { errors?: unknown[] }).errors ?? [];
    throw new Error(`Submission rejected: ${JSON.stringify(errors)}`);
  }

  return {
    txHash: pending.hash,
    feePayerAddress: feePayer.pub.toBase58(),
  };
}
