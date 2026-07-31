# Spike: can revm's synchronous `StateStore` read the node's own state?

Throwaway code kept because the answer is load-bearing for `revm-engine-subpath`. The decision it produced is `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`; this folder is the evidence behind it.

**Answer: yes for `stateMode:'none'`, no for `stateMode:'trie'`.** `revm-wasm@0.1.0` executed `eth_call` against the node's live `SimpleStateManager` with nothing copied in ahead of the call, and charged the reference gas exactly: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x2681…fe5a`.

## Files

- `simple-state-store.ts` — the adapter. A `StateStore` over `SimpleStateManager`'s three public checkpoint stacks, reading the TOP frame on every access, with a lazily-rebuilt `codeHash -> code` index and every write method throwing. This is the artifact `revm-engine-subpath` should lift; it is not published from here.
- `harness.ts` — the runnable spike. Eight sections: a `MemoryStore` control, the node-state run, state coherence after a transaction, the checkpoint/revert trap, the "a call cannot commit" proof, the code-index staleness trap, a rough cost measurement, and the `'trie'`-mode verdict. Every claim in the ADR is one of its `PASS` lines.
- `measurements.txt` — the captured output of one full run (Node 24.13.1, `revm-wasm@0.1.0`, revm 42.0.1 rev `640eafa9`, `@ethereumjs/*` 10.1.2).

## Running it

The harness deliberately does NOT live in the workspace: it must not touch `package.json` or `pnpm-lock.yaml` (a sibling task adds `revm-wasm` to the benchmarks package). Rebuild the scratch tree outside the repo:

```sh
mkdir /tmp/revm-spike && cd /tmp/revm-spike
npm init -y && npm pkg set type=module
npm i revm-wasm@0.1.0 @ethereumjs/vm@10.1.2 @ethereumjs/evm@10.1.2 \
      @ethereumjs/statemanager@10.1.2 @ethereumjs/block@10.1.2 @ethereumjs/tx@10.1.2 \
      @ethereumjs/util@10.1.2 @ethereumjs/common@10.1.2 @ethereumjs/mpt@10.1.2 \
      @noble/hashes@2.2.0 tsx
cp <repo>/docs/spikes/revm-state-adapter-spike/{harness,simple-state-store}.ts .
cp <repo>/packages/benchmarks/test/helpers/counter.ts .
mkdir node-src && cp <repo>/packages/embedded-eth-node/src/*.ts node-src/
npx tsx harness.ts
```

It exits non-zero if any check fails, so it is usable as a regression probe when `revm-wasm` or `@ethereumjs/statemanager` moves.

## Two things the harness exists to prove, not assert

**The view must read the top of the checkpoint stack.** The node checkpoints the state manager around every pure call and `checkpointSync()` pushes a COPY of all three maps, so an adapter that caches the frame it saw at construction reads a stale one. Section 4 runs both: the top-of-stack view returns 42 after a checkpointed write and follows the revert back to 1; the cached-frame view returns 1 throughout, silently.

**A stale `codeHash -> code` index fails silently.** revm asks `getCode(codeHash)`; the node keys code by address, so the inverse index is derived state that lives outside the state manager. Section 6 shows what a never-rebuilt index does when code is deployed after it was built: `status: 'success'`, empty return data, no error anywhere. That is why the adapter rebuilds on a miss rather than on a hook.
