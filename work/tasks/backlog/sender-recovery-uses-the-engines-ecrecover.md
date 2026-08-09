---
title: In senderMode 'recover', sender recovery uses the engine's ecrecover when one is installed
slug: sender-recovery-uses-the-engines-ecrecover
spec: revm-engine-behind-runtx
blockedBy: [eip-2930-access-lists-are-charged-and-warmed]
covers: [14]
---

## What to build

`senderMode:'recover'` derives a transaction's sender with ecrecover, as a real node does, and that recovery is a fixed cost paid on every transaction. When a revm engine is installed the module already contains a secp256k1 precompile, and the binding exposes signature recovery directly, so the node can use it for roughly a 4x saving on the recovery half at ZERO additional bytes. When no such engine is installed, recovery falls back to the current implementation.

Both `senderMode` values keep their meanings: `'recover'` is still authenticated recovery, `'trusted'` still skips recovery entirely on the `evm_*As` cheat paths. What changes is only the implementation of the recovery itself.

Note the consequence, because it changes how the modes should be described rather than what they do: this NARROWS the gap between the two modes, from roughly 13x to roughly 3x on the isolated transaction path, because the expensive half of `'recover'` gets much cheaper. `'trusted'` remains worth having and stops being the dominant lever. Wherever the repo currently quotes that 13x to justify `'trusted'`, the number must move with this change rather than be left standing.

The correctness bar is not the speed. Recovery decides WHO signed a transaction, so the two implementations must agree on every case, including the ones that should FAIL: a malformed signature, an `s` value in the upper half of the curve order (EIP-2), a wrong recovery id. A recovery that silently returns a plausible wrong address is the worst outcome available here, and it would authenticate a transaction as the wrong sender.

## Acceptance criteria

- [ ] With a revm engine installed and `senderMode:'recover'`, sender recovery goes through the engine; without one it falls back to the existing implementation, and both produce identical senders.
- [ ] The two implementations agree on rejection cases too: a malformed signature, a high-`s` signature, and a wrong recovery id are refused by both, and a transaction carrying one is rejected rather than attributed to some address.
- [ ] A recovered sender is asserted against a known signer for legacy, EIP-2930 and EIP-1559 transactions.
- [ ] `senderMode:'trusted'` is untouched and still skips recovery entirely; its refusal when the mode is not enabled is unchanged.
- [ ] Every place the repo quotes the recover-versus-trusted ratio is updated, so no stale 13x survives to justify a decision on numbers that moved.
- [ ] The saving is MEASURED and recorded rather than asserted from the binding's documentation.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `eip-2930-access-lists-are-charged-and-warmed` — it touches the same modules as the write-path chain, so it is serialized behind them rather than racing them.

## Prompt

> Goal: use the secp256k1 implementation already sitting in the wasm module for sender recovery, and prove it authenticates identically to the one it replaces.
>
> Read the node's sender-recovery path and the `senderMode` documentation, the trusted-sender cheat methods and their refusal, and the binding's signature-recovery API.
>
> THE BAR IS AGREEMENT ON FAILURES, not speed. A recovery that returns a plausible wrong address authenticates a transaction as someone else. Test the malformed signature, the high-`s` value (EIP-2) and the wrong recovery id, and require both implementations to refuse all three.
>
> The speed is the reason but not the evidence: measure it in this repo rather than quoting the binding's figure, and update the recover-versus-trusted ratio everywhere the repo currently states it, because narrowing that gap is the interesting consequence of this task and a stale number would keep justifying a trade-off that no longer holds.
>
> Do not touch what `senderMode` MEANS. `'trusted'` still skips recovery and still refuses to work unless the node was created in that mode.
