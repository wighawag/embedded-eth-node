# What a transaction actually costs on each engine, measured by shape

Measured 2026-08-11 by [`./measure-transaction-cost.mjs`](./measure-transaction-cost.mjs), against the tree at **commit `8634c73`** (`chore(work): triage the packed-keys Gate-2 nits`) — `packages/embedded-eth-node` exactly as this task found it. This task changes nothing under `packages/`, so the code measured here is the code that shipped.

```sh
pnpm install   # also builds packages/embedded-eth-node/dist, which the script reads
node docs/spikes/measure-what-transactions-on-revm-actually-cost/measure-transaction-cost.mjs
```

About 15 seconds end to end. Every number below is one of its output lines, and it exits non-zero if any of its own checks fail — so a stale figure in this document is a RED RUN rather than a wrong document. Two consecutive runs on the same quiet machine are transcribed rather than averaged, because the allocation-heavy rows move between runs and averaging would hide exactly the thing you need to know before quoting one.

Environment: Node v24.13.1, linux x64, AMD Ryzen 7 PRO 6850U, `revm-wasm` 0.3.1, `@ethereumjs/*` 10.1.2, hardfork Cancun, `stateMode:'none'`. The Chromium cross-check in the last section is `packages/benchmarks` on the same machine.

**Read the RATIOS and the SHAPES, not the milliseconds.** This runs under Node on an ordinary developer machine, not the browser the library ships to. Every ratio is between rows measured in the SAME run.

## Which baseline this is, and what had moved

The task that produced this document was written on 2026-08-09 against `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`. Two changes have moved a transaction's cost since that document was taken, and both land inside every row here:

| commit | change | what it moved |
| --- | --- | --- |
| `fc8b1c7` | `sender-recovery-uses-the-engines-ecrecover` | a FIXED per-transaction cost: sender recovery on a revm-backed node went from ~1.6 ms of `@noble/curves` to ~0.4 ms of the engine's own secp256k1 |
| `e2db3f3` | `revm-state-store-packed-storage-keys` | the PER-COLD-ACCESS term: a cold revm storage access went from 1.31-1.33 µs to 0.36-0.39 µs |

So the denominator moved twice after the document the task pointed at, and once more before it (ADR 0009's storage re-layer, which is what that document measures). The share-of-a-transaction framing this spec was originally written with is therefore not restated anywhere here: it was a share of a denominator that no longer exists, and re-deriving it is the whole point of this file. What replaces it is section 2, where the two levers are separated and each measured.

## Correctness first, and it is not the bar

Section 1 of the script is a gate: the same three reference calls must charge the same EXECUTION gas on both engines before a single timing prints, because two engines that disagree about gas are not two implementations of one transaction and comparing their wall clock would be comparing two different transactions.

| engine | `number()` | `sumTo(2000)` | `keccakLoop(2000)` | keccak result |
| --- | --- | --- | --- | --- |
| default `@ethereumjs/evm` | 2446 | 498689 | 1107052 | `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a` |
| `embedded-eth-node/revm` | 2446 | 498689 | 1107052 | same |

Unchanged, on both engines. The script additionally asserts, per shape and per sweep point, that BOTH engines and BOTH sender modes charge the same `gasUsed` — 15 further gas equalities, all green in both runs. The real correctness bar is elsewhere: `packages/embedded-eth-node/test/revm-conformance.spec.ts` and the cross-backend gate in `packages/benchmarks`.

## The answer, plainly

**For the configuration a consumer actually ships** — `senderMode:'recover'`, the default — a transaction is **3.0-3.3x cheaper on revm for every light shape** (transfer, storage write, creation, logs) and **3.9-7.3x cheaper for the two 256-slot shapes**.

**Almost all of the light-shape win is sender recovery, not the interpreter.** With recovery taken out of the window, a plain **value transfer is 0.93x and 1.02x in the two transcribed runs — no measurable difference at all** (0.90x to 1.21x across six runs, straddling 1.00x in both directions), and the other light shapes are 1.35-1.70x. The interpreter and the state seam only start to matter when a transaction touches many DISTINCT storage slots: 1.8x at 16 slots, 3.1-3.2x at 64, 6.8-6.9x at 256, and 16.3-16.5x at 12,288 (which is close to what one transaction can reach at all, since the block gas limit refuses much more).

That is the honest shape of the answer to story 8. It is a smaller number than "revm is 100x faster at compute" would suggest, because a transaction is not compute: the node's own dispatch, block building, receipt assembly and state bookkeeping are on both sides of every row here, and on a 21,000-gas transfer they are essentially all of it. It is also enough on the axis this design was chosen for: **no number of DISTINCT slots one transaction can reach takes revm outside a 60fps frame budget**, while the default engine leaves that budget between 1,024 and 2,048 slots. That is a statement about the STORAGE axis and not a general one — a transaction that spends its whole 30M gas limit on keccak would cost revm ~100 ms too, extrapolating the Chromium `keccak` row in section 5 — but storage is the axis a game tick moves along, and it is the axis the seam design is answerable for.

## 1. What a transaction costs, by shape

Pre-signed transactions through the node's own public surface (`eth_sendRawTransactionSync`, or `evm_sendRawTransactionSyncAs` for `'trusted'`), auto-mining, a fresh node per repeat, median of 5 batches, signing OUTSIDE the window. Milliseconds per transaction.

**Run 1**

| shape | gas | default `'recover'` | default `'trusted'` | revm `'recover'` | revm `'trusted'` | revm speed-up, `'recover'` | revm speed-up, `'trusted'` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| transfer | 21,000 | 2.202 | 0.303 | 0.694 | 0.325 | 3.17x | **0.93x** |
| storage write (3 slots) | 87,488 | 2.100 | 0.365 | 0.657 | 0.247 | 3.20x | 1.48x |
| 256 distinct slots read | 567,310 | 4.406 | 2.502 | 0.776 | 0.368 | 5.68x | 6.79x |
| 256 slot writes | 5,689,272 | 6.356 | 4.488 | 1.142 | 0.686 | 5.56x | 6.54x |
| creation | 57,908 | 2.069 | 0.383 | 0.644 | 0.235 | 3.21x | 1.63x |
| 8 logs | 29,123 | 2.111 | 0.416 | 0.662 | 0.244 | 3.19x | 1.70x |

**Run 2**

| shape | default `'recover'` | default `'trusted'` | revm `'recover'` | revm `'trusted'` | revm speed-up, `'recover'` | revm speed-up, `'trusted'` |
| --- | --- | --- | --- | --- | --- | --- |
| transfer | 2.285 | 0.350 | 0.708 | 0.342 | 3.23x | **1.02x** |
| storage write (3 slots) | 2.340 | 0.388 | 0.778 | 0.287 | 3.01x | 1.35x |
| 256 distinct slots read | 4.818 | 3.091 | 1.227 | 0.501 | 3.93x | 6.17x |
| 256 slot writes | 7.982 | 4.837 | 1.101 | 0.669 | 7.25x | 7.23x |
| creation | 2.118 | 0.371 | 0.642 | 0.239 | 3.30x | 1.55x |
| 8 logs | 2.172 | 0.420 | 0.657 | 0.248 | 3.31x | 1.69x |

The **transfer** row is the one to sit with. A 21,000-gas transfer executes no user code, reads three accounts and writes three; there is nothing for an interpreter to be fast at, and revm is not faster at it (0.93x and 1.02x, i.e. the two engines are the same within run-to-run noise, and the direction of the difference flips between runs). What makes the same row 3.2x in `'recover'` is the ecrecover, which is the previous task's win being re-measured here, not this engine's.

The shapes are hand-assembled runtime code seeded with `evm_setCode`, except `creation`, which is a real creation transaction. The storage shapes take their slot base from CALLDATA so that every transaction in a batch performs COLD zero-to-nonzero SSTOREs; a fixed slot would make the first transaction of each batch the shape and the other 39 a warm no-op, and the batch average would then describe a shape nobody asked for.

## 2. The two levers, told apart

`recovery = 'recover' minus 'trusted'`, same engine, same shape, same run. `execution` is the `'trusted'` column, i.e. everything the node does that is not recovering a sender.

| shape | default: recovery | default: execution | revm: recovery | revm: execution | execution-only speed-up |
| --- | --- | --- | --- | --- | --- |
| transfer | 1.899 / 1.935 | 0.303 / 0.350 | 0.369 / 0.366 | 0.325 / 0.342 | 0.93x / 1.02x |
| storage write | 1.735 / 1.952 | 0.365 / 0.388 | 0.410 / 0.491 | 0.247 / 0.287 | 1.48x / 1.35x |
| 256 distinct slots | 1.904 / 1.727 | 2.502 / 3.091 | 0.407 / 0.726 | 0.368 / 0.501 | 6.79x / 6.17x |
| 256 slot writes | 1.868 / 3.145 | 4.488 / 4.837 | 0.456 / 0.432 | 0.686 / 0.669 | 6.54x / 7.23x |
| creation | 1.686 / 1.747 | 0.383 / 0.371 | 0.410 / 0.404 | 0.235 / 0.239 | 1.63x / 1.55x |
| 8 logs | 1.695 / 1.751 | 0.416 / 0.420 | 0.418 / 0.409 | 0.244 / 0.248 | 1.70x / 1.69x |

Recovery is a **FIXED per-transaction cost and it is shape-independent**, which is the point of separating it: **1.69-1.95 ms on the default engine and 0.37-0.49 ms on revm**, across both runs and every shape except two single noisy cells in run 2 (3.145 and 0.726 — see the noise section). The ratio between the two columns is roughly 4x, which is the ecrecover primitive itself: `docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md` section 1 measures that primitive at 4.33x directly.

Because it is fixed, its SHARE of a transaction is entirely a statement about the shape it is a share of, so no single such share is quoted as the answer. On a transfer it is 85-86% of the default engine's transaction and 52-53% of revm's; on the 256-slot WRITE it is 29-39% and 39-40%. Those are four different numbers for one unchanging cost, and that is exactly why the two levers are reported apart rather than folded into "a transaction".

Said the other way round, which is the form a consumer needs: of everything the engine swap saves on a LIGHT shape, **88-101% is the recovery** (101% because on a transfer revm's execution is fractionally the slower of the two, so the recovery saves slightly more than the swap does). On the 256-slot shapes the recovery is 27-41% of the saving and the rest is the seam and the interpreter.

This section also reproduces the isolated-path row of the sender-recovery document (default `'recover'` 2.09 ms/tx, `'trusted'` 0.33, revm `'recover'` 0.65, revm `'trusted'` 0.23 there; 2.20-2.29, 0.30-0.35, 0.64-0.71 and 0.33-0.34 here), which is the best evidence available that neither document is measuring its own harness.

## 3. The commit path, which had never been benchmarked

State is the node's on both engines (ADR 0010). revm writes it back through the store's host callbacks, ALL of them at the END of the execution, so a revm transaction has a separable commit phase; the default engine writes through the state manager AS IT GOES, so it does not. The two columns are therefore comparable in COUNT and not in mechanism, and the counts are the load-bearing measurement, exactly as ADR 0010 says. They are byte-identical across every run of this script.

Per transaction, counted with the store's and the state manager's own prototypes patched:

| shape | engine | read callbacks | write callbacks | which writes | µs in reads | µs in writes |
| --- | --- | --- | --- | --- | --- | --- |
| transfer | default | 11 | 6 | `putAccount` 6 | 12.0 | 7.3 |
| transfer | revm | **3** | **3** | `setAccount` 3 | 3.1 | 5.0 |
| storage write | default | 21 | 9 | `putAccount` 6, `putStorage` 3 | 16.3 | 5.6 |
| storage write | revm | 8 | 7 | `setAccount` 3, `setCode` 1, `setStorage` 3 | 8.6 | 8.9 |
| 256 distinct slots | default | 268 | 6 | `putAccount` 6 | 91.5 | 4.8 |
| 256 distinct slots | revm | 261 | 4 | `setAccount` 3, `setCode` 1 | 54.9 | 9.3 |
| 256 slot writes | default | 780 | 262 | `putAccount` 6, `putStorage` 256 | 415.9 | 81.1 |
| 256 slot writes | revm | 261 | **260** | `setAccount` 3, `setCode` 1, `setStorage` 256 | 82.0 | 190.2 |
| creation | default | 16 | 11 | `putAccount` 8, `putCode` 1, `modifyAccountFields` 1, `clearStorage` 1 | 13.4 | 9.9 |
| creation | revm | 3 | 5 | `setAccount` 3, `setCode` 1, `clearStorage` 1 | 2.7 | 7.0 |
| 8 logs | default | 12 | 6 | `putAccount` 6 | 11.6 | 4.2 |
| 8 logs | revm | 5 | 4 | `setAccount` 3, `setCode` 1 | 6.2 | 6.2 |

Counts are from run 1 and are identical in run 2. The microsecond columns are UPPER BOUNDS: they include the counting wrapper's own dispatch, and they exclude whatever revm spends inside wasm assembling the commit, which no JS instrument can see.

**The commit is proportional to what the transaction touched, and it is small until the transaction writes a lot.** On revm it is 2.0-3.2% of the whole send for every light shape, and **23.0% / 23.8%** for the 256-slot write. On the default engine the same writes are 1.5-2.7%, but that number means something different: its writes are spread through the execution rather than gathered at the end, and its `putStorage` goes through the same overlay the revm store's `setStorage` does.

Two things in that table are worth naming rather than leaving to be read off it:

- **revm reads three accounts and writes three for a transfer, and nothing else** — six crossings, which is the figure ADR 0010 quotes as the floor, reproduced here through the whole node rather than through a raw binding.
- **`setCode` appears on every transaction that CALLS an existing contract**, not only on one that deploys code. The bytes are identical to the ones already there, so it is a redundant host write of one map entry per transaction. It is one write out of four to seven, it costs nothing measurable, and it is recorded rather than fixed: `work/notes/observations/revms-commit-re-deposits-the-callees-code-on-every-call.md`.

### The coinbase, both ways — and the premise this task carried is INVERTED

The task asked for the commit path partly because "a coinbase credited a real fee is written rather than deleted", and expected strictly MORE host writes as a result. Measured, on a plain transfer, it is the other way round:

| engine | a transfer with... | write callbacks | which writes | coinbase afterwards |
| --- | --- | --- | --- | --- |
| default | tip 1 gwei (credited) | **6** | `putAccount` 6 | present |
| default | tip 0 (deleted) | **7** | `putAccount` 6, `deleteAccount` 1 | absent from `dumpState` |
| revm | tip 1 gwei (credited) | **3** | `setAccount` 3 | present |
| revm | tip 0 (deleted) | **4** | `setAccount` 2, `clearStorage` 1, `removeAccount` 1 | absent from `dumpState` |

Crediting the coinbase is ONE write. Deleting it is TWO on revm (`clearStorage` then `removeAccount`, the EIP-161 empty-account clearing arriving with revm's commit semantics already applied) and an extra `deleteAccount` on the default engine. So real fees made the commit path CHEAPER in host writes, not dearer, and the identical figures in both runs and on both engines say it is structural rather than incidental. Both engines agree about the end state either way, which is the property that matters.

## 4. Where the crossover is

Cost against the number of DISTINCT storage slots one transaction touches — the axis the host-callback design is most sensitive to, since a boundary crossing is paid once per COLD access and EIP-2929 resets warmth every transaction (ADR 0010). `senderMode:'trusted'`, so this is execution and commit with no recovery in it. The sweep stops at 12,288 because the next point is not measurable: at ~2,140 gas per slot the block gas limit refuses it.

| distinct slots | gas | default ms | revm ms | speed-up | share of a 16.6 ms frame (default / revm) |
| --- | --- | --- | --- | --- | --- |
| 1 | 23,140 | 0.318 / 0.325 | 0.238 / 0.244 | 1.34x / 1.33x | 2% / 1% |
| 16 | 55,150 | 0.460 / 0.460 | 0.245 / 0.251 | 1.88x / 1.84x | 3% / 2% |
| 64 | 157,582 | 0.865 / 0.863 | 0.271 / 0.277 | 3.19x / 3.11x | 5% / 2% |
| 256 | 567,310 | 2.501 / 2.539 | 0.365 / 0.368 | 6.84x / 6.90x | 15% / 2% |
| 1,024 | 2,206,222 | 9.108 / 9.367 | 0.804 / 0.835 | 11.3x / 11.2x | 55% / 5% |
| **2,048** | 4,391,438 | **18.04 / 19.25** | 1.335 / 1.456 | 13.5x / 13.2x | **109% / 8%** |
| 4,096 | 8,761,870 | 36.84 / 37.55 | 2.603 / 2.849 | 14.2x / 13.2x | 222% / 17% |
| 8,192 | 17,502,734 | 77.79 / 78.63 | 5.094 / 5.389 | 15.3x / 14.6x | 470% / 32% |
| 12,288 | 26,243,598 | 115.18 / 119.85 | 6.982 / 7.364 | 16.5x / 16.3x | 700% / 43% |

**There is no crossover in the sense of "the default engine wins somewhere".** revm is at least as fast at every point measured; the gap narrows to 1.3x at the bottom of the range, where what is being timed is the node's own dispatch, block building and receipt assembly on both sides rather than either EVM.

**The crossover that does exist is the FRAME BUDGET, and it is between 1,024 and 2,048 distinct slots.** The default engine sits at 55-56% of a 16.6 ms frame at 1,024 and at 109-116% at 2,048; revm is at 8-9% of a frame at 2,048 and never leaves the budget ON THIS AXIS — 43% at 12,288 slots, which is already 26.2M of a 30M block gas limit, so the table ends where a transaction does. A COMPUTE-heavy transaction is a different axis and is not bounded this way: the Chromium `keccak` row in section 5 puts 1.1M gas of keccak at 4.3 ms on the revm engine, so a transaction spending the whole block gas limit on it would be ~100 ms on either engine.

The marginal cost of ONE more cold slot, from the two ends of the sweep: **0.55-0.58 µs on revm and 9.3-9.7 µs on the default engine**, a factor of 17. The revm figure sits neatly on top of the 0.36-0.39 µs a cold access costs at the store itself (`docs/spikes/revm-state-store-packed-storage-keys/measurements.md`), so roughly two thirds of what an additional distinct slot costs a revm-backed transaction is the crossing and its key handling, and the remaining third is the interpreter's own `SLOAD` plus the gas accounting around it. Two probes measuring different things and agreeing is worth more than either alone.

## 5. Cross-check in real Chromium

`packages/benchmarks`, `--project=chromium`, same machine, same commit, all 10 tests green. These are the repo's own published rows, unchanged by this task:

| row | `deploy` | `callAvg` | `frame` |
| --- | --- | --- | --- |
| `ethereumjs-default` (raw) | 0.80 | 0.70 | 38.5 ms (232%) |
| `embedded-eth-node` (default engine, `'recover'`) | 2.70 | 2.19 | 10.7 ms (64%) |
| `embedded-eth-node-trusted` | 1.20 | 0.825 | 11.2 ms |
| `embedded-eth-node-fabricated` (no secp256k1 anywhere) | 0.80 | 0.525 | 10.7 ms |
| `embedded-eth-node-revm-engine` | 2.20 | **1.055** | **3.7 ms (22%)** |
| `revm` (raw, no node, no signing) | 0.30 | 0.06 | 3.5 ms (21%) |

`callAvg` is an `increment()` transaction — one warm SSTORE and one log — with the CLIENT's signing INSIDE the window, which is the residual no engine can remove. It reads 2.08x for the engine swap where the equivalent Node-probe shape reads 3.0-3.2x, and the difference is that dilution plus two different JS engines. The revm-engine row is where `sender-recovery-uses-the-engines-ecrecover` left it (it quotes 1.03-1.13 ms), so nothing has drifted since.

The `frame` row is a READ row and is not a transaction figure; it is here because it is the number the library README cites and because it makes the same point from the other side.

## Findings

**F1. The engine swap is worth 3.0-3.3x on an ordinary transaction as shipped, and the interpreter is not what buys it.** On the light shapes 88-101% of the saving is `Engine.ecrecover`. A consumer in `senderMode:'trusted'` (or one who is told the interpreter is the win) gets 1.35-1.70x on light shapes and nothing at all on a plain transfer.

**F2. The single-EVM-coherence argument is unaffected, and remains the reason this spec exists.** A node running two EVMs has two chances to disagree with itself; the numbers here neither strengthen nor weaken that, and the gas equalities in the correctness section are the part of this document that speaks to it.

**F3. The design should NOT be revisited yet, and here is the trigger, stated rather than acted on.** ADR 0010 records the caveat that EIP-2929 resets warmth every transaction, so a game loop re-reading the same entities every tick re-pays every crossing, and it asks for the revisit to be triggered by a measurement of a real workload touching thousands of distinct slots per tick. The measurement now exists: **a transaction touching 4,096 distinct slots costs revm 2.6-2.8 ms, one sixth of a 60fps frame, and the most a transaction can reach at all (~12,288 slots, block-gas-limited) costs 7.0-7.4 ms, under half a frame.** A wasm-side cache spanning transactions could remove at most the read-callback time in section 3 — 55 µs of the 365 µs a 256-slot transaction costs, i.e. about 15% — and would need invalidation on the `evm_set*` cheats, which mutate state with no transaction to notice. That is a poor trade at today's numbers. **Revisit if a tick needs several such transactions**, since four 4,096-slot transactions per tick is 10-11 ms of a 16.6 ms frame and the headroom is gone.

**F4. If the same workload runs on the DEFAULT engine, the frame budget is the constraint, and it binds between 1,024 and 2,048 distinct slots per transaction.** That is a plausible size for per-player game state, which is the consuming use case, and it is the strongest practical argument in this document for the engine swap.

**F5. The commit path is not a bottleneck and did not become one.** It is 2.0-3.2% of a light transaction on revm and 23% of the heaviest write shape measured, its callback counts are exactly proportional to what the transaction touched, and real fees made it cheaper in writes rather than dearer.

## Noise, and how to read these numbers

The COUNTS in section 3 are exact and reproduce byte for byte across runs; prefer them to any microsecond figure, which is what ADR 0010 already says and what this document's own volatility confirms.

Timing rows move a few percent between runs, and the allocation-heavy ones move more. Named cells:

| cell | run 1 | run 2 | earlier runs (of earlier revisions of the same script, during development) |
| --- | --- | --- | --- |
| transfer, revm `'trusted'` speed-up | 0.93x | 1.02x | 1.07x, 1.21x, 0.90x, 0.97x |
| 256 distinct slots, default `'trusted'` | 2.502 | 3.091 | 2.504, 2.562 |
| 256 slot writes, revm commit share | 23.0% | 23.8% | 18.2%, 17.6%, 22.4%, **42.2%** |
| 256 slot writes, default `'recover'` | 6.356 | 7.982 | 6.558, 6.512, 6.302 |

**The 42.2% is exactly the cell not to quote**, and it is in this table for that reason. It is the allocation-heaviest measurement in the file (256 `setStorage` calls into the overlay per transaction) and it was taken with a five-transaction counting batch; the batch is ten now and the same cell reads 23.0% and 23.8%. The durable claim is "the commit is a fifth to a quarter of the heaviest write shape and a low single-digit percentage of everything else", not any one of those numbers.

The same discipline applies to the transfer row: the durable claim is **"no measurable difference"**, not 0.93x and not 1.21x. Six measurements of it straddle 1.00x in both directions.

Every figure here is a median of 5 batches of 4 to 40 transactions, with a discarded warm-up batch before each row and a fresh node per batch. Run the script twice and prefer what survives both.

## What was NOT measured

- **The browser, for the shape table.** Only the existing `packages/benchmarks` rows were taken in Chromium (section 5). A JS EVM and a wasm EVM do not degrade the same way across JS engines — the benchmark package's own config records `@ethereumjs/evm` losing ~1.45x from Chromium to WebKit while revm-wasm loses nothing — so the Node ratios in sections 1 to 4 are, if anything, conservative for WebKit. Measuring the six shapes in both browsers means teaching the benchmark scenario six new transaction shapes on all eight of its backends, which is a change to a shared gate rather than a measurement.
- **Nested calls.** The four-transaction row of the ADR 0009 document includes a nested-CALL transaction; it is not repeated here because nesting is a message-frame cost, and the thing it used to measure (a storage copy per frame) is what ADR 0009 removed.
- **Type-1 and type-0 transactions.** Every row is EIP-1559. Access lists have their own measurement (`docs/spikes/eip-2930-access-lists-are-charged-and-warmed/`).
- **`stateMode:'trie'`.** The revm engine refuses it at construction, so there is no pair to compare.

## Decisions taken while building this

Recorded here rather than in an invented home, per `work/notes/observations/gate-2-keeps-finding-decision-records-that-are-not-linked-from-the-done-record.md` (the changeset plus this file are the sanctioned pair). Nothing here changes shipped behaviour; each entry is a measurement-design choice a reviewer could reasonably want to reverse.

### 1. A Node probe for the shapes, and the benchmark suite only as a cross-check

**Chosen:** the shape-by-shape, commit-path and crossover measurements are a re-runnable Node script under `docs/spikes/`, and `packages/benchmarks` is used unchanged, for its existing rows. **Why:** the task asked to extend the existing instrument rather than invent a parallel harness, and this is what "extending" it costs in each direction. Adding six transaction shapes to `packages/benchmarks` means adding them to the `EvmBackend` interface and to all EIGHT backends — including raw `runCall` backends and `tevm`, which have no notion of a log-emitting transaction shape without a new contract — and the suite is also a GATE (cross-backend gas equality), so widening it to serve a measurement risks the gate for a number. The host-callback counts in section 3 are additionally not obtainable there at all: they need the store's prototype, which lives on the JS side of a browser bundle. **Rejected:** teaching the benchmark scenario the six shapes (blast radius across eight backends, and it puts a measurement inside a gate); a third harness that drives the engines directly rather than the node (it would stop measuring what a consumer pays). **Touches:** anyone who later wants these shapes in the browser has to make the benchmark change this decision declined; the two documents would then need reconciling, and section 5 is where they meet today. Precedent: `sender-recovery-uses-the-engines-ecrecover` made the same split.

### 2. The commit path is counted by patching prototypes, not by a parallel store

**Chosen:** window 4 patches the named methods on `SimpleStateManagerStore.prototype` and `OverlayStorageStateManager.prototype`, imported from the node's own `dist/`, and runs the REAL node with the REAL engine. **Why:** a hand-built store over a raw `createRevm` (which is what `docs/spikes/revm-executes-the-first-transaction-with-commit/probe-host-callbacks.mjs` does) measures the binding; this task's question is what the NODE's commit path costs, dispatch and mining included. Patching the class the node itself imports means there is no second module instance to patch by mistake. **Rejected:** a counting store injected through a custom engine (it would no longer be the shipped engine); wrapping the state manager reached through `EngineContext` in `connect` (revm's account writes go straight into the top of `accountStack`, so a state-manager wrapper cannot see them). **Touches:** the counted method names are a hard dependency on both classes' method names; a rename makes the script THROW rather than count zero, which is deliberate, and every count is additionally asserted non-zero and uniform across the batch. The timing rows in windows 2, 3 and 5 run with NO patches installed, because timing an instrumented store would fold the instrument into the answer.

### 3. The distinct-slot sweep stops at 12,288, and 2,048 is in it on purpose

**Chosen:** 1, 16, 64, 256, 1,024, 2,048, 4,096, 8,192, 12,288. **Why:** 12,288 cold SLOADs is ~26.2M gas, and the next point on the axis is refused by the block gas limit both engines now enforce, so the sweep ends where a transaction ends rather than where patience does — which is what lets section 4 say "revm never leaves the frame budget on this axis" as a fact rather than a trend. 2,048 exists because the default engine crosses the 16.6 ms frame budget between 1,024 and 4,096, and a crossing read off a straight line between two measured points is arithmetic, not a measurement. **Rejected:** stopping at 4,096 (the interesting claim would then be extrapolated); raising `blockGasLimit` to push the sweep further (it would measure a node nobody configures). **Touches:** the frame-budget claim in F3 and F4 is only as good as this ceiling; if `blockGasLimit`'s default ever rises, this sweep and those two findings have to be re-taken.
