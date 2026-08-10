# The seam probe's fork is derived from a DEFAULT node, not from the node under test

2026-08-10. Raised by Gate 2 on `close-the-residual-holes-in-the-affordability-classification` and kept as a live signal, since there is nothing to fix until the condition below becomes true.

That task's item 3 removed a hand-written `hardfork: 'cancun'` from `valueReadAtSeam` in `packages/embedded-eth-node/test/helpers/revm-engine.ts`, because a hand-pinned fork and the fork the node pins were two independent statements written as if they were one. The replacement derives the fork by constructing a throwaway `createNode()` with a non-executing fork-probe engine that records `context.common` and is then disposed.

What it derives is the fork `createNode()` DEFAULTS to, not the fork of the node under test: the probe node is built with none of the options the nodes under test are built with. Those are the same thing today only because `src/node.ts` builds its `Common` with `hardfork: Hardfork.Cancun` and exposes no fork option at all, so there is nothing a caller could set that would make them differ.

The day a per-node fork option is added, the probe silently goes back to measuring a different fork than the node it claims to mirror, which is the exact drift item 3 existed to remove, just one level further out. Whoever adds such an option owns making the probe read the fork from the node UNDER TEST rather than from a default one.

Nothing is wrong today and no test is weakened; this is recorded so the assumption is discoverable rather than re-derived by the next reader.
