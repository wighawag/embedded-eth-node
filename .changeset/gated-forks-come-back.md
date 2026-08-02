---
'embedded-eth-node': minor
---

`intrinsicGas()` gates EIP-3860 by fork, and the revm read engine admits `berlin`, `london` and `paris` again.

`revm-wasm@0.3.1` fixes the upstream bug this repo filed as
`wighawag/revm-wasm#4`: `CallExecutor::new` now rebuilds the gas-parameter table
for the requested spec instead of leaving it pinned at the `Context::mainnet()`
default, so revm no longer charges EIP-3860's initcode word cost on forks that
predate Shanghai. That INVERTS the previous release's remedy. The two engines
used to agree on a wrong number there; with revm fixed, the node was the only
party still charging the term, and a CREATE-shaped `eth_estimateGas` differed by
engine (default 53302 vs revm 53298 for a 64-byte initcode, where the protocol
charges 53298). The fork gate that was the wrong fix against `0.3.0` is the
required one against `0.3.1`.

So `src/intrinsic-gas.ts` now takes the node's `Common` and charges the initcode
word cost only where `common.isActivatedEIP(3860)` says the protocol does. The
parameter is that `Common` ITSELF, not a hardfork name: `node.ts` hands the
engine the very same instance through `ReadEngineContext.common`, so the caller
that ADDS the intrinsic gas and the caller that SUBTRACTS it cannot name
different forks — which is the drift that shared file exists to prevent. It is
also the table `@ethereumjs/vm`'s `runTx` consults, so a deployment estimated on
the read path is charged what this node's own transaction path spends on it.

**Observable changes.** `eth_estimateGas` for a CREATE is unchanged on the fork
the node runs (Cancun) and on Shanghai. `REVM_SPEC_BY_HARDFORK` is now
`{berlin, london, paris, shanghai, cancun}` and `REVM_REFUSED_HARDFORKS` is
`{prague, osaka}`; code reading either table sees the new contents, and the
`PRE_EIP_3860` refusal text is gone. `revm-wasm` moves to `^0.3.1`. The revm
engine now throws if `call()` is reached before `connect()` bound it to a node
(it has no hardfork to cost against) — unreachable through `createNode()`.

**Still refused, unchanged:** `prague` and `osaka`. Their refusal never depended
on the upstream bug — revm enforces EIP-7623's calldata floor and EIP-7825's gas
limit cap, neither of which this node's arithmetic implements — and both were
re-measured on `0.3.1` rejecting the node's estimate and read budget exactly as
before.

ADR 0008 gains a second amendment recording the reversal, the evidence it rests
on, and that `prague`/`osaka` are untouched. See
`docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and §6-§7
of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`.
