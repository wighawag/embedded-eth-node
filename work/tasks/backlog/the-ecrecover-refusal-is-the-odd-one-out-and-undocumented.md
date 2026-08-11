---
title: The sender-recovery refusal diverges by engine and speaks a different vocabulary from its five siblings
slug: the-ecrecover-refusal-is-the-odd-one-out-and-undocumented
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`sender-recovery-uses-the-engines-ecrecover` put ecrecover behind the engine seam. Gate 2 approved it and left two things about the resulting public surface.

**1. The refusal is the odd one out, and it diverges by engine.** An unrecoverable signature throws a plain `Error`. Its five siblings, added by `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors` and by the block-gas-limit work (nonce too low, nonce too high, insufficient funds, intrinsic gas too low, block gas limit exceeded), all speak geth's vocabulary through `RpcError` with code `-32000`. So a client that learned to branch on this node's refusals has one refusal it cannot branch on.

Worse, and this is the part that matters beyond consistency: the MESSAGE differs between the two engines for the SAME bad transaction, the node's own text on one path and `@ethereumjs/tx`'s on the other. That is precisely the class of defect this whole spec exists to remove, a surface meant to be engine-independent carrying an engine-specific artifact. The refusal SHAPE matching the fallback is not enough; a caller reads the message.

The choice was recorded deliberately (decision 4, with the rejected alternative), so weigh it rather than assuming it was an oversight. But the cross-engine message difference should be closed either way.

**2. The README does not tell an engine author the operation exists.** The Engine section still says the seam has TWO operations and that an engine implements BOTH. `ecrecover` is optional and additive, and it is documented in `src/types.ts`'s JSDoc, in `CONTEXT.md` and in ADR 0006's amendment 4, but a third-party engine author reading the README's engine section, which is the surface written FOR them, will not learn they may implement it. `CONTEXT.md`'s engine entry has the same opening tension, though it resolves itself later in the paragraph.

## Acceptance criteria

- [ ] The same unrecoverable signature produces the same refusal MESSAGE on both engines, asserted per engine on the node's own answer.
- [ ] Whether that refusal joins its five siblings at `RpcError` `-32000` with geth's vocabulary is decided explicitly; if it stays a plain `Error`, the reason is recorded where a consumer meets it, and the decision accounts for the fact that every other refusal on this node is branchable.
- [ ] The README's Engine section states that the seam has two REQUIRED operations plus an optional `ecrecover`, so an engine author learns it exists from the surface written for them.
- [ ] `CONTEXT.md`'s engine entry opens consistently with that, rather than resolving the tension later.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] A changeset if the refusal's shape or wording changes, since consumers branch on both.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: one answer per question, including for a signature that does not recover, and an engine author who can discover the optional operation from the README.
>
> FIRST, check this task against current reality: it was written on 2026-08-11 and may have DRIFTED. Reproduce the differing messages across the two engines before changing anything.
>
> Read decision 4 in `docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md`, which chose the plain `Error` deliberately and names the alternative it rejected, and ADR 0006's amendment 4 for the optional-operation decision. You are revisiting a recorded choice, not correcting an oversight, so argue with it rather than around it.
>
> The five sibling refusals pin geth's leading clauses character for character and consumers branch on them. If you bring this one into that family, match the contract exactly; if you keep it apart, say why at the site.
