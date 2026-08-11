---
title: Storage-key normalisation throws where ADR 0009 and its own module say it pads, and that branch is untested
slug: storage-key-normalisation-throws-where-two-docs-say-it-pads
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`revm-state-store-packed-storage-keys` adopted revm-wasm's packed key encoding. Gate 2 approved it and found the normalisation branch says one thing and does another, in two documents at once.

**1. The docs promise padding; the code throws.** ADR 0009's amendment and `src/storage-keys.ts` both state that a key which is not fixed width is NORMALISED by left-padding, and that THROWING was deliberately rejected as the alternative. The implementation uses `setLengthLeft` without `allowTruncate`, and `@ethereumjs/util`'s `setLength` throws when the input is LONGER than the target. So short keys are padded as documented, and over-long keys are refused, which is precisely the behaviour both documents say was rejected.

It is also a behaviour CHANGE with a user-visible edge: an over-long slot key in a hand-made `loadState` payload used to be hex-encoded harmlessly and is now a refusal. And the refusal arrives as a raw `@ethereumjs/util` error (`Input length N exceeds target length 32`), not in the node's own voice, on a node whose other refusals name what was wrong and what to do about it.

Decide which is right, then make the code and both documents agree. If refusing an over-long key is correct, and there is a good case that it is (a 33-byte slot key is a caller error, not something to silently reinterpret), then it should refuse in the node's own words and the two documents should stop claiming padding was chosen over throwing. If padding really is wanted, truncation semantics need stating explicitly, because left-padding cannot be applied to something already too long.

**2. The normalisation branch has no direct test.** There is no unit spec for the key module, and the probes all use full-width 32-byte slots, so the not-exactly-20-or-32-bytes path is never exercised. The module header calls the aliasing hazard load-bearing (two different logical keys must never pack to the same bytes), and that hazard is only demonstrated for full-width keys via the neighbouring-slot and neighbouring-address probes. The untested branch is the one that transforms keys, which is where an aliasing bug would come from.

**3. Added 2026-08-11 from Gate 2 on `prune-bottom-overlay-tombstones-and-align-the-quoted-speedup`: a new storage invariant that the authoritative docs do not know about.** That task established that the BOTTOM overlay holds no tombstones, and documented it only in `src/state-manager.ts`'s JSDoc, in its test and in a bundle re-pin comment. ADR 0009 and the `CONTEXT.md` glossary still define an overlay as written slots plus a tombstone set of the accounts cleared in it, with no bottom exception, and ADR 0007's two amendments still describe `clearStorage` as one delete plus a tombstone. Grepping the ADRs and the glossary for the bottom case returns nothing.

Nothing reads a bottom cleared set today, so the impact is latent, but the glossary is this repo's stated source of truth for the overlay and tombstone language, and a future author reading it would take `bottom.cleared` as authoritative. Since this task is already reconciling ADR 0009 against the storage code, add the sentence here rather than leaving a second storage doc drift open.

## Acceptance criteria

- [ ] The code, ADR 0009's amendment and the module's own header agree about what happens to a key that is not fixed width, in both directions (shorter and longer than the width).
- [ ] If an over-long key is refused, the refusal is the node's own, naming the key, the expected width and what to do, rather than a raw `@ethereumjs/util` message reaching the caller.
- [ ] The normalisation branch is directly tested for both directions, including that no two distinct logical keys pack to the same bytes after normalisation.
- [ ] The `loadState` path is covered specifically, since that is where a hand-made payload with an odd-width key actually arrives.
- [ ] If ADR 0009's stated decision changes, it takes a DATED AMENDMENT rather than a rewrite.
- [ ] ADR 0009 and the `CONTEXT.md` glossary state that the bottom overlay holds no tombstones, so `bottom.cleared` cannot be read as authoritative.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] A changeset if the refusal or the normalisation behaviour changes for a consumer.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: one story about what happens to an odd-width storage key, told the same way by the code, the ADR and the module header, and tested.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. Verify the throw yourself by handing an over-long slot key to `loadState`, and confirm what reaches the caller.
>
> Read ADR 0009 INCLUDING every amendment before touching this: the storage layer has been re-decided more than once and an earlier amendment supersedes parts of the original.
>
> The aliasing property is the load-bearing one: two distinct logical keys must never pack to the same bytes. Whatever you decide for odd-width keys, that property must survive it, and the test should demonstrate it rather than assert it in a comment.
>
> This repo's convention is that a refusal says what happened and what to do about it. A library's raw length error reaching an RPC caller is the shape being removed.
