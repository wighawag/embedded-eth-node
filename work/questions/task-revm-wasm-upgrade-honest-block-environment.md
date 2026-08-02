<!-- dorfl-sidecar: item=task:revm-wasm-upgrade-honest-block-environment type=task slug=revm-wasm-upgrade-honest-block-environment allAnswered=true -->

## Q1

**'task:revm-wasm-upgrade-honest-block-environment' was bounced — how should we proceed?**

> PR/code review (Gate 2) blocked this work:
> - disableBalanceCheck introduces a NEW cross-engine divergence for value-bearing reads: an eth_call carrying a non-zero value from a sender that cannot afford it now SUCCEEDS on revm (revm raises the caller balance to at least value) while the default engine still fails it. Before this change revm rejected the same call with LackOfFundForMaxFee, so both engines agreed. Is this accepted (and then recorded in the README caveats + the decisions note, since the task's promise is that no known divergence remains), or should the read path guard it? (packages/embedded-eth-node/src/revm.ts:231 sets disableBalanceCheck:true; node.ts evmCall forwards params.value verbatim; revm-wasm dist/types.d.ts on disableBalanceCheck says it fabricates the caller balance in the result; @ethereumjs/evm dist/esm/evm.js _reduceSenderBalance captures the insufficient-balance error into execResult.exceptionError, which node.ts turns into execution reverted. The likely shape is a payable preview with no from, i.e. the zero address. No battery step or engine test calls with a value, so nothing catches it.)
> PR/code review (Gate 2) did not reach a unanimous approve across reviewMaxRounds=2 round(s) (a block is terminal and is never re-rolled); forcing needs-attention (never silently merged or looped).

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

GUARD THE READ PATH. Do not accept the divergence, and do not merely document it.

The Gate-2 finding is correct and I have confirmed it independently: `revm-wasm@0.3.0`'s own `dist/types.d.ts` says `disableBalanceCheck` "raises the caller's post-deduction balance to at least `value`", and the read path forwards `value` verbatim (`node.ts` evmCall -> `revm.ts` `common.value = request.value`). So a value-bearing `eth_call` from a sender that cannot afford it now succeeds on revm while `@ethereumjs/evm` still fails it.

Why "accept and record" is the WRONG branch of your question. This task's headline promise is that it "closes EVERY known behavioural divergence" and that afterwards "there should be NO known behavioural difference between the two engines". Accepting a brand-new divergence introduced BY that change contradicts the deliverable. It also repeats precisely the sin the task exists to delete: the zeroed base fee was rejected because it is "a lie a contract can observe", and fabricating the caller's balance is the same class of lie. And the default engine is the correct reference here, not revm: geth's `eth_call` skips the account and gas-fee checks but still fails the value transfer itself with `ErrInsufficientBalance`, so `@ethereumjs/evm`'s behaviour matches real clients and revm is the engine that must be brought back into line.

THE INVARIANT TO RESTORE: a read carrying `value` must SUCCEED or FAIL identically on both engines, for a funded sender and an unfunded one alike.

THE LIKELY FIX, but verify it by probing revm rather than trusting this note. The read sets no `gasPrice`, so it is 0, and with `disableBaseFee` the balance revm demands reduces to exactly `value`. That means the zero-value case which justified the flag (an `eth_call` defaults `from` to the zero address, which holds no ether) ALREADY passes with the flag OFF, and the flag is load-bearing only in the `value > 0` case that is exactly the one which must fail. Probe it directly, then scope the flag to what it genuinely buys: dropping `disableBalanceCheck` entirely, or setting it only when `request.value === 0n`, both look correct if the probe agrees. Do NOT pre-fund the caller: that invents state a read must not invent. If the probe CONTRADICTS this analysis (for instance revm still demands funds at a zero gas price), keep the flag where it is genuinely needed, constrain the value path instead, and record what you actually measured.

PROVE IT IN A TEST, because nothing currently catches this: no battery step or engine test calls with a value. Add a cross-engine assertion covering value-bearing reads from BOTH a funded and an unfunded sender, so the differential owns this the way it now owns the block environment.

KEEP EVERYTHING ELSE. The rest of the branch is correct and reviewed: the block-environment conformance step, `BlockEnvProbe.sol`, the `prevRandao` wiring, the real base fee, and `disableBaseFee` / `disableBlockGasLimit` / `disableEip3607` all stay as they are. Continue from the existing `work/task-revm-wasm-upgrade-honest-block-environment` branch; this is a scoped fix on top of good work, not a restart.

CONSTRAINTS THAT STILL BIND. The criterion "an `eth_call` from an address holding no ether still works" must not regress. Reference gas is unchanged and must stay so: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`. Update the README caveats and the decisions record if the final shape of the flag differs from what they now describe. If the bundle-size assertion in `packages/benchmarks/test/evm.spec.ts` fires, follow its failure message: re-pin the baseline in the SAME change and say why in the comment block above it; never raise it silently.
