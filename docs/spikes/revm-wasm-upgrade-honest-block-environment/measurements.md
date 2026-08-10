# What each `revm-wasm` simulation switch actually buys the read path

Measured 2026-08-02 against `revm-wasm@0.3.0` (revm 42.0.1), by `./probe-simulation-switches.mjs` in this folder. Re-run it (`node docs/spikes/revm-wasm-upgrade-honest-block-environment/probe-simulation-switches.mjs`) if the package moves; every number below is that script's output, not a summary of it.

The shape probed is the node's own read: the block carries a REAL base fee (7 gwei), and the call carries NO gas price, because `ReadCallRequest` has no such field, so revm sees 0.

## `disableBaseFee` is load-bearing

Unfunded caller, `value: 0`, `disableBalanceCheck: false`:

| `disableBaseFee` | outcome |
| --- | --- |
| `false` | `validation-error`, `Transaction(GasPriceLessThanBasefee)` |
| `true` | `success` |

A read priced at 0 against a block whose base fee is not 0 is rejected without it. This is the switch that replaced the zeroed base fee.

## `disableBalanceCheck` is NOT load-bearing, and is harmful

With `disableBaseFee: true` throughout:

| caller | `value` | `disableBalanceCheck: false` | `disableBalanceCheck: true` |
| --- | --- | --- | --- |
| unfunded (balance 0) | 0 | `success` | `success` |
| unfunded (balance 0) | 1 wei | `validation-error`, `LackOfFundForMaxFee { fee: 1, balance: 0 }` | `success` |
| funded (1e24 wei) | 0 | `success` | `success` |
| funded (1e24 wei) | 1 wei | `success` | `success` |
| funded (1e24 wei) | balance + 1 | `validation-error`, `LackOfFundForMaxFee { fee: 1000000000000000000000001, balance: 1000000000000000000000000 }` | `success` |
| caller holding code | 0 | `success` | `success` |

Two things are visible in the `fee:` field of those errors, and both matter:

1. **The demand is exactly `value`.** revm checks `balance >= gasLimit * gasPrice + value`; the read's gas price is 0, so the term collapses. That is why the zero-value row already passes with the switch OFF: the case the flag was taken for (an `eth_call` defaults `from` to the zero address, which holds no ether) never needed it once `disableBaseFee` existed.
2. **The only rows the switch changes are the ones that must fail.** An unaffordable transfer is not a transaction-validity technicality a simulation should wave through: geth's `eth_call` skips the account and gas-fee checks and still fails the transfer with `ErrInsufficientBalance`, and `@ethereumjs/evm` agrees (`_reduceSenderBalance` throws `insufficient balance`, `evm.js:1249`). So `disableBalanceCheck: true` makes revm answer a transfer the chain could never make, and disagree with the default engine while doing it.

`revm-wasm`'s own `dist/types.d.ts` says as much about the switch: it "raises the caller's post-deduction balance to at least `value`", which is why the package refuses to combine it with committing.

**Conclusion, and what shipped:** the read path takes `disableBaseFee`, `disableBlockGasLimit` and `disableEip3607`, and deliberately does NOT take `disableBalanceCheck`. The reasoning lives at the code site: the `AND THE ONE THAT IS DELIBERATELY NOT SET: disableBalanceCheck` block in the comment above the read path's option object in `packages/embedded-eth-node/src/revm.ts`. The capture-bucket note that first carried it (decision 6) was ratified by the maintainer and discharged by deletion in commit `38e0164` (`work/protocol/WORK-CONTRACT.md`: a note leaves its bucket by deletion, and git history is the archive), and that commit names this call site as where the decision now lives.

The `caller holding code` row is included as the control for `disableEip3607`: it succeeds in every column here only because that switch is on for all of them. With it off the same call returns `validation-error` carrying `Transaction(RejectCallerWithCode)`.
