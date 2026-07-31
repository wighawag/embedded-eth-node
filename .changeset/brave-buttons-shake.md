---
'embedded-eth-node': minor
---

Make the EVM behind the READ path swappable: `createNode({engine})`.

`eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s gas estimation now run
on an ENGINE rather than reaching `@ethereumjs/evm` directly. Supplying none
keeps exactly today's behaviour — the default engine wraps the node's own
`@ethereumjs/evm`, including the pure-read checkpoint/revert and the EIP-2929
warm/access reset that keeps a repeated estimate for a warm SSTORE from coming
back ~2000 gas too low.

An engine is an INJECTED OBJECT (`ReadEngine`), never a name the core resolves,
so the core imports no engine a consumer did not and a JS-only consumer pays
nothing for one they never use. See
`docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.

Everything an engine needs to keep a read pure is the ENGINE's business: the
default engine checkpoints and resets warmth because `@ethereumjs/evm` requires
it, and an engine that is structurally incapable of committing pays for neither.

Scope, deliberately narrow: only READS are routed through the engine.
Transactions still run on `@ethereumjs/vm`, which is why the active engine reads
as `node.readEngine` (`{id: '@ethereumjs/evm'}` by default) rather than
`node.engine` — a receipt can never be attributed to it.

New exported types: `ReadEngine`, `ReadEngineContext`, `ReadEngineInfo`,
`ReadCallRequest`, `ReadCallResult`. No new runtime dependency.
