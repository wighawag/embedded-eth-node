---
title: worker-entry never exposes senderMode, so a Worker node reports it as undefined
slug: worker-entry-drops-sendermode
---

Spotted 2026-07-31 while wiring the engine seam through the comlink boundary (`engine-seam-with-ethereumjs-default`). `src/worker-client.ts` reads `senderMode` off the remote node (`const senderMode = (await (remote as any).senderMode) as SenderMode`), but `src/worker-entry.ts`'s proxied object lists `stateMode` and not `senderMode` — so `createWorkerNode(...).senderMode` is `undefined` while `SlimNode` types it as `'recover' | 'trusted'`. The `as any` cast on the read is what hides it from the compiler. Not fixed here (out of this task's scope); a one-line addition beside `stateMode:` in the worker-entry proxy would do it.
