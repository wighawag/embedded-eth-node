---
title: review-gate non-blocking nits for 'revm-state-store-packed-storage-keys' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: revm-state-store-packed-storage-keys
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'revm-state-store-packed-storage-keys' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- ADR 0009's amendment and storage-keys.ts both say a non-fixed-width key is NORMALISED by left-padding and that throwing was deliberately rejected, but setLengthLeft has no allowTruncate here, so a key LONGER than the width throws (Input length N exceeds target length 32). An over-long slot key in a hand-made loadState payload used to be hex-encoded harmlessly and is now a refusal, surfaced as an @ethereumjs/util error rather than the node's own error. Ratify the new refusal or correct the two docs.
  (packages/embedded-eth-node/src/storage-keys.ts:90,107 (setLengthLeft) vs node_modules @ethereumjs/util setLength: throws when msg.length > length; ADR 0009 amendment bullet 2)
- In-scope decision to ratify: short slot keys are now left-padded, so a hand-made loadState payload with a short slot key lands on the padded slot, where bytesToHex previously made it a distinct unreachable key. Behaviour change on the DEFAULT engine's async route too, not just revm. Recorded in ADR 0009, not specified by the task.
  (src/state-manager.ts getStorage/putStorage now packSlotKey(key); node.ts:1447 loadState passes hexToBytes(slot) unpadded)
- In-scope decision to ratify: the default entry's bundle baseline is re-pinned 421.1 -> 421.9 KB raw / 127.1 -> 127.4 KB gzip, i.e. JS-only consumers pay 0.8 KB for a win that mainly benefits revm. Recorded in the changeset and the evm.spec comment; the task did not authorise a size increase.
  (packages/benchmarks/test/evm.spec.ts DEFAULT_ENTRY_BASELINE)
- In-scope decision to ratify: the exported type aliases AddressKey / SlotKey are removed in favour of PackedAddressKey / PackedSlotKey / HexKey, and liveStorage() is re-typed to HexKey, shipped as a patch changeset. Defensible because there is no ./state-manager export subpath, but it is a deep-import break.
  (src/state-manager.ts; package.json exports has only ., ./revm, ./worker-entry, ./worker-client)
- In-scope decision to ratify: the memoised AccountStorageView / #storageViews seam was deleted as part of this change, beyond the key encoding itself. It is credited with part of the measured win and the removed seam's own comment said the encoding replaces exactly it, so this looks right; just not something the task spelled out.
  (src/revm-state-store.ts, AccountStorageView block removed; measurements.md 'Why the shipped version beats the prototype')
- Coverage nit: the fixed-width normalisation branch (a key that is not exactly 20 / 32 bytes) has no direct test. The aliasing hazard the module header calls load-bearing is only exercised for full-width keys via the neighbouring-slot and neighbouring-address probes.
  (no test/storage-keys unit spec; test/helpers/storage-keys.ts probes are all 32-byte slots)
- No '## Decisions' block was found in the commit message or any PR body in this clone; the decisions above are instead recorded in ADR 0009's amendment, the changeset and measurements.md. Confirm the block exists on the PR, or accept those homes as the record.
  (git log -1 --format=%B shows a single subject line only)
