---
'embedded-eth-node': minor
---

The revm read engine now runs reads against the node's REAL block environment,
on `revm-wasm@^0.3.0`.

`BASEFEE` inside an `eth_call` used to read `0` on `embedded-eth-node/revm` and
the block's real value on the default `@ethereumjs/evm` engine: the zeroed base
fee was the only way to keep a read from an unfunded address (`from` defaults to
the zero address) from failing revm's transaction validation. `revm-wasm` now
exposes the switches every real client uses to serve `eth_call`, so the engine
passes the node's own base fee and `prevRandao` and turns the VALIDITY RULES off
instead: `disableBaseFee`, `disableBlockGasLimit`, `disableEip3607`.

Observable consequences, all of them removing a divergence between the two
engines:

- `BASEFEE` and `PREVRANDAO` inside a read now report the node's block on revm,
  as they always did on the default engine (`COINBASE`, `NUMBER`, `TIMESTAMP`
  and `GASLIMIT` already did).
- `eth_call` / `eth_estimateGas` with `from` set to an address that HOLDS CODE
  now succeeds on revm (EIP-3607 is a rule about sending a transaction;
  `@ethereumjs/evm`'s `runCall` never enforced it). Smart-account, ERC-4337 and
  multicall-aggregator previews work on either engine.
- A read's gas budget is no longer capped at the block gas limit on revm, so a
  call needing within intrinsic gas of the whole block limit no longer runs out
  of gas on one engine and completes on the other.
- A read from an address holding no ether keeps working, which is what the
  zeroed base fee was buying.

What is relaxed is a transaction's VALIDITY, never the VALUE TRANSFER: revm's
`disableBalanceCheck` is deliberately left off, so an `eth_call` carrying more
ether than the sender holds still fails on either engine, as it does on geth
(`ErrInsufficientBalance`). A read never invents funds it can then report.

The differential conformance battery grew two steps for the two divergences no
gas bar can see: one that reads the block-environment opcodes THROUGH A CONTRACT
and diffs them (gas is identical either way), and one that pins whether a
value-bearing read succeeds or fails per sender (a rejected read charges no gas
at all). Both run in both state modes and on both engines.
