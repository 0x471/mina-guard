import { Field, Mina, PrivateKey, PublicKey } from 'o1js';
import { MinaGuard } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  deployAndSetupChildGuard,
  signSingleKeyDelegate,
  type TestContext,
} from './test-helpers.js';
import { beforeAll, describe, expect, it } from 'bun:test';

/**
 * Scale test for the M2 parent/child architecture. Three phases:
 *
 *   Phase 1 — CREATE: spawn N children, each with a distinct initial BP
 *             bound into the CREATE_CHILD proposal data. Exercises the
 *             parent's 2-of-4 quorum and executeSetupChild with a non-empty
 *             initialDelegate over N iterations.
 *
 *   Phase 2 — ROTATE: half of the children rotate their BP via single-key
 *             delegation. Validates that executeDelegateSingleKey scales
 *             independently of parent-side state growth, and that the
 *             per-child delegationNonce stays correctly isolated.
 *
 *   Phase 3 — SWEEP: final invariant check — every child's on-chain
 *             account.delegate matches its expected BP (post-rotation for
 *             the first half, original for the rest), every child still
 *             points at the parent, and the parent's approvalStore served
 *             N distinct CREATE_CHILD proposal hashes without collision.
 *
 * Prints per-phase timing so regressions in any one phase are obvious. The
 * rotation phase uses one shared delegationKey for all children (simpler
 * and matches the M2 operator model where one offline rotation key signs
 * for the whole BP fleet).
 *
 * Skipped by default — 80 iterations is minutes of work even in proof-free
 * LocalBlockchain mode. Enable with:
 *     BP_SCALE=1 bun test src/tests/bp-child-scale.test.ts
 *
 * For a quicker CI-style validation:
 *     BP_SCALE=1 BP_COUNT=20 bun test src/tests/bp-child-scale.test.ts
 */
const SCALE_ENABLED = process.env.BP_SCALE === '1';
const BP_COUNT = Number(process.env.BP_COUNT ?? '80');

const runner = SCALE_ENABLED ? describe : describe.skip;

runner('MinaGuard - BP scale (M2)', () => {
  let parentCtx: TestContext;
  const childDelegationKey = PrivateKey.random();
  const childDelegationPub = childDelegationKey.toPublicKey();

  beforeAll(async () => {
    parentCtx = await setupLocalBlockchain();
    await deployAndSetup(parentCtx, 2);
  });

  it(
    `spawns ${BP_COUNT} children + rotates half via single-key`,
    async () => {
      const totalStart = Date.now();
      const children: {
        address: PublicKey;
        bp: PublicKey;
        zkApp: MinaGuard;
      }[] = [];

      // ---- Phase 1: CREATE 80 children, each with unique initialDelegate ----
      const phase1Start = Date.now();
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
          [0, 1, 2],
          Field(100 + i),
          {
            childInitialDelegate: bp,
            childDelegationKey: childDelegationPub,
          },
        );

        expect(
          childZkApp.account.delegate.get().equals(bp).toBoolean(),
        ).toBe(true);
        expect(childZkApp.parent.get()).toEqual(parentCtx.zkAppAddress);
        expect(childZkApp.delegationNonce.get()).toEqual(Field(0));

        children.push({ address: childAddress, bp, zkApp: childZkApp });

        if ((i + 1) % 10 === 0) {
          const elapsed = ((Date.now() - phase1Start) / 1000).toFixed(1);
          console.log(
            `  [bp-scale] Phase 1: ${i + 1}/${BP_COUNT} created (${elapsed}s)`,
          );
        }
      }
      const phase1Sec = (Date.now() - phase1Start) / 1000;

      // ---- Phase 2: ROTATE first half via single-key delegation ----
      const phase2Start = Date.now();
      const rotationCount = Math.floor(BP_COUNT / 2);
      for (let i = 0; i < rotationCount; i++) {
        const child = children[i];
        const newBp = PrivateKey.random().toPublicKey();
        const { signature, expiryBlock } = signSingleKeyDelegate({
          delegationKey: childDelegationKey,
          delegate: newBp,
          guardAddress: child.address,
          networkId: parentCtx.networkId,
          nonce: Field(0),
        });
        const tx = await Mina.transaction(parentCtx.deployerAccount, async () => {
          await child.zkApp.executeDelegateSingleKey(
            newBp,
            childDelegationPub,
            expiryBlock,
            signature,
          );
        });
        await tx.prove();
        await tx.sign([parentCtx.deployerKey]).send();

        child.bp = newBp;
        expect(child.zkApp.account.delegate.get().equals(newBp).toBoolean()).toBe(
          true,
        );
        // Nonce must have bumped exactly once per rotation — protects against
        // replay and against cross-child nonce contamination.
        expect(child.zkApp.delegationNonce.get()).toEqual(Field(1));

        if ((i + 1) % 10 === 0) {
          const elapsed = ((Date.now() - phase2Start) / 1000).toFixed(1);
          console.log(
            `  [bp-scale] Phase 2: ${i + 1}/${rotationCount} rotated (${elapsed}s)`,
          );
        }
      }
      const phase2Sec = (Date.now() - phase2Start) / 1000;

      // ---- Phase 3: SWEEP invariants across all 80 children ----
      const phase3Start = Date.now();
      for (let i = 0; i < children.length; i++) {
        const { zkApp, bp, address } = children[i];
        expect(zkApp.account.delegate.get().equals(bp).toBoolean()).toBe(true);
        expect(zkApp.parent.get().equals(parentCtx.zkAppAddress).toBoolean()).toBe(
          true,
        );
        expect(zkApp.address.equals(address).toBoolean()).toBe(true);
        // First `rotationCount` children should be at nonce=1, the rest at 0.
        const expectedNonce = i < rotationCount ? Field(1) : Field(0);
        expect(zkApp.delegationNonce.get()).toEqual(expectedNonce);
      }
      expect(children.length).toBe(BP_COUNT);
      const distinctBPs = new Set(children.map((c) => c.bp.toBase58()));
      expect(distinctBPs.size).toBe(BP_COUNT);
      const phase3Sec = (Date.now() - phase3Start) / 1000;

      const totalSec = (Date.now() - totalStart) / 1000;

      console.log(`\n  [bp-scale] SUMMARY`);
      console.log(
        `  Phase 1 (create):  ${phase1Sec.toFixed(1).padStart(7)}s  ` +
          `${BP_COUNT} children  (${(phase1Sec / BP_COUNT).toFixed(2)}s/child)`,
      );
      console.log(
        `  Phase 2 (rotate):  ${phase2Sec.toFixed(1).padStart(7)}s  ` +
          `${rotationCount} rotations (${(phase2Sec / rotationCount).toFixed(2)}s/rotate)`,
      );
      console.log(
        `  Phase 3 (sweep):   ${phase3Sec.toFixed(1).padStart(7)}s  ` +
          `${BP_COUNT} children`,
      );
      console.log(`  Total:             ${totalSec.toFixed(1).padStart(7)}s\n`);
    },
    45 * 60 * 1000,
  );
});
