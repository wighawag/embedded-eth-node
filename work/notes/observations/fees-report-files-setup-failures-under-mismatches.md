---
title: The fees report files setup failures under "mismatches", which means cross-engine disagreement
date: 2026-08-10
status: open
---

Raised by Gate 2 on `fees-refunds-and-effective-gas-price-come-from-the-engine` and kept as a signal rather than tasked, because it only misleads on a RED run.

In `packages/embedded-eth-node/test/helpers/fees.ts` the refund-clearing setup guards (the slot was already zero, the slot was never cleared) push into `mismatches`, whose type documents it as every case or field the two engines disagreed about. A setup that did not establish its precondition is not a disagreement between engines, so a failing run reports it under the wrong vocabulary and points a reader at a cross-engine bug that is not there.

A separate `setupFailures` (or `violations`) field would read truthfully. The run goes red either way, so nothing is missed today; only the diagnosis is misdirected. Whoever next edits that helper should take it.
