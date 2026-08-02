---
title: review-gate non-blocking nits for 'value-bearing-conformance-steps-assert-the-failure-shape' (Gate 2 approve)
date: 2026-08-02
status: open
reviewOf: value-bearing-conformance-steps-assert-the-failure-shape
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'value-bearing-conformance-steps-assert-the-failure-shape' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The PR/commit description carries no '## Decisions' block, so the in-scope choices below were made unrecorded. Please ratify them explicitly: the new shared helper module, the callee-answer tolerance, and the hand-pinned seam probe.
  (git log -1 body is a single subject line; no Decisions section anywhere in the diff.)
- Ratify the new shared test seam: test/helpers/affordability.ts now owns the outcome vocabulary (OK / REJECTED / describeReadFailure) for BOTH the conformance battery and the revm-engine checks, and REJECTED's human-readable string is what mismatch reports compare against. Is a third test helper the right home, versus keeping each bar self-contained?
  (packages/embedded-eth-node/test/helpers/affordability.ts, imported by conformance.ts and revm-engine.ts.)
- isCalleeAnswer() classifies return data that names a shortfall of funds as ENGINE text rather than a callee answer, so a contract whose revert reason happens to say e.g. insufficient funds would be accepted as an affordability rejection. Intended tolerance for revm echoing its message as return data, or too wide?
  (affordability.ts isCalleeAnswer -> !namesLackOfFunds; near-miss controls cover 'ERC20: transfer amount exceeds balance' and 'ERC20: insufficient allowance' but not a reason naming both lack and funds.)
- At the node layer a failure with code 3 and EMPTY return data still classifies as REJECTED, so a callee reverting with no data would satisfy a negative case. The issued negative control only covers revert-WITH-data. Worth a second control (bare REVERT 0,0) or is the wei-exact boundary considered sufficient cover?
  (describeReadFailure returns REJECTED for code 3 + empty data; controls in conformance.ts step 14 are a malformed sender and 0x60ff5f5360015ffd.)
- The seam probe builds engines outside createNode and hand-pins hardfork cancun plus stateMode none. If the node's pinned fork moves, the probe silently measures a different fork than the node it claims to mirror. Should the fork be derived from the node/common the node uses?
  (revm-engine.ts valueReadAtSeam: seamCommon with hardfork 'cancun', comment claims 'the fork the node pins'.)
- The negative-control bytecode uses PUSH0 (0x5f), so step 14 now silently requires Shanghai+. The battery is cancun-pinned today, but berlin/london/paris were just re-admitted elsewhere; if the battery is ever run per-fork this control becomes an invalid opcode and would misreport. Worth a PUSH0-free encoding?
  (REVERT_WITH_REASON_CODE = 0x60ff5f5360015ffd in conformance.ts; runBattery is only called unparameterised today.)
