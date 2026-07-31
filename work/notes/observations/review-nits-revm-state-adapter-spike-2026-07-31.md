---
title: review-gate non-blocking nits for 'revm-state-adapter-spike' (Gate 2 approve)
date: 2026-07-31
status: open
reviewOf: revm-state-adapter-spike
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-state-adapter-spike' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The adapter reaches the three stacks through (this.#sm as any).accountStack, but the ADR's stated mitigation is that an ethereumjs rename would be a TypeScript error (the good case). The fields are public in @ethereumjs/statemanager 10.1.2, so the cast is unnecessary and removes exactly the safety net the ADR sells. Ratify dropping the cast when revm-engine-subpath lifts this file.
  (docs/spikes/revm-state-adapter-spike/simple-state-store.ts get #accounts/#code/#storage vs ADR 0005 section What it costs)
- Unrecorded cross-task decision to ratify: the ADR tells the engine seam NOT to wrap the revm path in checkpoint/revert. The parallel task engine-seam-with-ethereumjs-default defines the checkpointing pure-read helper AS the seam, so unless that task or revm-engine-subpath is updated the revm path silently keeps the O(state) checkpoint and the measured saving disappears.
  (ADR 0005 last Consequences bullet vs work/tasks/ready/engine-seam-with-ethereumjs-default.md lines 47-49)
- Unrecorded user-visible default to ratify: getBlockHash is delegated to an optional injected callback and returns undefined when none is supplied, so BLOCKHASH answers nothing even though the node has blocks. Neither the ADR nor the README mentions it, so revm-engine-subpath could ship it unwired.
  (simple-state-store.ts getBlockHash + SimpleStateStoreOptions.blockHash)
- The codeHash index rebuilds on every MISS with a full clear plus one keccak per code blob, and there is no negative caching, so a hash that is genuinely absent (for example an account whose codeHash has no code in the map) re-scans the whole code map on every read. The ADR states the cost as nothing on a hit and one keccak per newly-observed contract, which omits the persistent-miss case.
  (simple-state-store.ts #reindexCode + ADR 0005 section The codeHash to code index)
- Harness section 6's frozen-index stub returns undefined for ALL code rather than serving a snapshot taken before the new deploy, so it demonstrates that a code MISS is silently successful rather than literally that a never-rebuilt index goes stale. The conclusion the ADR draws still holds, but the PASS label overstates the fidelity of the simulation.
  (docs/spikes/revm-state-adapter-spike/harness.ts frozenIndexStore getCode: () => undefined)
- The ADR prescribes exposing storage behind a per-account accessor (storageOf) so the write half can swap the flat map later, but the landed adapter builds the flat key inline in getStorage via slotKey. The artifact the ADR says revm-engine-subpath should lift does not embody its own recommendation.
  (ADR 0005 section clearStorage later vs simple-state-store.ts getStorage/slotKey)
- No Decisions block exists anywhere (both feat commit bodies are empty), so the four in-scope decisions above had to be reverse-engineered from the ADR and the code. Ratify them explicitly before revm-engine-subpath is re-cut.
  (git log 29730d2..HEAD, commits 0f46419 and 06f1c4b carry subject lines only)
