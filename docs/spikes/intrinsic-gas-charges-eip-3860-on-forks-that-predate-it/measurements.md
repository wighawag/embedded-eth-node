# Who charges EIP-3860 on the forks that predate it, measured

Measured 2026-08-02 against `revm-wasm@0.3.0` (revm 42.0.1), `@ethereumjs/common@10.x` and `@ethereumjs/tx@10.1.2`, by `./probe-initcode-costing.mjs` in this folder. Re-run it (`node docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/probe-initcode-costing.mjs`) if either package moves; every number below is that script's output, not a summary of it.

The question, and why it is not the one the previous spike answered. `packages/embedded-eth-node/src/intrinsic-gas.ts` adds the EIP-3860 initcode word cost (`ceil(len/32) * 2`) to every CREATE with no hardfork gate, and `REVM_SPEC_BY_HARDFORK` admitted `berlin`, `london` and `paris` — three forks that predate EIP-3860 (Shanghai). Section 3 of `docs/spikes/prague-intrinsic-gas-floor-or-refuse/measurements.md` observed that revm charges it on BERLIN too and set the matter aside, because the two sides then agree and no divergence reaches an estimate. Agreement between two parties, however, is evidence about the two parties and not about the protocol, so this probe asks a THIRD party.

The probe's subject is a CREATE whose initcode is `PUSH1 0 / PUSH1 0 / RETURN` zero-padded to a chosen length: it deploys empty code and costs 6 gas to execute at every spec, so gas that moves when the LENGTH moves is intrinsic gas and nothing else.

## 1. revm's answer, twice, and it is the spike's answer

Crossing a word boundary (32 bytes = 1 initcode word, 33 bytes = 2). The extra byte is a zero calldata byte worth 4 gas, so a delta of 4 means EIP-3860 is not charged and 6 means it is:

| spec | total (32 bytes) | total (33 bytes) | delta | |
| --- | --- | --- | --- | --- |
| BERLIN / LONDON / MERGE / SHANGHAI / CANCUN | 53172 | 53178 | **6** | EIP-3860 charged |

And decomposed, for a 64-byte initcode (2 words), where the node's formula says 53296 and the pre-Shanghai protocol formula says 53292:

| spec | `totalGasSpent` | minus the 6 gas of execution | vs the node | vs the pre-Shanghai protocol |
| --- | --- | --- | --- | --- |
| BERLIN ... CANCUN | 53302 | 53296 | 0 | **+4** |

So the previous spike's claim is CONFIRMED against the shipped artifact rather than inherited: `revm-wasm@0.3.0` charges the EIP-3860 word cost on BERLIN, LONDON and MERGE, identically to the node. The claim that was wrong is the conclusion drawn from it.

## 2. The protocol's answer, from a witness that is neither party

`@ethereumjs/common`'s EIP activation table, and the intrinsic gas `@ethereumjs/tx` computes for the same CREATE — which is what `@ethereumjs/vm`'s `runTx` charges a real transaction ON THIS NODE, so it is a witness the node already trusts on its own transaction path:

| hardfork | EIP-3860 active | `runTx` intrinsic | vs the node's formula |
| --- | --- | --- | --- |
| berlin / london / paris | **false** | 53292 | **-4** |
| shanghai / cancun | true | 53296 | 0 |

EIP-3860 shipped in Shanghai. On `berlin`, `london` and `paris` the node and revm agree with each other and BOTH over-charge the protocol by `2 * ceil(len/32)` gas — 4 gas here, 3072 gas for a maximum-size initcode.

**The answer to the task's question, stated plainly: yes, the protocol-correct cost differs from what both sides charge on those three forks.** ADR 0008's admission rule ("everything the node computes about a transaction still agrees with what revm enforces under this spec") passes on all three, while all three are mis-costed. That is a hole in the rule, not a technicality: the rule compares two parties who share a formula.

## 3. What reaches a user, and why the fork GATE on its own is not the fix

`eth_estimateGas` is `executionGas + intrinsicGas(...)`. On the default `@ethereumjs/evm` engine `runCall` charges no intrinsic gas, so the estimate moves when the node's formula moves. On revm the engine SUBTRACTS the node's intrinsic from `totalGasSpent` and the node adds the same number straight back, so the estimate is revm's `totalGasSpent` whatever the node's formula says:

| spec | default engine | revm engine | protocol | if `intrinsic-gas.ts` gated EIP-3860 |
| --- | --- | --- | --- | --- |
| BERLIN / LONDON / MERGE | 53302 | 53302 | 53298 | default 53298 vs revm 53302 — **engines disagree** |
| SHANGHAI / CANCUN | 53302 | 53302 | 53302 | default 53302 vs revm 53302 — still agree |

So gating the term makes the DEFAULT engine right and cannot make revm right, which turns an agreed wrong number into a cross-backend gas divergence — the failure `packages/benchmarks`' gate exists to catch. The node cannot make those three forks correct while running on this artifact, by any change to its own arithmetic. That is what settled implement-or-refuse (ADR 0008, amended).

## 4. How wide the artifact's mis-costing is, for proportionality

A mis-costing that turned out to be "this artifact ignores the spec" would be a different, larger finding. It is not: opcode gating is exactly right at every fork checked.

| probe | BERLIN | LONDON | MERGE | SHANGHAI | CANCUN |
| --- | --- | --- | --- | --- | --- |
| CHAINID (0x46, Istanbul) | ok | ok | ok | ok | ok |
| BASEFEE (0x48, London) | halt | ok | ok | ok | ok |
| PUSH0 (0x5f, Shanghai) | halt | halt | halt | ok | ok |
| TLOAD (0x5c, Cancun) | halt | halt | halt | halt | ok |

The divergence is confined to the PRE-EXECUTION intrinsic-gas computation, which behaves as though it were evaluated at a fixed late spec. That is the same root cause as `work/notes/observations/revm-wasm-gasused-carries-the-eip-7623-floor.md` (a Prague floor reported in `gasUsed` on BERLIN), and it is now recorded as `work/notes/observations/revm-wasm-intrinsic-gas-ignores-the-spec.md` — with the sharpening that it does not merely REPORT a post-fork cost pre-fork, it CHARGES one.

## 5. What this repo did about it

`berlin`, `london` and `paris` moved from `REVM_SPEC_BY_HARDFORK` to `REVM_REFUSED_HARDFORKS`, so `embedded-eth-node/revm` admits `shanghai` and `cancun` only, and `src/intrinsic-gas.ts` keeps its unconditional EIP-3860 term — which is now correct at every fork any part of this node can run. Reasoning: `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` (amended, including the sharpened admission rule) and `work/notes/observations/decisions-intrinsic-gas-charges-eip-3860-on-forks-that-predate-it-2026-08-02.md`.
