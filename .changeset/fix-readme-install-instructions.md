---
"embedded-eth-node": patch
---

Fix contradictory install instructions in README: `@ethereumjs/*` and `@noble/hashes` are direct dependencies (installed automatically), not peer deps. Only `comlink` is an optional peer dependency.
