---
'embedded-eth-node': minor
---

The revm read engine admits only the hardforks it can COST: `prague` and `osaka` are now refused.

`embedded-eth-node/revm` mapped seven hardfork names onto revm specs, but the
node's shared intrinsic-gas arithmetic (`src/intrinsic-gas.ts`) implements the
pre-Prague formula only, and revm enforces more than that from Prague onwards.
Measured against `revm-wasm@0.3.0`, a call carrying 100 non-zero calldata bytes
costs the node's arithmetic 22600 while revm demands EIP-7623's floor of 25000
and rejects the difference outright with `GasFloorMoreThanGasLimit`. That is the
`eth_estimateGas` failure this node exists to prevent: a client uses an estimate
as the transaction's gas LIMIT, so an under-estimate is not a warning, it is an
out-of-gas transaction.

Osaka fails a second, independent way — EIP-7825 caps a transaction's gas limit
at 16777216, below the node's default read budget of 30000000, so every ordinary
`eth_call` there is rejected before the first opcode.

So `createRevmEngine()` now refuses those two forks at construction, naming the
EIP, the file that would have to change, and the ADR, exactly as it already
refuses `stateMode:'trie'`. Nothing a consumer can reach changes today: the node
runs Cancun and exposes no hardfork option, so this is a guard that fires the day
that moves rather than letting an estimate go out that the engine which produced
it would reject.

Two new exports on the `embedded-eth-node/revm` subpath say which forks are
served, in code rather than by triggering the refusal:
`REVM_SPEC_BY_HARDFORK` (admitted) and `REVM_REFUSED_HARDFORKS` (refused, with
the reason). The `eth_estimateGas` for a calldata-heavy call is now fed back to
revm AS a gas limit under every admitted spec in the test suite, so re-admitting
a fork without doing the costing work fails the build.

See `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and the
measurements in `docs/spikes/prague-intrinsic-gas-floor-or-refuse/`.
