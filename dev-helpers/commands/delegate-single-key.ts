import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
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
import { MinaGuard } from 'contracts';
import { resolveMinaEndpoint } from '../lib/network.ts';

/**
 * Calls executeDelegateSingleKey on an already-deployed MinaGuard.
 * Reads the guard's on-chain networkId + delegationNonce, signs the canonical
 * 5-term message with the delegation private key, and submits.
 * Config via env vars — see dev-helpers/README.md.
 */
export async function runDelegateSingleKey(): Promise<void> {
  const config = loadConfig();
  printConfig(config);

  const endpoint = resolveMinaEndpoint();
  console.log(`\nConnecting to ${endpoint}`);
  Mina.setActiveInstance(Mina.Network({ mina: endpoint }));

  console.log('Compiling MinaGuard...');
  await MinaGuard.compile({ cache: Cache.FileSystem('./cache') });

  const zkApp = new MinaGuard(config.guardAddress);

  console.log('Fetching guard state...');
  const fetched = await fetchAccount({ publicKey: config.guardAddress });
  if (fetched.error || !fetched.account) {
    throw new Error(`Guard ${config.guardAddress.toBase58()} not found on chain`);
  }

  const onchainNetworkId = zkApp.networkId.get();
  const nonce = zkApp.delegationNonce.get();
  const keyHash = zkApp.delegationKeyHash.get();
  if (keyHash.equals(Field(0)).toBoolean()) {
    throw new Error(
      'Guard has delegationKeyHash=0 — single-key delegation is DISABLED on this contract',
    );
  }
  console.log(`on-chain networkId:    ${onchainNetworkId.toString()}`);
  console.log(`on-chain nonce:        ${nonce.toString()}`);

  const feePayerAddress = config.feePayerKey.toPublicKey();
  await fetchAccount({ publicKey: feePayerAddress });

  const msg = [
    ...config.newDelegate.toFields(),
    ...config.guardAddress.toFields(),
    onchainNetworkId,
    nonce,
    config.expiryBlock.value,
  ];
  const signature = Signature.create(config.delegationKey, msg);

  console.log(`\nBuilding tx (fee=${config.feeNanomina} nanomina)...`);

  try {
    const txn = await Mina.transaction(
      { sender: feePayerAddress, fee: UInt64.from(config.feeNanomina) },
      async () => {
        await zkApp.executeDelegateSingleKey(
          config.newDelegate,
          config.delegationKey.toPublicKey(),
          config.expiryBlock,
          signature,
        );
      },
    );

    console.log('Proving...');
    await txn.prove();

    console.log('Signing + submitting...');
    const pendingTx = await txn.sign([config.feePayerKey]).send();

    if (pendingTx.status !== 'pending') {
      const errors = (pendingTx as { errors?: unknown[] }).errors ?? [];
      throw new Error(`Submission rejected: ${JSON.stringify(errors)}`);
    }

    console.log(`\n✓ Submitted. Tx hash: ${pendingTx.hash}`);
    console.log(`  Guard:     ${config.guardAddress.toBase58()}`);
    console.log(`  Delegate → ${config.newDelegate.equals(PublicKey.empty()).toBoolean() ? '(self — undelegate)' : config.newDelegate.toBase58()}`);
  } catch (err) {
    console.error(`\n❌ Delegate call failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

interface DelegateConfig {
  guardAddress: PublicKey;
  delegationKey: PrivateKey;
  newDelegate: PublicKey;
  feePayerKey: PrivateKey;
  expiryBlock: UInt32;
  feeNanomina: bigint;
}

function loadConfig(): DelegateConfig {
  loadDotEnv();

  const guardAddress = PublicKey.fromBase58(requireEnv('DELEGATE_GUARD_ADDRESS'));
  const delegationKey = PrivateKey.fromBase58(requireEnv('DELEGATE_DELEGATION_PRIVATE_KEY'));
  const feePayerKey = PrivateKey.fromBase58(requireEnv('DELEGATE_FEE_PAYER_PRIVATE_KEY'));

  const newDelegateStr = process.env.DELEGATE_NEW_DELEGATE?.trim() ?? '';
  const newDelegate =
    newDelegateStr === '' || newDelegateStr === 'self' || newDelegateStr === 'empty'
      ? PublicKey.empty()
      : PublicKey.fromBase58(newDelegateStr);

  const expiryBlock = UInt32.from(process.env.DELEGATE_EXPIRY_BLOCK ?? '0');

  return {
    guardAddress,
    delegationKey,
    newDelegate,
    feePayerKey,
    expiryBlock,
    feeNanomina: BigInt(process.env.DELEGATE_FEE ?? '100000000'),
  };
}

function loadDotEnv(): void {
  const envPath = resolve(import.meta.dirname, '../.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    if (key && !(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function printConfig(c: DelegateConfig): void {
  const newDelegateDisplay = c.newDelegate.equals(PublicKey.empty()).toBoolean()
    ? '(empty — undelegate to self)'
    : c.newDelegate.toBase58();
  console.log('=== MinaGuard delegate-single-key ===');
  console.log(`Guard address: ${c.guardAddress.toBase58()}`);
  console.log(`New delegate:  ${newDelegateDisplay}`);
  console.log(`Expiry block:  ${c.expiryBlock.toString()} (0 = no expiry)`);
  console.log(`Fee:           ${c.feeNanomina} nanomina`);
}
