---
title: revm's commit re-deposits the callee's code on every transaction that merely CALLS it
date: 2026-08-11
status: open
---

Noticed while counting host callbacks for `measure-what-transactions-on-revm-actually-cost`: every transaction to an EXISTING contract causes one `setCode(codeHash, code)` write callback plus the `#code.set(address, code)` it triggers inside the next `setAccount` (`src/revm-state-store.ts`), even though the bytes are identical to the ones already in the node's code map and nothing deployed anything. Measured per transaction: the 3-SSTORE shape does `setAccount` 3, `setCode` 1, `setStorage` 3, and the 256-cold-SLOAD shape does `setAccount` 3, `setCode` 1 and no storage writes at all (`docs/spikes/measure-what-transactions-on-revm-actually-cost/measurements.md`, section 3). It costs one Map write out of four to seven, i.e. nothing measurable, and it is correct — the key IS the content hash — so this is a redundancy rather than a bug. Left alone, being outside that task; worth a look only if the code map ever becomes something more expensive to write than a `Map`.
