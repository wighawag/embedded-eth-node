<!-- dorfl-sidecar: item=task:revm-wasm-upgrade-honest-block-environment type=task slug=revm-wasm-upgrade-honest-block-environment allAnswered=false -->

## Q1

**'task:revm-wasm-upgrade-honest-block-environment' was bounced — how should we proceed?**

> PR/code review (Gate 2) blocked this work:
> - disableBalanceCheck introduces a NEW cross-engine divergence for value-bearing reads: an eth_call carrying a non-zero value from a sender that cannot afford it now SUCCEEDS on revm (revm raises the caller balance to at least value) while the default engine still fails it. Before this change revm rejected the same call with LackOfFundForMaxFee, so both engines agreed. Is this accepted (and then recorded in the README caveats + the decisions note, since the task's promise is that no known divergence remains), or should the read path guard it? (packages/embedded-eth-node/src/revm.ts:231 sets disableBalanceCheck:true; node.ts evmCall forwards params.value verbatim; revm-wasm dist/types.d.ts on disableBalanceCheck says it fabricates the caller balance in the result; @ethereumjs/evm dist/esm/evm.js _reduceSenderBalance captures the insufficient-balance error into execResult.exceptionError, which node.ts turns into execution reverted. The likely shape is a payable preview with no from, i.e. the zero address. No battery step or engine test calls with a value, so nothing catches it.)
> PR/code review (Gate 2) did not reach a unanimous approve across reviewMaxRounds=2 round(s) (a block is terminal and is never re-rolled); forcing needs-attention (never silently merged or looped).

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
