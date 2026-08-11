---
title: Decisions taken while building 'prune-bottom-overlay-tombstones-and-align-the-quoted-speedup'
date: 2026-08-11
status: open
decisionsFor: prune-bottom-overlay-tombstones-and-align-the-quoted-speedup
---

# Decisions taken while building `prune-bottom-overlay-tombstones-and-align-the-quoted-speedup`

The done record's `## Decisions` block, kept here because the task body is moved byte-identical by the runner. Ratify or reverse.

## 1. The rule is applied at BOTH sites a bottom tombstone can be created, not only in `commit()`

**Chosen:** `OverlayStorageStateManager` now keeps the bottom overlay tombstone-free as a class invariant: `commit()` skips `below.cleared.add(address)` when the overlay it merges into is the bottom one (what the task asked for), and `clearStorageAt()` skips `top.cleared.add(addressKey)` when no checkpoint is open, i.e. when the top overlay IS the bottom one. The `delete` that performs the clear is untouched at both sites.

**Why:** the task named `commit()` as the source, which is true for the DEFAULT engine only. `runTx` checkpoints, so `@ethereumjs/evm`'s `clearStorage` on every contract creation lands three overlays deep and is pruned on the way down. `embedded-eth-node/revm` commits its state changes through `src/revm-state-store.ts`'s synchronous callbacks with NO checkpoint around them, so every CREATE on that engine clears at depth 1 and never passes through `commit()` at all. Measured before the fix, on a real node with each engine installed, three contract creations each: default engine, clears at overlay depth 3 and a bottom `cleared` set of size 0 after the `commit()` fix; revm engine, clears at depth 1 and a bottom `cleared` set of size 3, one permanent entry per CREATE. Fixing only `commit()` would have left the described defect fully intact on the shipped revm write path, which is the path the growth argument (a long-lived in-browser node) is really about.

**Rejected:** fixing `commit()` alone and filing the revm half as a follow-up observation (it is the same defect, the same invariant and the same one-line shape, and the task's own goal is "one small unbounded-growth defect in shipped code"); sweeping the bottom overlay's `cleared` set later (the task rules it out, and it re-introduces an O(n) pass).

**What it touches:** the revm write path (`src/revm-state-store.ts`'s `clearStorage`/`removeAccount` callbacks) and `deleteAccount`, both of which reach `clearStorageAt`. Nothing else calls it. Asserted at both sites in `test/storage-overlay.spec.ts`, together with the case that must NOT change (a commit into a non-bottom overlay still leaves the tombstone that hides the frame below).

## 2. The bare `28x` in the already-written changeset was aligned too

**Chosen:** besides `packages/benchmarks/test/evm.spec.ts` (the acceptance criterion), the one remaining bare "the 28x" in `.changeset/per-account-storage-overlays.md` now reads "that flatness", matching its own headline (18-28x) and ADR 0009.

**Why:** the criterion is "the repo carries one number for one measurement", and `grep -rn 28x` would otherwise still find a single-cell figure. The changeset is unreleased release notes, not history, so this is not a rewrite of a published claim.

**Rejected:** leaving it (a residual second reading of the same measurement); touching `CHANGELOG.md` (history, not rewritten).
