---
title: review-gate non-blocking nits for 're-widen-the-engine-seam-to-cover-transactions' (Gate 2 approve)
date: 2026-08-10
status: open
reviewOf: re-widen-the-engine-seam-to-cover-transactions
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 're-widen-the-engine-seam-to-cover-transactions' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify (or reverse) making Engine.transact OPTIONAL. The spec's tasking-time decision says the seam is one interface covering both operations and is explicitly NOT an optional capability bolted onto the read seam; the landed interface marks transact as optional and node.ts silently routes to a second, internally-built default engine when it is absent. The reasoning is recorded and sound (the shipped revm engine has no write half yet, and this task's bar is no behaviour change), but nothing owns the CONTRACTION: after revm-executes-the-first-transaction-with-commit lands, the optional marker and the transactionEngine fallback become vestigial and no backlog task removes them. Either ratify optional-transact as permanent (third-party read-only engines are legitimate) or add a task that makes it required and deletes the fallback.
  (work/specs/tasked/revm-engine-behind-runtx.md launch note; src/types.ts Engine.transact?; src/node.ts transactionEngine = transacts(engine) ? engine : defaultEngine)
- The new construction refusal (a transact that is present but is not a function) has no test. Every other engine refusal in this package is asserted in test/helpers/slim-node-checks.ts 6a-6c, and this repo's own comment convention says a refusal nothing measures is one refactor away from disappearing. Worth one probeCreate case.
  (src/engine.ts connectEngine second guard; test/helpers/slim-node-checks.ts engineSeamHonestyChecks has no transact case)
- node.engine now reports the INSTALLED engine even when that engine never executes transactions, which is exactly the misattribution ADR 0006's second consequence warned about, and EngineInfo is still {id} only, so nothing at runtime tells a consumer whether their engine actually mined. The task ordered the rename, and README/CONTEXT/ADR all state the caveat, so this is a knowing trade; consider whether an honest bit on EngineInfo is wanted while the transitional state exists.
  (src/types.ts EngineInfo/SlimNode.engine; docs/adr/0006 superseded consequence 2)
- Two statements the rename made actively wrong survived it: packages/benchmarks/README.md line 72-73 says transactions run on @ethereumjs/vm whatever engine is installed, which is why the node calls it a read engine (the node no longer calls it that, and the general claim is now false), and test/revm-conformance.spec.ts line 9-10 repeats the same parenthetical. The glossary explicitly RETIRES read engine as a term, so these are the last two places the retired concept is still asserted as fact.
  (packages/benchmarks/README.md:72; packages/embedded-eth-node/test/revm-conformance.spec.ts:9)
- Published source comments now cite a work/ task by its BUCKET path (work/tasks/backlog/revm-executes-the-first-transaction-with-commit.md) in src/types.ts and src/revm.ts. Status is folder in this protocol, so that path breaks the moment the task is promoted or done, and it ships inside the package's source. Prefer citing the slug or the spec, which do not move.
  (src/types.ts:319; src/revm.ts:23)
- Cross-task drift to trim: work/tasks/backlog/fees-refunds-and-effective-gas-price-come-from-the-engine.md line 13 is premised on the node still computing effectiveGasPrice in JS and promises to move it behind the default engine. That move already happened here (node.ts lost the helper, engine.ts owns it), so that task's premise is stale and its scope is now the revm side only.
  (src/engine.ts effectiveGasPrice(); node.ts helper deleted)
- The sender crosses the seam IMPLICITLY: TransactionRequest carries {tx, block} and relies on the node having shadowed tx.getSenderAddress() for trusted mode, with a doc comment telling engines not to recover their own. The next task requires the sender to cross as an explicit value and says making that structurally impossible belongs there, so it will need an additive field. Confirm you want the convention now and the field later rather than the field now.
  (src/types.ts TransactionRequest doc; src/node.ts:543 (tx as any).getSenderAddress = () => from)
