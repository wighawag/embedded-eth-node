---
title: review-gate non-blocking nits for 'the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao' (Gate 2 approve)
date: 2026-08-11
status: open
reviewOf: the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the primary route: REPORT the values rather than document the omission. eth_getBlockByNumber/ByHash now return the block's real miner and mixHash (a new key that did not exist before) and a real logsBloom, shipped as a minor changeset. Tooling that read a constant-zero miner or an all-zero bloom sees different bytes.
  (src/node.ts blockToRpc; .changeset/the-rpc-block-reports-the-block-it-ran.md; decisions note item 1)
- Ratify the persistence-format call: SerializedState.version stays 1 and the three fields are optional. Note the sharper half: an OLD dump's absent logsBloom is REBUILT from its receipts rather than defaulted to zero, so the same dump answers differently under the new code. Absent miner/mixHash read as zero. Verified: dumpState pushes sb.header directly, so the fields ride along with no adapter change.
  (src/types.ts SerializedState doc; src/node.ts loadState bloom rebuild; decisions note item 2)
- Ratify the genesis scope: block 0 now takes only blockEnv.coinbase and prevRandao, not number/timestamp/gasLimit. Consequence to accept: the genesis HASH changes for any node configured with either field. Verified harmless for unconfigured nodes, since the added difficulty: 0n matches ethereumjs's own default.
  (src/node.ts genesis createBlock; @ethereumjs/block header defaults difficulty BIGINT_0)
- Ratify a disposition that differs from the task text: the task said the loadState reconstructed-block-hash question, if something depends on it, gets its own note and not a silent fix. Something does depend on it (next block's parentHash and BLOCKHASH via mockBlockchain) and it was FIXED here instead of noted. It is not silent (stated at the code site, in the changeset, and asserted through the RPC), and the fix falls out of the mandated restore, but the human should confirm no separate note is wanted.
  (src/node.ts loadState invariant comment; test/helpers/rpc-block.ts chainContinuesAfterReload; task acceptance line on the loadState block-hash question)
- Ratify two smaller calls: the new rpc-block suite is deliberately NOT engine-parameterised (no revm twin, on the grounds that block construction and the RPC layer are the node's on every engine), and the default entry bundle baseline is re-pinned 422.0 to 422.5 KB raw / 127.4 to 127.6 KB gzip for bloomOfReceipts plus the three fields.
  (test/helpers/rpc-block.ts header; packages/benchmarks/test/evm.spec.ts DEFAULT_ENTRY_BASELINE; decisions note item 5)
- Small claim-vs-reality slip in the decisions note: it says the change touches packages/embedded-eth-node/README.md, but that file does not exist. The README that was edited is the repo-root README.md. Worth correcting so a later reader does not chase a ghost path.
  (work/notes/observations/decisions-the-rpc-block-...-2026-08-11.md item 1; packages/embedded-eth-node/ contains only CHANGELOG.md)
