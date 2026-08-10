---
'embedded-eth-node': minor
---

**BREAKING (no alias):** the engine seam now covers TRANSACTIONS as well as reads, so `ReadEngine` is `Engine` and `node.readEngine` is `node.engine`. No behaviour changes.

The node had ONE seam for reads and a HARDCODED path for writes: an injected engine
answered `eth_call`, while transactions bypassed it and went straight to
`@ethereumjs/vm`'s `runTx`. The seam is now ONE interface with TWO operations —
`call` (read-only) and `transact` (executes and commits) — the default
`@ethereumjs/evm` engine implements both, and the node's mining path executes
through the engine rather than calling `runTx` itself.

Renamed on the public surface, with **no deprecation alias**, because a shim would
have left two words for one concept from the day it landed:

- `ReadEngine` → `Engine` (and it gained the optional `transact`)
- `ReadEngineContext` → `EngineContext`
- `ReadEngineInfo` → `EngineInfo`
- `SlimNode.readEngine` → `SlimNode.engine` (same `{id}` value, over comlink too)
- `ReadCallRequest` / `ReadCallResult` keep their names: they are the READ
  operation's request and result, and that is still what they are.

New, and the point of the change: `TransactionRequest` (the signed transaction the
node parsed, plus the block it is mined in) and `TransactionResult` — what a
RECEIPT needs from an EVM and nothing else: `status`, `gasUsed` (net of refunds),
`effectiveGasPrice`, `logs` in emission order (`TransactionLog`: address, topics,
data as raw bytes), `logsBloom`, and `createdAddress`. `runTx`'s `amountSpent`,
`gasRefund`, `minerValue`, `accessList` and `execResult` are deliberately absent:
no receipt reads them, and a field that exists only because one engine returns it
is what makes two engines incomparable. `effectiveGasPrice` now comes from the
engine that executed the transaction (the node's legacy-safe computation moved
behind the default engine), so the fee arithmetic has one implementation per engine
and none in the node.

What did NOT move, on any engine: block construction, `cumulativeGasUsed`, receipt
assembly, the RPC layer, transaction parsing and sender recovery are still the
node's. `@ethereumjs/vm`'s `skipBlockGasLimitValidation` / `skipHardForkValidation`
stayed INSIDE the default engine rather than becoming neutral request fields — they
are one EVM's vocabulary, and `revm-wasm` refuses to combine its equivalent
relaxation with committing, so a neutral field would have been a promise another
engine could only throw at. The reasoning is at the code site in `src/engine.ts`.

`transact` is OPTIONAL, transitionally: an engine that omits it leaves transactions
on the node's own `@ethereumjs/vm`, which is exactly what every non-default engine
did before this change. `createRevmEngine()` from `embedded-eth-node/revm` is in
that state today — it serves the seam's read half, so a node with it installed
still mines on `@ethereumjs/vm` and a receipt cannot be attributed to
`node.engine.id`. A `transact` that is present but is not a function is now refused
at construction, next to the existing engine refusals, because a half-built engine
silently mining somewhere else is the same class of lie those refusals exist to
prevent.

No behaviour change anywhere: reference gas is identical (`number()` 2446,
`sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 →
`0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`), and the
differential conformance battery (both state modes, and again with the revm engine
installed), the GeneralStateTests, trusted-sender, persistence, worker and
viem-surface suites all pass unchanged. `test/engine-seam.spec.ts` gained the bar
for the new half: an engine whose `transact` returns values no EVM would produce
for a 21000-gas transfer, so the receipt proves the ENGINE executed the transaction
rather than `runTx` having been called anyway. The default entry's bundle-size
baseline is re-pinned 416.3 → 417.1 KB raw / 125.4 → 125.7 KB gzip (the result
mapping plus one more refusal string; still zero bytes of `revm-wasm`).

`docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` carries a
dated amendment: the injected-object decision is unchanged, its scope widened.
