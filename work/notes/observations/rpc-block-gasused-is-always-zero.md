---
title: The RPC block header's gasUsed is always 0x0, even for a block that mined transactions
date: 2026-08-11
status: open
---

Noticed while making `miner` / `mixHash` / `logsBloom` real (`the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao`): `executeAndMine` creates the block header BEFORE executing its transactions, so `block.header.gasUsed` is 0, `storeBlock` records that 0 into `SerializedBlock.gasUsed`, and `eth_getBlockByNumber` reports `gasUsed: "0x0"` for every block — including one whose receipts show real gas. The running `cumulativeGasUsed` that would be the right value is computed a few lines away in the same function and thrown away. Same defect class as the three fields that task fixed (a header field reporting a value the block does not have), left alone because it was not in its scope; it is now at least STATED in the README's `eth_getBlockByNumber` row. Note that closing it is not free: the header is frozen at creation, so the honest value has to be recorded into `SerializedBlock` rather than onto the block object, and the block HASH would then either stop matching the header it is built from or have to be recomputed — see the round-trip invariant comment in `loadState`.
