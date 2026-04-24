# MinaGuard M0 — Demo Walkthrough

Step-by-step walkthrough of every M0 self-custody capability on a fresh
lightnet. Each section starts at a clean state so sections can be run in
isolation.

**Prerequisites**
- lightnet up (`./dev-helpers/lightnet-up.sh`)
- backend running (`bun run --filter backend dev`)
- UI running (`cd ui && bun run dev`)
- `NEXT_PUBLIC_AUTH_DISABLED=true` in `ui/.env.local` (skip Google OAuth for
  local demo) and `AUTH_DISABLED=true` in `backend/.env`
- Auro wallet installed, connected to lightnet (`http://127.0.0.1:18080/graphql`)

---

## 1. Deploy a parent guard

1. Open `http://localhost:3000` → "Create Account".
2. Wizard step 1: name + network (testnet auto-selected for lightnet).
3. Wizard step 2:
   - **Owners**: paste 4 distinct B62 addresses (get them from
     `curl http://127.0.0.1:18181/acquire-account`, 4 times).
   - **Threshold**: `2` (SOD floor).
   - **Delegation key**: optional — paste a public key if you want
     single-key rotation. Leave blank to disable.
   - **Enforce recipient allowlist**: `off` for the demo.
4. Submit. Backend compiles (~65s first request, then cached). Tx is
   proved + submitted + landed within ~30s.
5. Indexer discovers the new guard; it appears on the home page tree.
6. Click it → lands on `/accounts/<addr>`. Note the three-tab strip:
   **Account · Activity · Delegation**.

**Verification**
```bash
curl -s http://localhost:3001/api/contracts | python3 -m json.tool | head -15
```

---

## 2. Fund the guard (exercises the IncomingPoller)

```bash
cd dev-helpers
MINA_ENDPOINT=http://127.0.0.1:18080/graphql \
LIGHTNET_ACCOUNT_MANAGER=http://127.0.0.1:18181 \
bun run cli.ts send-payment --to <guard-addr> --amount 50 --memo "initial-fund"
```

Wait ~30s → open the **Activity** tab → filter **Inbound**.

The row shows:
- amount `50 MINA`
- from `B62q…` (the lightnet funder)
- memo `initial-fund` (decoded from Mina's base58 payload)
- block height

---

## 3. Add address book aliases

On `/accounts/<addr>`, find the **Address Book** card.
Add two rows (matches the mockup's Kraken/Coinbase dropdown):

| Alias | Address |
|---|---|
| Kraken | `B62q…` (any fresh B62 address) |
| Coinbase | `B62q…` (another fresh B62 address) |

Stored in the backend's `RecipientAlias` table, per-contract.

---

## 4. Propose a transfer (exercises memo + alias + auto-expiry)

1. Click **➕ Create Transfer Request** (or go to `/transactions/new`).
2. Under **Recipients**, aliases appear as **chips**. Click `Kraken` →
   its address is inserted into the textarea; append `,1.5` for the
   amount.
3. **Memo**: type `bi-weekly rebalance`. Watch the live counter —
   `18/32 bytes`, stays green.
4. **Expiry**: pre-filled as `<currentBlock> + 20,000` with a live
   `expires in 20,000 blocks (≈6.9 days)` readout.
5. Submit → Auro prompts for a single-Field proposalHash signature →
   backend proves and submits.
6. Navigate to the proposal detail page. Details include:
   - `Memo: bi-weekly rebalance`
   - `Expiry Block: block 100,234 · expires in 20,000 blocks (≈6.9 days)`
   - `Config Nonce`, `Created`, receivers, totals

**Verification**
```bash
curl -s http://localhost:3001/api/contracts/<addr>/proposals | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['memo'])"
# -> "bi-weekly rebalance"
```

---

## 5. Second approval triggers auto-execute

1. Open a new browser profile / incognito → switch Auro to a second
   owner account → open the same proposal detail page.
2. Click **Approve** → backend submits the approval tx.
3. Wait ~15s for the indexer to tick.
4. **Auto-execute banner** appears: *"Auto-executing proposal…"*.
5. Banner clears on success; the proposal status flips `pending → executed`.
6. Activity tab shows the proposal with green *executed* status.
7. On the exchange side (in this demo: Kraken's mock address),
   balance increased by 1.5 MINA and the tx memo is the operator's
   `bi-weekly rebalance`.

**Verification — memo survived into the execute tx**
```bash
# Look up the executeTransfer tx (hash is in backend logs for POST /api/tx/execute)
curl -s http://127.0.0.1:18080/graphql -X POST \
  -H "content-type: application/json" \
  -d '{"query":"{ bestChain(maxLength: 20) { transactions { zkappCommands { hash zkappCommand { memo } } } } }"}'
# Find the tx and decode memo with backend/src/memo-decode.ts
```

---

## 6. Rotate delegation via single-key (if configured at setup)

Requires a guard with a non-empty `delegationKey`.

1. Navigate to `/delegation/<addr>`.
2. Find the guard's row. If the connected Auro wallet is the delegation
   key, **Change delegation** is enabled.
3. Click it → enter a BP address (any B62) → submit.
4. Auro signs a single canonical 7-field message. Backend proves
   `executeDelegateSingleKey` and submits.
5. Row refreshes: `Current delegate: B62q…` (new), `Rotations so far: 1`.
6. Verify on-chain:
   ```bash
   curl -s http://127.0.0.1:18080/graphql -X POST \
     -H "content-type: application/json" \
     -d "{\"query\":\"{ account(publicKey:\\\"<addr>\\\") { delegateAccount { publicKey } } }\"}"
   ```

---

## 7. Create a BP child (M2 architecture preview)

1. On `/delegation/<parent-addr>`, click **➕ Create Block Producer Child**.
2. Enter the BP address (e.g. `B62qmiVWy5X…` — from
   `acquire-account`). Click **Continue to deploy wizard**.
3. Wizard opens at `/accounts/new?parent=<parent>&initialDelegate=<bp>`;
   `initialDelegate` is pre-filled. Fill in owners + threshold (inherit
   from parent).
4. Submit. First: parent's quorum approves the CREATE_CHILD proposal
   (two signatures + execute). Then: the child's deploy + setup +
   delegate land in a single atomic tx — the child's
   `account.delegate` is set to the BP at setup time.
5. Back on `/delegation/<parent>`, the child appears as a row under the
   parent, with `Current delegate: <BP>` and `Rotations so far: 0`.

Scale-validated for 80 children via:
```bash
cd contracts
BP_SCALE=1 bun test src/tests/bp-child-scale.test.ts
# Phase 1 (create):  269s  80 children  (3.37s/child)
# Phase 2 (rotate):    5s  40 rotations (0.13s/rotate)
```

---

## 8. Auto-expiry of a stuck proposal

1. On a fresh proposal, set `Expiry Block: <currentBlock> + 5`.
2. Submit with 0 approvals. Wait for lightnet to advance 5+ blocks.
3. On Activity tab, the proposal now shows a red **Expired** badge.
4. Attempting to approve or execute it reverts on-chain — contract
   enforces `assertProposalNotExpired`.

---

## 9. OAuth gate (optional, needs Google creds)

Flip off the local bypass:
```bash
sed -i '' 's/^NEXT_PUBLIC_AUTH_DISABLED=true/NEXT_PUBLIC_AUTH_DISABLED=false/' ui/.env.local
# Also unset AUTH_DISABLED on backend side.
```

Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`NEXTAUTH_URL` / `NEXTAUTH_SECRET` / `AUTH_JWT_SECRET` /
`AUTH_ALLOWED_DOMAINS` (see `ui/.env.local.example`).

Restart UI + backend. Navigating to any `/accounts/...` route now
redirects to `/auth/signin`. Sign in with a non-`o1labs.org` email →
`/auth/error?error=AccessDenied`. Sign in with an allowed email →
land on the requested page; header shows `user@o1labs.org · Sign out`.

---

## End-to-end verification

After steps 1–6 the state should match:

| Check | Expected |
|---|---|
| Chain height | SYNCED, advancing |
| Guard balance | starts 50 MINA, after step 5 = 48.5 MINA (−1.5 transfer) |
| Guard delegationNonce | 0 or 1 (depending on step 6) |
| `IncomingTransfer` rows | ≥ 1 (step 2), memo decoded |
| `Proposal` row | 1 executed, memo = "bi-weekly rebalance" |
| `RecipientAlias` rows | 2 (Kraken, Coinbase) |
| Contract tests | 145 pass / 0 fail / 2 skip |
