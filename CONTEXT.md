# CONTEXT — embedded-eth-node domain language

The domain glossary for `embedded-eth-node`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); product framing lives in `work/specs/`.

## What embedded-eth-node is

A slim, execution-only in-browser EIP-1193 Ethereum node built on `@ethereumjs/vm`: a transport-agnostic core with optional Web-Worker hosting and IndexedDB persistence, which implements only the read + signed-raw-tx methods a viem/wagmi client actually uses and fails loudly at its intentional edges instead of faking success.

## Core domain terms

- **slim node** — the object `createNode()` returns: `{request, mine, dumpState, loadState, onNewHead, getStateRoot, dispose}`. `request()` is an async EIP-1193 method, which is what lets the SAME object work unchanged on the main thread or across a Worker boundary.
- **execution-only** — the node executes signed transactions and reads; it holds no keys and implements no account or signing methods. `eth_sendTransaction`, `eth_accounts`, `eth_sign`, `personal_*` and `wallet_*` throw a real `-32601` rather than faking success.
- **honest edge** — the convention that an unimplemented or deliberately-absent method fails LOUDLY with a real JSON-RPC error, never a plausible-looking fake result. The node's `-32601` surface is a feature, not a gap.
- **state mode** — `stateMode: 'none' | 'trie'`. `'none'` (default) is `SimpleStateManager`: plain Maps, no trie, no state root. `'trie'` is `MerkleStateManager`: a real Merkle-Patricia root, which is what makes the node conformance-testable against `ethereum/tests` GeneralStateTests. See `docs/adr/`.
- **sender mode** — `senderMode: 'recover' | 'trusted'`. `'recover'` (default) derives the sender with ecrecover, as a real node does. `'trusted'` pins a caller-supplied sender and skips ecrecover entirely, via the `evm_sendRawTransaction*As` cheats. See `docs/adr/`.
- **cheat method** — an `evm_*`-namespaced method that does something a real node would not (mutate state with no transaction, or trust a claimed sender). Deliberately namespaced so it can never be mistaken for standard behaviour.
- **the gate** — the cross-backend assertions in `packages/benchmarks`: every EVM backend must charge the same EXECUTION gas and produce the same keccak-chain result for the same call. Gas equality (not result equality) is what makes an interpreter swap safe, because engines that disagree on gas disagree on where execution runs OUT of gas, and a client replaying the chain would fork.
- **conformance differential** — the library's own test that runs the same signed transactions through the node AND a trie-backed `@ethereumjs/vm` `runTx` reference, diffing receipts field by field plus post-state. The strongest correctness bar in the repo.
- **engine** — the EVM behind the node's READ path (`eth_call`, `eth_estimateGas`, `eth_fillTransaction`'s estimation), and ONLY that path: an object implementing `ReadEngine` (execute a read-only call, report return data + EXECUTION gas + whether it failed), passed as `createNode({engine})` and reported back as `node.readEngine`. Default `@ethereumjs/evm`; `work/specs/` covers revm-wasm as an injectable alternative. It is never a name the core resolves — always an injected object, so the core imports no engine a consumer did not (`docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`). **Transactions do NOT run on it** — they run on `@ethereumjs/vm` whatever engine is installed, so a receipt can never be attributed to the engine; say *read engine* when that distinction matters, and do not re-widen "engine" to mean "the EVM behind the node" until a spec actually moves transactions onto it.
- **frame budget** — 16.6 ms, the 60fps target. The benchmark's `frame` row (N small view reads back to back) is measured against it, because the consuming use case is an in-browser on-chain game.
- **promptGuidance** — the per-repo NUDGE namespace in `dorfl.json` whose members (currently just `testFirst`) strengthen the wording in the worker's in-band prompt. NOT a gate: the `verify` step is still the only acceptance bar.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`): `WORK-CONTRACT.md` (the contract), `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`, `task-template.md`, `spec-template.md`, `ADR-FORMAT.md`. Three REGIME umbrellas — `notes/` (capture buckets), `tasks/` (the build board), `specs/` (the spec lifecycle) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). Capture buckets: `notes/ideas/` (proposed), `notes/observations/` (spotted, unverified, append-only), `notes/findings/` (verified EXTERNAL ground truth, each with a `source:`). Our own architecture belongs in this file and `docs/`, never in `findings/`. ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Conventions

Standing per-change rules agents must follow in this repo.

- **Every user-facing change needs a changeset.** Run `pnpm changeset` (or hand-write a file in `.changeset/`) describing the change and its semver bump. This repo publishes `embedded-eth-node` to npm via changesets; a release without one silently ships unversioned. Not currently enforced by the `verify` gate — to enforce it, add your own check (e.g. `changeset status --since=main`) to `verify` in `dorfl.json`.
- **The dorfl version is PINNED** via `dorflCmd` in `dorfl.json`, pointing at the project-local `node_modules/.bin/dorfl`, so bare `dorfl` self-forwards to the version in this repo's `devDependencies` rather than floating with whatever is globally installed. To bump: change the `dorfl` devDependency, `pnpm install`, then `dorfl sync` to re-sync `work/protocol/`.
- **Never commit a wasm artifact.** The revm module is consumed as the `revm-wasm` npm package (prebuilt `.wasm` in the tarball, zero runtime dependencies), so `packages/benchmarks` needs no build step and no vendored blob; the benchmark spec copies the package's `.wasm` into the served directory at test time. If another wasm engine is ever added, add it the same way rather than checking bytes in.

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-spec`, `to-task`.
- Recommended: `review`, `grill-me`.
