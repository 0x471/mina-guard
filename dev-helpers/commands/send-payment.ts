import {
  AccountUpdate,
  Mina,
  PrivateKey,
  PublicKey,
  UInt64,
  fetchAccount,
} from 'o1js';

const ACCOUNT_MANAGER =
  process.env.LIGHTNET_ACCOUNT_MANAGER ?? 'http://127.0.0.1:8181';
const MINA_ENDPOINT =
  process.env.MINA_ENDPOINT ?? 'http://127.0.0.1:8080/graphql';

interface Args {
  to: string;
  amount: string; // MINA decimal, e.g. "10" for 10 MINA
  memo?: string;
}

/**
 * Sends a test payment from a freshly-acquired lightnet account to an
 * arbitrary recipient. Primarily for exercising the IncomingPoller end-to-end
 * — pays a guard address, then watches `/api/contracts/ADDR/incoming`.
 *
 * Does NOT require MinaGuard.compile — a plain signed payment has no zkApp
 * method, so tx.prove() is essentially a no-op and the whole flow runs in
 * seconds.
 */
export async function runSendPayment(args: Args): Promise<void> {
  const to = args.to.trim();
  if (!to.startsWith('B62') || to.length < 50) {
    throw new Error(`Invalid recipient address: ${to}`);
  }

  const amountMina = Number(args.amount);
  if (!Number.isFinite(amountMina) || amountMina <= 0) {
    throw new Error(`Invalid amount (MINA): ${args.amount}`);
  }
  const amountNanomina = BigInt(Math.floor(amountMina * 1e9));

  Mina.setActiveInstance(Mina.Network(MINA_ENDPOINT));

  console.log(`Acquiring funded account from ${ACCOUNT_MANAGER}...`);
  const acquireResp = await fetch(`${ACCOUNT_MANAGER}/acquire-account`);
  if (!acquireResp.ok) {
    throw new Error(`Account manager returned ${acquireResp.status}`);
  }
  const { pk, sk } = (await acquireResp.json()) as { pk: string; sk: string };
  console.log(`  Funder: ${pk}`);

  const funderKey = PrivateKey.fromBase58(sk);
  const funderPub = PublicKey.fromBase58(pk);
  const recipientPub = PublicKey.fromBase58(to);

  await fetchAccount({ publicKey: funderPub });
  const recipientAccount = await fetchAccount({ publicKey: recipientPub });
  const recipientExists = recipientAccount.account !== undefined;

  console.log(
    `Building payment: ${amountMina} MINA → ${to}${
      recipientExists ? '' : ' (new account: +1 MINA creation fee)'
    }`,
  );

  const FEE = UInt64.from(100_000_000);
  const tx = await Mina.transaction(
    {
      sender: funderPub,
      fee: FEE,
      memo: args.memo ?? '',
    },
    async () => {
      if (!recipientExists) AccountUpdate.fundNewAccount(funderPub);
      const update = AccountUpdate.createSigned(funderPub);
      update.send({ to: recipientPub, amount: UInt64.from(amountNanomina) });
    },
  );

  await tx.prove();
  tx.sign([funderKey]);
  const result = await tx.send();
  console.log(`Submitted. Tx hash: ${result.hash}`);
  console.log('Waiting for block inclusion...');
  await result.wait();
  console.log('Confirmed on-chain.');
}
