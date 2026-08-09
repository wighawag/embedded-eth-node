---
title: The RPC block and the EVM disagree about the same block's COINBASE and PREVRANDAO — report them or state the omission
slug: the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao
spec: revm-engine-behind-eth-call
blockedBy: []
covers: []
---

## What to build

A node created with `blockEnv: {coinbase, prevRandao}` mines blocks where the `COINBASE` and `PREVRANDAO` opcodes return the configured values, while `eth_getBlockByNumber` reports `miner: 0x0000...0000` and no `mixHash` field at all. **The RPC surface and the EVM disagree about the same block**, and nothing in the README says so. Captured in `work/notes/observations/rpc-block-omits-coinbase-and-prevrandao.md`; untouched so far because every task that met it was scoped elsewhere.

This task DECIDES the question and then does whichever thing it decided. It is written as a decision because the cheap-looking fix has a persistence consequence that makes it non-trivial, and because reporting a real `miner` is a behaviour change for anyone whose tooling currently reads zero.

### What is actually wrong, precisely

- `executeAndMine` (`src/node.ts`) DOES honour the configuration: it sets `coinbase` from `blockEnv.coinbase` and writes `blockEnv.prevRandao` into `mixHash`, with `difficulty: 0n` for post-Merge. So the block object is right and the opcodes read the right values.
- `blockToRpc` (`src/node.ts`) hardcodes `miner: '0x0000...0000'` and emits no `mixHash`. It reads `sb.header`, the `SerializedBlock`, not `sb.block`, and the real values are sitting one field away on `sb.block.header`.
- `SerializedBlock` (`src/types.ts`) carries neither field. That is the sting: `loadState` rebuilds each block with `createBlock({header: {number, gasLimit, gasUsed, baseFeePerGas, parentHash, timestamp}})` and nothing else, so **a reloaded node loses coinbase and prevRandao for every historical block**. Reading them off `sb.block` alone would therefore make the RPC answer correctly before a reload and zero after one, which is worse than answering zero consistently.
- The genesis block ignores `blockEnv` entirely, so block 0 carries neither value even before any of the above.

While you are in there, check one adjacent thing rather than assuming it: the reconstructed block in `loadState` omits `difficulty` and the two fields above, so its computed `block.hash()` cannot match the stored `sh.hash` that the RPC actually returns. Determine whether anything depends on the reconstructed block's own hash. If something does, that is a separate defect and it gets its own note, not a silent fix here.

### The two honest resolutions, and this task picks one

**Report the real values.** Extend `SerializedBlock` with the two fields, have `blockToRpc` read them, make `loadState` restore them, and give genesis the configured `blockEnv`. This is a persistence FORMAT change: `SerializedState` carries `version: 1`, so decide explicitly whether this is a version bump or a backward-compatible optional read, and make sure a state dumped by the current version still loads (an old dump has no such fields; absent must mean zero, not undefined-shaped output).

**Or state the omission.** If reporting them is judged not worth the format change, then say so where a consumer will meet it: the README's RPC surface table, and the `blockEnv` option's own documentation. A stated limitation is honest; a silently zero `miner` on a node whose EVM says otherwise is not. If you take this route, say WHY in one clause (it is not obvious that a node offering `blockEnv.coinbase` should report a zero miner), and record what a consumer should use instead.

Prefer reporting the real values if the persistence change stays small, because the node already accepts the configuration and the disagreement is the kind of thing a consumer discovers with a debugger. Prefer stating the omission if the format change turns out to reach persistence fixtures, IndexedDB reload paths and the conformance battery at once.

### One consequence worth knowing before you choose

The conformance battery's `block environment through a contract` step diffs `COINBASE` and `PREVRANDAO` against **the configuration** rather than against the reported block, precisely because the RPC block reports neither. If this task makes the RPC honest, that step can diff all six values against the node's own block and stop special-casing two of them, which also simplifies the `conformance differential` glossary entry in `CONTEXT.md` that was just corrected to describe the split. Do not change that step's oracle as a side effect: if it becomes possible, note it for a follow-up so it is a deliberate change with its own reasoning.

## Acceptance criteria

- [ ] The decision is made and RECORDED at the code site: either `eth_getBlockByNumber` reports the block's real `miner` and `mixHash`, or the omission is documented where a consumer meets it, with the reason.
- [ ] If reporting: the values survive a `dumpState` / `loadState` round trip and an IndexedDB reload, asserted; a state dumped by the CURRENT version still loads, asserted; and the genesis block honours `blockEnv` too.
- [ ] If reporting: the persistence format decision (version bump versus backward-compatible optional fields) is explicit, and `SerializedState.version` is handled accordingly.
- [ ] If documenting: the README's RPC surface and the `blockEnv` option both say it, and the note explains what a consumer should read instead.
- [ ] `work/notes/observations/rpc-block-omits-coinbase-and-prevrandao.md` is discharged in the same change, since whichever artifact results carries its signal.
- [ ] The conformance battery's block-environment step still passes unchanged; if this makes a tighter oracle possible, that is noted for a follow-up rather than done here.
- [ ] The `loadState` block-hash question is answered: either nothing depends on the reconstructed block's own hash, or it is a separate note.
- [ ] A changeset if any RPC output or persisted format changes.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None.

## Prompt

> Goal: the node's RPC block and its EVM currently disagree about the same block, and no document admits it. Fix the disagreement or state it, and do not leave it in the note inbox a third time.
>
> Read `work/notes/observations/rpc-block-omits-coinbase-and-prevrandao.md`, then `executeAndMine`, `blockToRpc` and `loadState` in `packages/embedded-eth-node/src/node.ts`, and `SerializedBlock` in `src/types.ts`.
>
> THE TRAP IS THE RELOAD. `blockToRpc` reads the serialised header, and the real values live on the block object, so "just read `sb.block.header`" answers correctly until someone reloads a persisted state, after which the reconstructed block has neither. An RPC that is right before a reload and zero after it is worse than one that is uniformly zero. Whatever you do, make the answer the same on both sides of a round trip.
>
> Decide, do not hedge. Either the values are reported (and then persistence carries them) or the omission is documented (and then it is documented where a consumer stands, not in a comment). Both are defensible; a third state where the code half-reports is not.
>
> Do not change the conformance battery's block-environment oracle as a side effect. It diffs two of its six values against the configuration BECAUSE of this bug, and unwinding that is a deliberate change with its own reasoning, not a cleanup.
