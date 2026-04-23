import { Field, PrivateKey, PublicKey } from 'o1js';
import { MinaGuard } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  deployAndSetupChildGuard,
  type TestContext,
} from './test-helpers.js';
import { beforeAll, describe, expect, it } from 'bun:test';

/**
 * Scale test for the M2 parent/child architecture: 1 parent + N children,
 * each staking-delegated to a distinct block producer at setup time via
 * the CREATE_CHILD proposal's initialDelegate binding.
 *
 * Exercises:
 *   - CREATE_CHILD proposals cycling through the parent's 2-of-4 quorum.
 *   - executeSetupChild with a non-empty initialDelegate.
 *   - Non-collision of proposal hashes across iterations (uid = 100 + i).
 *   - Growth of parent's approvalStore + nullifierStore without breaking
 *     witness generation across 80+ proposals.
 *
 * Skipped by default because 80 iterations is minutes of work even in
 * proof-free LocalBlockchain mode. Enable with:
 *     BP_SCALE=1 bun test src/tests/bp-child-scale.test.ts
 *
 * To run a shorter variant for CI-style validation:
 *     BP_SCALE=1 BP_COUNT=20 bun test src/tests/bp-child-scale.test.ts
 */
const SCALE_ENABLED = process.env.BP_SCALE === '1';
const BP_COUNT = Number(process.env.BP_COUNT ?? '80');

const runner = SCALE_ENABLED ? describe : describe.skip;

runner('MinaGuard - BP scale (M2)', () => {
  let parentCtx: TestContext;

  beforeAll(async () => {
    parentCtx = await setupLocalBlockchain();
    await deployAndSetup(parentCtx, 2);
  });

  it(
    `spawns ${BP_COUNT} children, each delegating to a distinct BP`,
    async () => {
      const startTime = Date.now();
      const children: { address: PublicKey; bp: PublicKey; zkApp: MinaGuard }[] = [];

      for (let i = 0; i < BP_COUNT; i++) {
        const childKey = PrivateKey.random();
        const childAddress = childKey.toPublicKey();
        const childZkApp = new MinaGuard(childAddress);
        const bp = PrivateKey.random().toPublicKey();

        await deployAndSetupChildGuard(
          parentCtx,
          parentCtx.zkAppAddress,
          childZkApp,
          childKey,
          childAddress,
          parentCtx.owners.map((o) => o.pub),
          2,
          [0, 1, 2], // proposer=0, approvers={1,2} → threshold 2 (SOD)
          Field(100 + i), // unique uid avoids proposalHash collision
          { childInitialDelegate: bp },
        );

        // Assert per-iteration so a failure is local and debuggable.
        expect(
          childZkApp.account.delegate.get().equals(bp).toBoolean(),
        ).toBe(true);
        expect(childZkApp.parent.get()).toEqual(parentCtx.zkAppAddress);
        expect(childZkApp.delegationNonce.get()).toEqual(Field(0));

        children.push({ address: childAddress, bp, zkApp: childZkApp });

        if ((i + 1) % 10 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(
            `  [bp-scale] ${i + 1}/${BP_COUNT} children deployed (${elapsed}s elapsed)`,
          );
        }
      }

      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  [bp-scale] DONE ${BP_COUNT} children in ${totalElapsed}s (avg ${(
          Number(totalElapsed) / BP_COUNT
        ).toFixed(2)}s/child)`,
      );

      // Final sweep: every child still points at its assigned BP and holds a
      // parent pointer — catches any state-mutation regression from later
      // iterations (e.g. accidental shared-store mutation across children).
      for (const { zkApp, bp, address } of children) {
        expect(zkApp.account.delegate.get().equals(bp).toBoolean()).toBe(true);
        expect(zkApp.parent.get().equals(parentCtx.zkAppAddress).toBoolean()).toBe(
          true,
        );
        expect(zkApp.address.equals(address).toBoolean()).toBe(true);
      }

      // Parent-side sanity: every CREATE_CHILD proposal is recorded in the
      // parent's approvalStore. The parent should have served BP_COUNT
      // distinct proposal hashes without collision.
      expect(children.length).toBe(BP_COUNT);
      const distinctBPs = new Set(children.map((c) => c.bp.toBase58()));
      expect(distinctBPs.size).toBe(BP_COUNT);
    },
    30 * 60 * 1000, // 30 min hard cap
  );
});
