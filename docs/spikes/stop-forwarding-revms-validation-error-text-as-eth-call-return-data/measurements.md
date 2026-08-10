# How a revm VALIDATION rejection differs from an execution REVERT

Taken 2026-08-10 against `revm-wasm@0.3.1`, node 22, with
`node docs/spikes/stop-forwarding-revms-validation-error-text-as-eth-call-return-data/probe-validation-vs-revert.mjs`
(the probe next to this file). Every call uses the read shape `src/revm.ts`'s `call` builds: a real base fee, no gas price, `disableBaseFee` + `disableBlockGasLimit` + `disableEip3607`, `returnState: false`.

The question: `embedded-eth-node/revm` forwarded `outcome.returnData` verbatim, so an unaffordable `eth_call` came back as `RpcError(3, 'execution reverted', '0x5472616e…')` whose data decodes to revm's own error text, where the default `@ethereumjs/evm` engine returns `0x`. To stop that WITHOUT swallowing a contract's real revert payload, the two cases have to be told apart by something structural.

| case | `status` | `totalGasSpent` | `error` defined | `returnData` |
| --- | --- | --- | --- | --- |
| success | `success` | 21016 | no | `0x…2a` (the callee's answer) |
| revert WITH data | `revert` | 21016 | no | `0xff` (the callee's bytes) |
| revert with NO data | `revert` | 21004 | no | `0x` |
| halt (invalid opcode) | `halt` | 30021000 | no | `0x` |
| halt (out of gas) | `halt` | 21002 | no | `0x` |
| validation: value > balance | `validation-error` | 0 | yes | `Transaction(LackOfFundForMaxFee { fee: 1000000000000000001, balance: 1000000000000000000 })` as UTF-8 |
| validation: value > balance, callee reverts with data | `validation-error` | 0 | yes | the same text (the callee never ran) |
| validation: gas below intrinsic | `validation-error` | 0 | yes | `Transaction(CallGasCostMoreThanGasLimit { initial_gas: 21000, gas_limit: 20999 })` as UTF-8 |

## What this settles

1. **The discriminator is `outcome.status === 'validation-error'`, and it is revm's own.** No message matching is needed and none is used: `status` is a field of the outcome blob (`u8` at offset 0, fixed across every version of the format), and `outcome.error` is populated by `revm-wasm`'s decoder for that status and no other. The fix keys off `status`; the message is quoted into the seam result's `error`, never parsed.
2. **A rejection has no callee bytes to lose.** `totalGasSpent` is 0 and nothing executed, so dropping `returnData` for `validation-error` cannot swallow an answer: the last row but one is the proof, a callee that WOULD have reverted with `0xff` contributes nothing because the transfer was refused first.
3. **A revert keeps its bytes.** `revert` carries the callee's own payload and is untouched by the change; `revert` with no data and both `halt` cases already returned `0x`, matching the default engine.
4. **Rejections are a FAMILY, not one message.** The gas-below-intrinsic row is a second `InvalidTransaction` variant reaching the same slot, which is why the engine drops the bytes for the STATUS rather than for the one string an affordability test happens to know.
