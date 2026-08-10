# ADR 0008 calls the read budget "the 30000000 block gas limit"

2026-08-10. `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` says "the node's default read budget is the 30000000 block gas limit", but the two were never linked in code (`evmCall` in `src/node.ts` used a literal) and are now decided apart on purpose, named `DEFAULT_READ_BUDGET`, with the reasoning at the use site. The NUMBER the ADR relies on is unchanged, so its Osaka argument still holds; only the phrasing conflates two knobs that a consumer can now move independently.
