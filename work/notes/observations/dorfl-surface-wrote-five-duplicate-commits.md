---
title: A single needs-attention bounce wrote five duplicate surface commits and still reported "did not land"
slug: dorfl-surface-wrote-five-duplicate-commits
---

Spotted 2026-07-31 on `dorfl` 0.11.1, driving `revm-state-adapter-spike` with `do --isolated --merge --review --arbiter origin`. This is a tooling observation about the runner, not about this repo's code.

## What was seen

The task's acceptance gate failed (see `webkit-worker-gap-timing-assertion-flake`), so the runner surfaced the bounce. Its output was:

```
>> push reported up-to-date / no change of our making — origin/main is not our commit — treating as rejected.
>> main advanced under us — surface refetch and retry (1/5)...
   ... (repeated through 5/5)
>> surface for 'task:revm-state-adapter-spike' did not land on origin/main
   (item missing on main, or contention exhausted after retries).
```

It had in fact landed. `origin/main` gained FIVE commits, all with the same subject:

```
72585a7 surface task:revm-state-adapter-spike (stuck): acceptance gate failed ...
ec3f8fa surface task:revm-state-adapter-spike (stuck): acceptance gate failed ...
682c0a3 surface task:revm-state-adapter-spike (stuck): acceptance gate failed ...
9a1ac1c surface task:revm-state-adapter-spike (stuck): acceptance gate failed ...
a207d6c surface task:revm-state-adapter-spike (stuck): acceptance gate failed ...
```

The net file effect is correct and idempotent (`needsAnswers: true` added once to the task body, the sidecar written once), so nothing is corrupted. The first commit carried the frontmatter flag; the following four each rewrote the same sidecar.

## The apparent shape of it

The push SUCCEEDS, then the post-push read-back concludes "origin/main is not our commit" and treats its own successful push as a rejection, so the retry loop re-pushes the same surface. Four extra commits, then a false failure report telling the operator the surface did not land and offering `dorfl complete --isolated <slug>` to finish a branch that did not need finishing.

## Why it matters

- The operator is told the opposite of what happened. Acting on that message (running `complete`, or re-surfacing by hand) would be work against a state that is already correct.
- Five commits per bounce is noise in `main`'s history, and it scales with the retry budget rather than with anything real.
- It cost a full diagnosis pass mid-drive to establish that the ledger was actually fine.

## Not investigated

Whether the read-back compares the wrong ref, compares against a stale mirror, or is confused by this repo being unregistered (`dorfl status` reports "participates but is NOT registered", and separately "no 'arbiter' remote configured in this repo" despite `defaultArbiter: origin` resolving fine). The unregistered/arbiter-naming angle is the first thing worth checking.
