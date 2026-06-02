# Vendored `ethereum/tests` fixtures (for track B conformance)

These are a **small, hand-picked handful** of canonical Ethereum
`GeneralStateTests` JSON files, copied verbatim, used by
[`../statetest.spec.ts`](../statetest.spec.ts) to conformance-test the node's
opt-in `stateMode:'trie'` against real spec fixtures (assert the post-state
Merkle-Patricia root + `keccak(RLP(logs))` match the fixture's expected values).

We vendor **only these files** (not the multi-hundred-MB repo).

## Source

- Repository: <https://github.com/ethereum/tests>
- **Tag: `v17.0`** (pinned; record this if you re-pull)
- Path in repo: `GeneralStateTests/stExample/`
- Pulled: 2026-06-02

## Files

| file | what it exercises |
|---|---|
| `GeneralStateTests/stExample/add11.json` | minimal: a legacy tx calling a tiny `(add 1 1) → SSTORE` contract (1 storage write, no logs) |
| `GeneralStateTests/stExample/eip1559.json` | an EIP-1559 (type-2) transaction |
| `GeneralStateTests/stExample/accessListExample.json` | an EIP-2930/1559 access-list transaction (2 data-index cases) |
| `GeneralStateTests/stExample/solidityExample.json` | a Solidity-compiled contract call |

## Format notes (why this works against the trie-less-by-default node)

Each fixture has a `pre` (genesis accounts), a `transaction`, an `env` (block
environment), and `post.<Fork>[]` cases. Each modern Cancun case carries a
**`txbytes`** field = the exact signed raw tx for that `{data,gas,value}` index
permutation, plus the expected post-state `hash` (the MPT state root) and `logs`
(`keccak(RLP(logs))`). The runner loads `pre` via the node's `initialState`
option, applies `env` via `blockEnv`, submits `txbytes` through
`eth_sendRawTransaction`, then compares `node.getStateRoot()` to `hash`. This only
works in `stateMode:'trie'` (the `'none'` default has no root by design) — which is
exactly the point of the opt-in trie mode.
