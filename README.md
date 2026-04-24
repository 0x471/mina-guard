# MinaGuard Monorepo

MinaGuard is a multisig wallet zkApp for Mina built with o1js, plus a Next.js UI and an Express indexer API.

## Packages

- `contracts/` - MinaGuard smart contract, stores, and tests.
- `backend/` - Express + Prisma + PostgreSQL read API and chain indexer.
- `ui/` - Next.js app with Auro wallet integration and on-chain actions.

## Key Features

- Propose -> approve -> execute lifecycle using proposal hash keyed approvals.
- Transfer, add/remove owner, threshold change, and delegate execution support.
- Indexed read API for contracts, owners, proposals, approvals, and raw events.
- Deploy + setup UI flow with session-only zkApp private key usage.

## M0 Self-Custody Features

This repo implements the M0 milestone of the self-custody spec (100k MINA
treasury, 2-of-N approvals, exchange whitelist, staking delegation, OAuth
dashboard). Each capability:

### Separation of duties (SOD)
`propose()` no longer auto-approves; quorum requires at least `threshold`
*distinct* signatures after the proposer. `setup()` enforces `threshold ≥ 2`.
Tested across all governance paths (145 contract tests pass).

### Single-key staking delegation
`executeDelegateSingleKey` rotates a guard's staking delegate with one
signature from the pre-committed `delegationKey`. Enables fast BP rotation
under incident without multisig quorum. Canonical 7-field signed message;
monotonic `delegationNonce` prevents replay. Expires at `expiryBlock`
(0 = no expiry), with a `requireBetween` precondition so in-flight txs
stay valid when the chain advances between prove and inclusion.

### On-chain recipient allowlist
`executeUpdateRecipientAllowlist` (ADD/REMOVE, quorum-gated) maintains a
per-guard Merkle root. `executeTransfer` refuses sends to non-allowlisted
recipients when `enforceRecipientAllowlist = true`. *Known gap: only
slot-0 is checked (shrunk from 9 after an o1js compile deadlock).*

### Parent/child-for-BPs architecture (M2-ready)
`executeSetupChild` binds an `initialDelegate` into the CREATE_CHILD
proposal hash so the parent's quorum approves the BP choice atomically
with the child spawn. Scale-validated: an opt-in test (`BP_SCALE=1 bun
test src/tests/bp-child-scale.test.ts`) spawns 80 children + rotates 40
in 275s (create: 3.4s/child, rotate: 0.13s/rotate).

### Memo loop end-to-end
32-byte memo input on the Propose Transfer modal → threaded through the
propose tx → indexer fetches the tx from the daemon and decodes the
base58-encoded memo to UTF-8 → stored on `Proposal.memo` → surfaced on
the proposal detail page and Activity feed. On execute, the transfer tx
carries the stored memo, so the receiving exchange (Kraken, Coinbase…)
sees the operator's identification string.

### Recipient aliases (address book)
Per-guard UI-layer alias table ("Kraken" → `B62q…`). Backend CRUD at
`/api/contracts/:addr/recipient-aliases`. Shown as clickable chips on
the propose form. *Not* enforced on-chain — orthogonal to the recipient
allowlist above.

### Auto-execute on threshold
`useAutoExecuteOnThreshold` hook: once a proposal's approvalCount ≥
threshold, any open proposal-detail tab waits a 2s debounce, takes a
`localStorage[autoExecute:<hash>]` lock, and fires the correct
`execute*` method via backend proving. `EXECUTED_MARKER` is the final
on-chain collision safety.

### Proposal expiry UX
Propose modal defaults `expiryBlock` to `current + 20_000` (≈7 days at
30s/block) with a live "expires in N blocks (≈X days)" readout. Activity
feed flags pending-but-expired proposals with a red `Expired` badge.
Resolves the spec's §4.1 open question about stuck requests.

### Three-tab IA
Every guard has three routes matching the mockup:
`/accounts/[addr]` (balance, owners, recent proposals, address book),
`/activity/[addr]` (filter tabs: All / Pending / Completed / Inbound /
Outbound / Needs My Signature), `/delegation/[addr]` (BP dashboard
with filter tabs + per-row rotation modal + Create BP Child wizard).

### Inbound transfer indexing
`IncomingPoller` scans the daemon's best chain every 15s for both
`userCommands` and `zkappCommands` targeting tracked guard addresses.
Positive balance changes become `IncomingTransfer` rows. Memos are
base58-decoded to UTF-8 via `memo-decode.ts`. Surfaced on the
Activity tab's Inbound filter.

### Backend-proving, user-pays model
The UI does not compile o1js in the browser. The backend does the heavy
`MinaGuard.compile()` + `tx.prove()` work. But the backend **holds no
Mina payment keys** — every `/api/tx/*` endpoint returns a proven-but-
unsigned tx JSON, and the user's Auro wallet adds the fee-payer
signature + broadcasts to the Mina node. `tx-service.ts` is the entry
point; `acquireLightnetFeePayer` does not exist in production paths.

Every request to `/api/tx/*` requires a `feePayer` field naming the
connected wallet's pubkey — that's who pays the fee. Auro signs + sends
via `window.mina.sendTransaction(transactionJson)`. Auro handles
user-level auth (per-method confirmation); backend-proving just removes
the browser-side `o1js.compile` cost and SharedArrayBuffer requirement.

In a multisig setup, every owner who participates (propose, approve,
execute) needs their own funded Auro account — they each pay for their
own tx. The guard account itself is funded separately for transfers to
exchange destinations.

### NextAuth Google OAuth
`@o1labs.org`-allowlisted sign-in via NextAuth; session mints an HS256
bearer token that the UI's `api.ts` attaches as `Authorization: Bearer`.
Backend middleware verifies the same signature + re-checks email domain.
Local dev bypass via `AUTH_DISABLED=true` (backend) +
`NEXT_PUBLIC_AUTH_DISABLED=true` (UI).

## Dev helpers

```bash
# Lightnet funding (from dev-helpers/.env keys)
bun run cli.ts lightnet-fund

# Rotate a guard's staking delegate via single-key (offline operator key)
bun run cli.ts delegate-single-key

# Send a test payment (exercises the IncomingPoller end-to-end)
bun run cli.ts send-payment --to B62q… --amount 10 --memo "rebalance"
```

## Development

### First-time setup

```bash
# Fetch submodule (fork of o1js, for now)
git submodule update --init

bun install

# Build contracts (required by backend and UI)
bun run --filter contracts build

# Set up the backend environment
cp backend/.env.example backend/.env

# Generate Prisma client
cd backend && bunx prisma generate && cd ..
```

#### Lightnet helpers

`dev-helpers/lightnet-up.sh` starts a standalone Mesa lightnet on the host (ports `8080` GraphQL, `8282` archive, `8181` account manager, `5432` Postgres). It first frees those host ports by stopping any colliding containers (`zkao-postgres-dev`, `local-lightnet-1`) and records what it stopped:

```bash
./dev-helpers/lightnet-up.sh
```

`dev-helpers/lightnet-down.sh` stops lightnet and restarts whatever the up script paused, so you're back where you started:

```bash
./dev-helpers/lightnet-down.sh
```

Once lightnet is running, accounts must have funds before they can submit transactions. Two ways:

- **From the UI** — once a wallet is connected on a testnet network, the header shows a "Fund" button that calls the backend's `/api/fund` route (which in turn drips from the lightnet account manager).
- **From the CLI** — add public keys to `dev-helpers/.env` and run:
  ```bash
  cd dev-helpers && bun run cli.ts lightnet-fund
  ```

**NOTE**: To test with a Ledger device, its public key (corresponding to the account index used) must be funded similarly. Only the public key is needed.

**Lightnet resets:** lightnet sometimes stops or wipes its chain state without warning. When that happens the backend's indexed view (contracts, proposals, etc.) no longer matches the live chain, so wipe the DB to start clean:

```bash
cd backend && bunx prisma db push --force-reset --skip-generate
```

Then restart lightnet (`./dev-helpers/lightnet-up.sh`) and the backend.

### Running

```bash
# Run UI (from ui/ directory)
cd ui && bun run dev

# Run backend API/indexer (from backend/ directory)
cd backend && bun run dev

# Run contract tests
bun run --filter contracts test
```

## E2E Testing

Full end-to-end tests live in `e2e/` and exercise the deploy → propose → approve → execute lifecycle against a real Mina network. See [e2e/README.md](e2e/README.md) for setup details.

```bash
# Quick start with local lightnet (default)
bun run test:e2e

# Against Mina devnet (requires funded accounts in e2e/.env.devnet)
NETWORK=devnet bun run test:e2e
```

## Build

```bash
bun run --filter contracts build
bun run --filter backend build
bun run --filter ui build
```

## PR Preview Environments

Each PR targeting `main` gets an isolated preview stack deployed to the Hetzner server via a self-hosted GitHub Actions runner. Preview URLs follow the pattern `https://mina-nodes.duckdns.org/preview/<PR_NUMBER>/`.

Each stack includes: lightnet, PostgreSQL, backend, frontend, block explorer, and a Caddy reverse proxy.

### Manual management

```bash
# From repo root
./preview-env/preview.sh up <PR_NUMBER>    # deploy
./preview-env/preview.sh down <PR_NUMBER>  # teardown
./preview-env/preview.sh list              # show active previews
```

### Local development with Docker

You can run the full stack locally without the server's Caddy:

```bash
./preview-env/local-preview.sh up 1
```

Access at `https://localhost:10001/preview/1/`. In Auro Wallet, set the network URL to `https://localhost:10001/preview/1/graphql`.

Caddy serves this over HTTPS with a self-signed cert (`tls internal`) and sets the COOP/COEP headers o1js needs — accept the cert warning on first visit. The CA persists in the `caddy-local-data` volume so the cert stays stable across restarts.

The helper builds `backend`, `frontend`, and `explorer` sequentially before starting the stack. This avoids the RAM spike from `docker compose up -d --build`, which can try to build all three images at once.

```bash
# Logs
docker compose -p local logs -f            # all services
docker compose -p local logs -f frontend   # frontend only
docker compose -p local logs -f backend    # backend/indexer
docker compose -p local logs -f lightnet   # mina node + archive

# Tear down
./preview-env/local-preview.sh down 1
```

### Develop on the remote server via SSH tunnel

When you want the heavy services (lightnet, backend, frontend dev server) to run on the server but iterate from your laptop's browser + Auro wallet.

On the **server**, follow [First-time setup](#first-time-setup) and [Running](#running) so lightnet, backend, and the UI dev server are listening on the default `localhost:*` ports. `backend/.env` and `ui/.env.local` need no changes.

On the **laptop**, open one SSH tunnel that forwards every port the bundle references:

```bash
ssh -L 3000:localhost:3000 \
    -L 3001:localhost:3001 \
    -L 8080:localhost:8080 \
    -L 8282:localhost:8282 \
    user@server
```

Then open `http://localhost:3000` in the browser. The frontend bundle has `localhost:*` baked in for the backend / Mina / archive URLs; both the server-side dev server and the laptop-side browser resolve `localhost` to themselves, so the URLs work on both ends as long as the tunnel is up.

Notes:

- Add a custom network in Auro Wallet pointing at `http://localhost:8080/graphql` and switch to it before connecting.
- Tunnel dies → the page errors. Run the SSH command inside `tmux`/`screen` if you want it sticky.

### Architecture

Requests hit the main Caddy (TLS + COOP/COEP headers) which reverse-proxies to a per-preview Caddy container that routes to individual services. COOP/COEP headers are set at the main Caddy level and upstream copies are stripped to prevent duplicates.

### Server setup

Preview routes are managed via the Caddy admin API (`localhost:2019`) — no sudo required. The self-hosted runner only needs Docker access (`docker` group).

### Gotchas

- **SharedArrayBuffer**: o1js WASM requires `crossOriginIsolated`, which needs COOP + COEP headers over HTTPS. Do not add `Cross-Origin-Resource-Policy: same-origin` — it blocks o1js blob URL sub-workers.
- **Bun workspaces**: `ui/deps/` must be copied into Dockerfiles because `mina-signer` is a `file:` dependency.
- **Minification disabled**: SWC/terser mangle BigInt ops used by o1js.
- **Server limits**: ~2GB RAM per preview stack, max 2–3 concurrent previews on the 30GB server. Run `docker image prune -f` periodically.


# Lightnet (working image before update 2026/04/13)

```bash
# Pull previous working lightnet (non-MESA) docker image
docker pull 'o1labs/mina-local-network@sha256:746190ff2f556f252b7f50215ae60d4a5e786c8adc16f27986e3e35ce6105949' 

# Verify it was pulled
docker inspect 'o1labs/mina-local-network@sha256:746190ff2f556f252b7f50215ae60d4a5e786c8adc16f27986e3e35ce6105949' --format '{{.Id}} {{.RepoTags}}'

# Tag it as a distinct image
docker tag 'o1labs/mina-local-network@sha256:746190ff2f556f252b7f50215ae60d4a5e786c8adc16f27986e3e35ce6105949' o1labs/mina-local-network:known-good

# Add a second tag, the one zk will look for
docker tag 'o1labs/mina-local-network@sha256:746190ff2f556f252b7f50215ae60d4a5e786c8adc16f27986e3e35ce6105949' o1labs/mina-local-network:compatible-latest-lightnet

# Confirm no stale state
zk lightnet stop --clean-up

# Start lightnet WITHOUT pulling latest
zk lightnet start --pull=false

```