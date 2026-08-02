---
title: review-gate non-blocking nits for 'revm-wasm-upgrade-honest-block-environment' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: revm-wasm-upgrade-honest-block-environment
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-wasm-upgrade-honest-block-environment' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 1: disableBlockGasLimit is taken and the block-gas-limit cap on the read budget is deleted, so a read whose gas is at or above the block gas limit now executes with gasLimit+intrinsic on revm instead of being silently trimmed. User-visible on the revm path only, and it converges with the default engine (runCall enforces no block limit), so it looks right; flagged for ratification because it is a behaviour default the task only asked to 'consider'.
  (packages/embedded-eth-node/src/revm.ts:167 (const gasLimit = request.gasLimit + intrinsic) + disableBlockGasLimit:true; decision 1 of work/notes/observations/decisions-revm-wasm-upgrade-honest-block-environment-2026-08-02.md)
- Ratify decision 2: disableEip3607 is a new PERMISSION on the read path (an eth_call whose from holds code now runs on revm). It removes a real divergence and the task asked for it explicitly, but it is a user-visible relaxation worth a human nod, and it is only safe because this engine can never commit.
  (src/revm.ts disableEip3607:true; revm-wasm refuses the switch with commit (dist/instance.js:102); the create path passes commit:false so the guard is not tripped)
- Coherence: CONTEXT.md defines 'conformance differential' as diffing the node against a trie-backed @ethereumjs/vm runTx reference, but the two new battery steps deliberately use a different oracle (the node's own block header plus configuration, and an absolute succeed/fail statement). The choice is right and recorded as decision 3, yet the glossary term now under-describes the battery. Worth pinning in CONTEXT.md so the next author does not re-fork the term.
  (CONTEXT.md:18; test/helpers/conformance.ts steps 13 and 14)
- Changeset claim overshoots: it says the two new conformance steps 'run in both state modes and on both engines', but revm refuses stateMode trie at construction, so on revm they run in 'none' only (trie coverage is default-engine only). Suggest rewording to match the split that revm-conformance.spec.ts documents.
  (.changeset/honest-blocks-for-revm-reads.md last paragraph vs test/revm-conformance.spec.ts header)
- The value-bearing steps classify any thrown error as 'failed' (bare catch), so the three negative cases would still pass if a future unrelated failure, e.g. a param-validation refusal or an engine construction error, replaced the insufficient-balance rejection. Consider asserting the error shape, or at least that the returned data is empty, so the step keeps proving what it names.
  (test/helpers/conformance.ts step 14 catch block; test/helpers/revm-engine.ts valueCases loop)
