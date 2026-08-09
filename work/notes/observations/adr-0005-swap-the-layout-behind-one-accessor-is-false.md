---
title: ADR 0005's "swap the flat map behind that one accessor" is measurably false, and the failure is silent
date: 2026-08-09
status: open
---

Measured while running `spike-storage-layout-cost-for-the-revm-write-half`: `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md` says a `Map<account, Map<slot, value>>` layout can be swapped in "behind that one accessor, and only the accessor changes" (its `clearStorage` later section), and section 4 of `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/probe-transaction-shape.mjs` demonstrates otherwise against the SHIPPED readers: `assertStackShape` passes, `SimpleStateManagerStore.getStorage` answers "zero" for a slot holding `0x2a` with no throw, and `dumpState`'s `'none'` branch dumps no storage at all. Left as-is here because superseding the ADR belongs to whatever task actually re-layers storage; the full nine-site blast radius is in that spike's `measurements.md`.
