---
title: Two agents were alive in the same worktree at once after a deadline requeue
date: 2026-08-01
status: open
---

# Two agents were alive in the same worktree at once after a deadline requeue

Spotted while driving `revm-engine-subpath` (the continuation run), not investigated.

The deadline checkpoint at 02:13 saved WIP and the runner dispatched a CONTINUATION agent at ~02:15 into the same worktree (`/home/wighawag/.dorfl/work/github-com__wighawag__embedded-eth-node__revm-engine-subpath`). The PREVIOUS agent was still running: its session log (`~/.pi/agent/sessions/.../revm-engine-subpath-ms9mbguq-qy5q6v.jsonl`) kept being written until 02:19:29, about four minutes into the continuation run, and its last act was to append an addendum to `work/notes/observations/webkit-worker-gap-timing-assertion-flake.md` — a file the continuation agent had already seen as clean in its opening `git status`.

Nothing was lost this time (the two agents happened not to touch the same file, and the addendum is a legitimate observation), but the shape is dangerous: two writers in one working tree with one lock. A stray write landing after the continuation's `git status` is invisible to it, and a write landing during its edits could be clobbered in either direction. This sits next to `dorfl-surface-wrote-five-duplicate-commits.md`, which records the same deadline-checkpoint path reporting contradictory branch state — worth checking whether the checkpoint releases the lock and dispatches the successor before it has actually reaped the agent process it checkpointed.
