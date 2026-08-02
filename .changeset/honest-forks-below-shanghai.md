---
'embedded-eth-node': minor
---

The revm read engine refuses `berlin`, `london` and `paris` too: it now admits `shanghai` and `cancun` only.

`src/intrinsic-gas.ts` adds EIP-3860's initcode word cost (`ceil(len/32) * 2`)
to every CREATE with no hardfork gate, and EIP-3860 arrived in Shanghai. That
was previously judged harmless because `revm-wasm` over-charges identically on
the earlier forks, so the two engines agree and no cross-engine divergence
reaches an estimate. Measured against the shipped artifact, the agreement is
real and the conclusion was not: for a 64-byte initcode both sides charge 53296
where the protocol charges 53292, so `eth_estimateGas` for a deployment on those
forks over-charges by 2 gas per initcode word (3072 for a maximum-size initcode)
against what this node's own `@ethereumjs/vm` transaction path spends. The node
disagreed with itself, and an invariant that compares the node with revm could
not see it.

Gating the term would not have fixed it: the engine subtracts the node's
intrinsic gas from what revm spent and the node adds the same number back, so a
gate moves the default engine's estimate and cannot move revm's, turning an
agreed wrong number into a cross-backend gas divergence. So the three forks are
refused at construction instead, naming EIP-3860 and where the measurements are,
and `intrinsicGas()` keeps its unconditional term — now true at every fork any
part of this node can run.

Nothing a consumer can reach changes: the node runs Cancun and exposes no
hardfork option, so this is a guard that fires the day that moves.
`REVM_SPEC_BY_HARDFORK` is now `{shanghai, cancun}` and `REVM_REFUSED_HARDFORKS`
gains `berlin`, `london` and `paris`; code that reads either table sees the new
contents.

ADR 0008's admission rule is amended with it: agreement between the node and
revm is necessary and NOT sufficient, because they share one intrinsic-gas
answer by construction, so admission now also requires the protocol's agreement,
judged by a witness that is neither of them (`@ethereumjs/common`'s EIP
activation table, asserted per admitted fork in the test suite).

See `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and the
measurements in
`docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`.
