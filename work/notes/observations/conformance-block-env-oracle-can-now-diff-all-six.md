---
title: The conformance block-environment step can now diff all six values against the node's own block
date: 2026-08-11
status: open
---

`the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao` made `eth_getBlockByNumber` report a real `miner` and `mixHash`, which removes the reason step 16 (`block environment through a contract`, `packages/embedded-eth-node/test/helpers/conformance.ts`) diffs four of its six values against `head` and the other two (`COINBASE`, `PREVRANDAO`) against `BLOCK_ENV_COINBASE` / `BLOCK_ENV_PREV_RANDAO`: the RPC block reported neither, so the configuration was the only statement of what the block was. All six could now be diffed against the node's own block, which would also let the `conformance differential` entry in `CONTEXT.md` stop describing a split. Deliberately NOT done as part of that task, because swapping an oracle changes what the step can catch (a node that reported its own wrong value to both the contract and the RPC would agree with itself) and that is a decision with its own reasoning, not a cleanup.
