---
title: A trusted-sender transaction runs on the write engine AS THE CLAIMED SENDER, not as a recovered one
slug: trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender
spec: revm-engine-behind-runtx
blockedBy: [revm-executes-the-first-transaction-with-commit]
covers: []
---

## What to build

The spec's Solution names the `evm_*As` trusted-sender variants as executing on the installed engine, and until this task nothing delivered or verified that. It is the most dangerous gap in the set, because getting it wrong is SILENT: the transaction executes as a different address, commits, and returns a completely plausible receipt.

`senderMode:'trusted'` exists so a caller who already knows the sender can skip ecrecover, which is a fixed multi-millisecond cost per transaction. The way the node currently pins the sender is a trick that depends on the old execution path: it shadows `getSenderAddress()` on the `@ethereumjs/tx` INSTANCE it is about to run, which works only because `runTx` reads the sender through exactly that one call. Once transactions cross an engine seam, that assumption is gone. An engine that recovers the sender itself, or a seam that hands the engine a transaction object and lets it decide, will execute a fabricated-signature transaction as whatever address the signature happens to recover to, charge that account, and write a receipt naming it.

So the sender must cross the seam EXPLICITLY, as a value in the request, not as a property of an object the engine is trusted to interrogate the same way `runTx` did. Make that structural rather than documented: if an engine cannot execute a transaction on behalf of a stated sender, it must be unable to compile against the seam, not merely discouraged from re-recovering.

Cover both modes on both engines, because the interesting assertion is a DIFFERENCE:

- In `'trusted'` mode, a transaction submitted through the `evm_*As` variants executes as the CLAIMED sender, charges that account, and produces a receipt naming it, on the revm engine exactly as on the default one, INCLUDING when the signature does not recover to that address (which is the whole point of the mode, and the case where a re-recovering engine diverges silently).
- In `'recover'` mode, the same transaction executes as the RECOVERED sender, and the `evm_*As` methods are refused with the existing error.

The existing trusted-sender suite never installs an engine, so it cannot catch any of this today. Parameterise it the way the conformance battery was parameterised for revm, rather than writing a second suite beside it.

## Acceptance criteria

- [ ] The sender crosses the engine seam as an explicit value; no engine can determine the sender itself, and the instance-shadowing trick is gone from the transaction path rather than left as a second mechanism.
- [ ] In `senderMode:'trusted'`, an `evm_*As` transaction executes as the claimed sender on the revm engine and on the default engine identically: the same account is charged, the same nonce advances, and the receipt names the same `from`.
- [ ] The case where the signature does NOT recover to the claimed sender is covered explicitly, since that is the case a re-recovering engine gets wrong while looking correct.
- [ ] In `senderMode:'recover'`, the `evm_*As` methods are still refused with the existing message, and an ordinary transaction still executes as the recovered sender on both engines.
- [ ] The existing trusted-sender suite is PARAMETERISED by engine rather than duplicated, following the precedent set when the conformance battery was pointed at revm.
- [ ] Post-state after a trusted-sender transaction matches between engines: balances, nonces and storage.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.

## Blocked by

- `revm-executes-the-first-transaction-with-commit` — the seam's transaction request and the revm engine's execution of it must exist before the sender's journey across them can be pinned.

## Prompt

> Goal: make a trusted-sender transaction execute as the CLAIMED sender on any engine, and prove it, including in the case where the signature says otherwise.
>
> FIRST, check this task against current reality: it was written on 2026-08-09 and may have DRIFTED. Read how the node pins a trusted sender today and confirm it still does it by shadowing a method on the transaction instance; if the seam work already made the sender explicit, this task narrows to the assertions.
>
> Read the `evm_*As` cheat methods and their refusal when the node is not in `'trusted'` mode, `docs/adr/0002-trusted-sender-is-a-primitive-impersonation-is-not-our-job.md`, the trusted-sender test helper (which never installs an engine, and is why nothing catches this today), and the engine seam's transaction request.
>
> THE FAILURE IS SILENT, which is what makes it worth a task of its own. A re-recovering engine does not throw: it charges a different account, advances a different nonce, and hands back a receipt that looks right. The only assertion that catches it is one where the claimed sender and the recoverable sender DIFFER, so write that one first and make sure it fails before you make it pass.
>
> Do not weaken what `'trusted'` means or when it is allowed. It stays opt-in at node construction and the cheat methods stay refused outside it; ADR 0002 explains why that boundary is where it is.
>
> Done means: the sender is a value the seam carries, not a behaviour an engine is trusted to reproduce, and both engines agree on who sent the transaction even when the signature disagrees.
