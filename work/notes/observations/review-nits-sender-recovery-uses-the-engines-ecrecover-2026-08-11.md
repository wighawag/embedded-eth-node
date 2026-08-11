---
title: review-gate non-blocking nits for 'sender-recovery-uses-the-engines-ecrecover' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: sender-recovery-uses-the-engines-ecrecover
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'sender-recovery-uses-the-engines-ecrecover' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the seam decision: Engine.ecrecover is OPTIONAL and is the seam's first optional operation, while call/transact stay required. This is public API shape and hard to reverse once third-party engines exist. Recorded in the Decisions block (measurements.md #1) and ADR 0006 amendment 4; it reads sound (the node can always supply the fallback), but it needs a human yes.
  (src/types.ts Engine.ecrecover?(...); docs/adr/0006-... Amendment 4; connectEngine still refuses a missing call/transact)
- Ratify the refusal shape: an unrecoverable signature throws a plain Error, not RpcError -32000. Its siblings added by the rejections task (nonce too low/high, insufficient funds, intrinsic gas, block gas limit) all speak geth vocabulary at -32000, so this path is now the odd one out; and although the SHAPE matches the fallback, the MESSAGE differs between engines for the same bad transaction (the node's own text vs @ethereumjs/tx's). Recorded as decision #4 with the rejected alternative; confirm the asymmetry is wanted.
  (src/sender-recovery.ts throws new Error(...); src/node.ts refuseIfSenderCannotSend / refuseIfBelowIntrinsicGas use RpcError(-32000, ...))
- The refusal row legacy-bad-v does not test what its comment claims: v = chainId*2+37 is rejected by @ethereumjs/tx's constructor (validateVAndExtractChainID, Incompatible EIP155-based V) inside createTxFromRLP, on BOTH nodes, so it never reaches recoverSender and proves parse-time agreement rather than recovery-id agreement. Relatedly, the recovery !== 0/1 guard in recoverSender is effectively unreachable from parsed transactions (legacy v is constrained by the constructor, typed y-parity by validateYParity). Worth a comment correction; the acceptance criterion is still met observably (both refuse, nothing mined, no state moved), and the real coverage of the recovery-id rule is the primitive table plus recoveryIdsHandedToTheEngine plus mutation (b).
  (test/helpers/sender-recovery.ts badTxs legacy-bad-v; @ethereumjs/tx legacy/tx.js validateVAndExtractChainID)
- README's Engine section still tells an engine author the seam has TWO operations and that an engine implements BOTH, with no mention of the optional ecrecover; a third-party engine author reading that section will not learn the operation exists (it lives in types.ts JSDoc, CONTEXT.md and ADR 0006 A4). CONTEXT.md's engine entry has the same opener tension, though it resolves it later in the same paragraph. Cheap to fix with one sentence.
  (README.md around line 290: the seam it plugs into has two operations ... An engine implements BOTH operations)
- Two in-scope choices worth ratifying that are only stated in code comments, not in the Decisions block: (a) engine.ecrecover is read and bound ONCE after connect, so a capability added to the engine object later is ignored for the node's lifetime; (b) the node does not guard against an engine whose ecrecover THROWS instead of returning undefined, so a contract-violating engine surfaces its raw error to the RPC caller. Both are defensible (fixed identity, loud failure); confirm.
  (src/node.ts engineEcrecover = typeof engine.ecrecover === 'function' ? engine.ecrecover.bind(engine) : undefined; src/sender-recovery.ts has no try/catch around the ecrecover call)
