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
instead — `disableBaseFee`, `disableBalanceCheck`, `disableBlockGasLimit`,
`disableEip3607`.

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

The differential conformance battery grew a block-environment step that reads
those opcodes THROUGH A CONTRACT and diffs them, in both state modes and on both
engines: gas is identical either way, so no gas gate could ever have caught this
class of bug.
