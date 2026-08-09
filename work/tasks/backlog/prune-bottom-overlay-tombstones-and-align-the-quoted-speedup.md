---
title: Prune the bottom overlay's tombstones, and stop the repo quoting two different numbers for the same speedup
slug: prune-bottom-overlay-tombstones-and-align-the-quoted-speedup
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

Two loose ends from `re-layer-storage-as-per-account-maps-with-per-frame-diffs`, both found by Gate 2. The first is a small unbounded-growth defect in code that ships; the second is a number the repo now states two ways.

**1. The bottom overlay's `cleared` set grows forever.** `commit()` in `src/state-manager.ts` does `below.written.delete(address)` then `below.cleared.add(address)` for every address the top overlay cleared. That is right when `below` is another overlay: the tombstone has to keep hiding whatever an even lower overlay holds. It is pointless when `below` is the BOTTOM overlay, because there is nothing underneath for a tombstone to hide, and the entry then stays for the process's lifetime. The EVM calls `clearStorage` on every contract creation, so in a long-lived browser node this is one permanent string per CREATE ever executed, and it adds an O(addresses-ever-cleared) term to `liveStorage()` and therefore to every `dumpState`.

Nothing is WRONG today: reads still answer correctly, because a tombstone on the bottom overlay for an account with no slots below it is a no-op that happens to cost memory. Fix it at the source (skip the tombstone when `below` is the bottom overlay, i.e. when the stack depth after the pop is one) rather than by sweeping later, and assert it: clear an account, commit to the bottom, and check the bottom overlay's `cleared` set is empty while the account still reads as cleared. If skipping turns out to be wrong for some case, the fallback is a comment explaining why the growth is accepted, but prefer the fix; an in-browser node is exactly the process that runs long enough to notice.

**2. The benchmark comment quotes a bare 28x.** `packages/benchmarks/test/evm.spec.ts`'s re-pin block says "28x on four transactions at 100,000 slots" twice, while ADR 0009, the measurements doc and the changeset all say 18-28x across two runs and tell the reader explicitly not to quote a single figure from the allocation-heaviest cell. Align the comment with the 18-28x-and-flat wording. The interesting claim was never the ratio anyway: it is that the shipped column is FLAT in state size, which is what makes the number durable.

## Acceptance criteria

- [ ] A commit into the bottom overlay leaves no tombstone behind, and the cleared account still reads as cleared afterwards, asserted in `test/storage-overlay.spec.ts` alongside the existing semantics.
- [ ] The six checkpoint/commit/revert semantics, the randomised differential against the frozen flat baseline, and the naive control's continued failure all still hold: this must not become correct-by-weakening-the-control.
- [ ] `dumpState` output is unchanged, still byte-identical to `test/fixtures/dumpstate-flat-layout.json` (key order included), and the fixture is NOT regenerated.
- [ ] `packages/benchmarks/test/evm.spec.ts`'s re-pin block states the same 18-28x-and-flat claim as ADR 0009, the measurements doc and the changeset, so the repo carries one number for one measurement.
- [ ] The bundle-size baseline is unchanged or, if the fix moves it, re-pinned in the same change with the reason in the comment block.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- None. It refines a change that has already landed.

## Prompt

> Goal: one small unbounded-growth defect in shipped code, and one number the repo states two ways.
>
> Read `commit()` and `liveStorage()` in `packages/embedded-eth-node/src/state-manager.ts`, then `docs/adr/0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md` for what an overlay and a tombstone are for.
>
> The tombstone rule is easy to get subtly wrong, so state the invariant before you code: a tombstone exists to hide slots held by overlays BELOW it. On the bottom overlay there is nothing below, so it hides nothing. Make sure your fix keeps the account reading as cleared, and make sure the existing naive control still FAILS the semantics it fails today: a fix that also weakens the control has proved nothing.
>
> Do not regenerate `test/fixtures/dumpstate-flat-layout.json`. It is a capture from the pre-overlay build, its provenance has been independently verified, and a fresh capture would make the byte-identity assertion vacuous.
