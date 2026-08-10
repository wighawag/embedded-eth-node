# Probe: does the suite actually CATCH an engine that recovers its own sender?

Date: 2026-08-10. Task: `trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender`.

A test that asserts the right thing on correct code proves nothing about what it would say on wrong code, and the failure mode here is SILENT: an engine that recovers the sender from the signature instead of using `TransactionRequest.sender` charges a different account, advances a different nonce, commits, and returns a receipt that looks right. So both engine paths were perturbed — one line each — and the suite re-run. Re-runnable at any time; the perturbations are one-line reversible edits, nothing is committed in this state.

## The two perturbations

| # | Engine | Edit | File |
|---|---|---|---|
| 1 | `embedded-eth-node/revm` | `const sender = request.sender.bytes;` → `const sender = request.tx.getSenderAddress().bytes;` | `packages/embedded-eth-node/src/revm.ts` (in `transact`) |
| 2 | default `@ethereumjs/evm` | `tx: asSender(request.tx, request.sender),` → `tx: request.tx,` | `packages/embedded-eth-node/src/engine.ts` (in `transact`) |

Each is precisely "an engine that recovers its own sender", which is what a third-party engine would do by default (`runTx` and revm's `recoverSigner` both offer it).

## What happened

Perturbation 1, `pnpm exec playwright test test/revm-trusted-sender.spec.ts --project=chromium`:

```
[revm-trusted-sender] errors: []
  ✘ test/revm-trusted-sender.spec.ts › senderMode:'trusted' on the revm engine: the CLAIMED sender is the sender
+   "claimed-sender: claimed sender balance delta 0 != -(value+gasUsed*effectiveGasPrice) -55496000000000",
+   "claimed-sender: claimed sender nonce 0 -> 0 (expected +1)",
+   "claimed-sender: the SIGNER was charged: balance delta -55496000000000 != 0",
+   "claimed-sender: the SIGNER's nonce advanced: 0 -> 1",
```

Perturbation 2, `pnpm exec playwright test test/trusted-sender.spec.ts --project=chromium`: the same four mismatches, on the default engine.

Note `errors: []` and a `0x1` receipt naming the claimed sender in both cases: **nothing threw**. The four mismatches are the only signal, and all four come from reading the post-state.

## Why the fixture had to change to get this

The check originally signed with the suite's main account (seven transactions in, nonce 7) while claiming an address at nonce 0. Under perturbation 1 that DOES fail — but with a revm `NonceTooLow`, i.e. loudly, by luck of the fixture. A third-party engine on a fresh node would not be so kind. So the claimed-sender transaction is now signed by a dedicated account (`FABRICATING_SIGNER` in `test/helpers/trusted-sender.ts`) which is funded and at the SAME nonce as the claimed sender: a re-recovering engine then passes every validity check and the divergence is visible only in who paid. The suite asserts that precondition too (equal nonces, signer solvent), so a later edit that broke the symmetry reports "lost its power" instead of quietly ceasing to catch anything.
