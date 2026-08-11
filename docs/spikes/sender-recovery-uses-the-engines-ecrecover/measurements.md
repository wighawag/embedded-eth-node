# Sender recovery on the engine's ecrecover: what it costs, and what the ratio really is now

Taken 2026-08-11 by `sender-recovery-uses-the-engines-ecrecover`. Produced by
[`./measure-recovery.mjs`](./measure-recovery.mjs) (Node 24.13.1, linux/x64) and
cross-checked in real Chromium through `packages/benchmarks`. `revm-wasm@0.3.1`
and `@ethereumjs/*@10.1.2` as installed in `packages/embedded-eth-node`, hardfork
Cancun, `stateMode:'none'`.

Reproduce:

```sh
pnpm build
node docs/spikes/sender-recovery-uses-the-engines-ecrecover/measure-recovery.mjs
pnpm --filter embedded-eth-node-benchmarks test --project=chromium
```

The probe exits non-zero if the two implementations disagree about the signer, or
if any measured transaction fails or charges gas other than 21,000 — so a stale
number in this file is a red run rather than a wrong document.

**Read the ratios, not the milliseconds.** Absolute values are load-sensitive and
the probe runs under Node on an ordinary developer machine, not the browser the
library ships to. Every ratio below is between rows measured in the same run.

## The figures this task inherited, and what happened to them

| claim | where it came from | measured here |
| --- | --- | --- |
| the engine's ecrecover is "roughly 4.2x" faster | `revm-wasm`'s own README, measured on the ENGINE side | **4.3x** (1.63 ms -> 0.38 ms per recovery) — it holds |
| `'recover'` vs `'trusted'` is "about 13x" | this node, on `runTx` in isolation, before ADR 0009's storage re-layer | **6.2x** — the claim had drifted by half |
| that gap narrows "to about 3x" | inferred, not measured | **2.8x** — close, and now measured |

The 13x did not drift because recovery got slower. It drifted because everything
AROUND recovery got faster: ADR 0009 re-layered `stateMode:'none'` storage so a
checkpoint stops copying the whole storage map, which removed most of what
`'trusted'` used to be measured against. The number was 2.52 ms -> 0.19 ms on
`runTx`; a comparable `runTx` window no longer exists, because transactions cross
the engine seam now, so the successor window is the node's whole isolated send
path (below) and its `'trusted'` side is correspondingly larger.

## 1. One ecrecover, nothing else

200 recoveries of the same signature, median of 7 repeats.

| implementation | per recovery |
| --- | --- |
| `@ethereumjs/util` (`@noble/curves`) — what `tx.getSenderAddress()` runs | 1630 µs |
| `Engine.ecrecover` on `embedded-eth-node/revm` (the `0x01` precompile's k256) | 377 µs |

**4.33x** (4.32 / 4.33 / 4.41 across three runs). This is the only window where
the ratio is the curve's; every window below dilutes it with work neither
implementation can make cheaper.

It also settles the "`ecrecover` is a FIXED ~2 ms per tx" figure the repo has been
quoting: **~1.6 ms** in JS here, **~0.4 ms** on the engine.

## 2. The isolated transaction path

60 pre-signed 21,000-gas value transfers through `eth_sendRawTransactionSync`
(`'recover'`) or `evm_sendRawTransactionSyncAs` (`'trusted'`), auto-mining, a
fresh node per repeat, median of 5. **Signing is outside the window**, so the
difference between the two sender modes is the node's recovery and nothing else.

| row | ms/tx |
| --- | --- |
| default engine, `'recover'` | 2.09 |
| default engine, `'trusted'` | 0.33 |
| revm engine, `'recover'`, **no engine ecrecover** (i.e. before this task) | 2.02 |
| revm engine, `'recover'` | 0.65 |
| revm engine, `'trusted'` | 0.23 |

- **What this task bought: 3.0x** on a revm-backed node (2.02 -> 0.65 ms/tx),
  measured against the same engine with its `ecrecover` removed, which is exactly
  what the node sees for an engine that does not offer one.
- **The recover-versus-trusted ratio: 6.2x on the default engine, 2.8x on revm.**
- Note the third row. Before this task, swapping in revm barely moved a small
  transaction at all (2.09 -> 2.02): recovery was ~all of it, and the engine
  could not touch recovery. That is the shape the task's framing predicted, and
  it is why the gap narrowing is the interesting consequence rather than a side
  effect.

Across three runs: default 6.37 / 6.04 / 6.25, revm 2.83 / 2.84 / 2.83, task
delta 3.13 / 2.99 / 3.01.

## 3. End to end, the client signing inside the window

The same transactions with `viem`'s own signing inside the measured window —
what a dapp actually pays, and the residual `'trusted'` can never remove.

| row | ms/tx |
| --- | --- |
| default engine, `'recover'` | 2.37 |
| default engine, `'trusted'` | 0.66 |
| revm engine, `'recover'` | 0.98 |
| revm engine, `'trusted'` | 0.56 |

**3.6x on the default engine, 1.8x on revm.**

## 4. Cross-check in real Chromium

`packages/benchmarks`, `callAvg` (a state-changing `increment()` transaction,
signing included, median of 7). These are the repo's own published rows.

| row | callAvg |
| --- | --- |
| `embedded-eth-node` (default engine, `'recover'`) | 1.96 – 2.08 ms |
| `embedded-eth-node-trusted` (default engine, `'trusted'`) | 0.81 ms |
| `embedded-eth-node-fabricated` (no secp256k1 anywhere) | 0.49 ms |
| `embedded-eth-node-revm-engine`, **before** this task | 1.92 ms |
| `embedded-eth-node-revm-engine`, after | 1.03 – 1.13 ms |

The revm-engine row nearly halves (1.92 -> ~1.08 ms), and it is now faster than
the default engine's `'trusted'` row despite still authenticating every
transaction. Recover-versus-trusted on the default engine reads **~2.5x** here
rather than the 3.6x the Node probe reports for the same shape; the two machines
and the two JS engines differ, which is why this file publishes ratios per run
rather than one number for all conditions.

The "before" row was taken by renaming `ecrecover` out of the engine object in
`src/revm.ts`, rebuilding, running the row, and restoring — nothing here is in
the tree.

## 5. What it cost

The default entry point's bundle grew **420.0 -> 421.1 KB raw / 126.7 -> 127.1 KB
gzip** (re-pinned in `packages/benchmarks/test/evm.spec.ts`). That is
`src/sender-recovery.ts`: the message hash, EIP-2's low-`s` rule, the wire
`v` -> 0/1 recovery id conversion, and a refusal for each. Still zero bytes of
`revm-wasm` in the core graph — the "zero additional bytes" in the task's framing
is about the ENGINE side, where the secp256k1 is already present whether the node
calls it or not.

## 6. The correctness bar, and where it can go red

Speed is the reason; agreement is the bar. The differential is
`packages/embedded-eth-node/test/helpers/sender-recovery.ts`, asserted by
`test/revm-sender-recovery.spec.ts`. It passed on its first green run, which says
nothing on its own, so each bug class it claims to catch was INTRODUCED
deliberately and the run recorded. Every mutation was reverted immediately;
nothing here is in the tree.

Reproduce a row by applying its one-line edit, running
`pnpm exec playwright test revm-sender-recovery --project=chromium` in
`packages/embedded-eth-node`, and reverting.

### a. EIP-2 not enforced above the seam (`src/sender-recovery.ts`)

`if (common.gteHardfork('homestead') && s > SECP256K1_ORDER_DIV_2)` replaced with
`if (false)` — i.e. trusting the engine's ecrecover to refuse a high-`s`
signature, which it does not and must not (the `0x01` precompile normalises it).

```
mismatches:
  legacy-high-s/engine: ACCEPTED a transaction that authenticates nobody
  legacy-high-s/engine: mined a block for it
  legacy-high-s/engine: state moved ({"balance":"0xd3c21bce5a54f7c21ffd","nonce":"0x3"}
                                  -> {"balance":"0xd3c21bce342214ad7ffc","nonce":"0x4"})
  legacy-high-s: THE TWO IMPLEMENTATIONS DISAGREE — fallback threw true, engine threw false
```

This is the whole reason the file exists. The mutation does not throw anywhere:
the transaction is admitted, mined, and charged to the right signer — a
revm-backed node quietly accepting a transaction the default engine refuses. Only
the state reading and the cross-implementation diff see it.

### b. The wire's `v` forwarded instead of a recovery id (`src/sender-recovery.ts`)

`Number(recovery)` replaced with `Number(v)`.

```
Error: embedded-eth-node: Invalid Signature: the engine's ecrecover recovered no address
from this transaction, so there is nobody to attribute it to.
    at recoverSender ... at parseTx ...
```

Every EIP-155 legacy transaction is rejected — a `v` of 62709 is not a recovery
id. Loud rather than silent, but it would break every protected legacy
transaction on a revm-backed node, and nothing else in the repo covers it.

### c. The node never uses the engine's ecrecover (`src/node.ts`)

The `typeof engine.ecrecover === 'function'` test forced to `false`, i.e. the
change reverted while the suite stays in place.

```
mismatches:
  the engine's ecrecover ran 0 times for 3 recovered senders — the node did not use it
  the recording engine saw 0 recoveries, expected 2
```

Without this counter the whole differential passes vacuously: it would be
comparing the fallback implementation with itself.

### d. `senderMode:'trusted'` recovering anyway (`src/node.ts`)

A `recoverSender(...)` call added to the claimed-sender branch of `parseTx` — the
plausible mistake of "recover it too, just to check".

```
mismatches:
  senderMode:'trusted' ran the engine's ecrecover 1 times — it must skip recovery entirely
```

`'trusted'` exists to skip recovery, and a cheaper recovery is not a reason to
start doing it. The counter is what makes "skips it ENTIRELY" measurable instead
of merely stated.

## Decisions taken while building this

Recorded here rather than in an invented home, per
`work/notes/observations/gate-2-keeps-finding-decision-records-that-are-not-linked-from-the-done-record.md`
(the changeset plus this file are the sanctioned pair). Each entry: what was
chosen, why, what was rejected, and what it touches. Ratify or reverse.

### 1. `Engine.ecrecover` is OPTIONAL — the seam's only optional operation

**Chosen:** an optional method, with the node falling back to
`tx.getSenderAddress()` when it is absent. **Why:** `call` and `transact` are
required (ADR 0006, amendment 2) because the node cannot supply them and there is
no second engine to fall back to; this one the node CAN supply, and always did.
Making it required would break every third-party engine for a speed-up, and would
force an engine with no secp256k1 in its module to bundle one. **Rejected:**
requiring it; making it a separate `SignatureRecovery` capability object (a second
injection point for one function). **Touches:** `connectEngine`'s "an engine that
brings only one operation is refused" rule now has a stated exception, and ADR
0006 amendment 4 is where that exception is written down. Anyone adding a further
optional seam method should read that amendment first.

### 2. It is called `ecrecover`, not `recoverSender`

**Chosen:** the protocol's own word for the curve operation, with the signature
`(hash, recoveryId, r, s)`. **Why:** `CONTEXT.md`'s `engine` glossary entry says
in as many words that *sender derivation* is NOT the engine's, and this task must
not silently re-mean that. Shaping the method as a question about a SIGNATURE
keeps the statement true: the node still decides which message is signed, whether
EIP-2 admits the signature, what the wire's `v` means, and therefore whether the
transaction is admitted at all. A `recoverSender(tx)` would have moved the
decision and made the glossary wrong. **Rejected:** `recoverSender(tx)`;
installing the engine's recovery as `Common.customCrypto.ecrecover` (structurally
impossible — that hook must return a PUBLIC KEY and revm returns an address, and
it would also have hidden the seam). **Touches:** the `engine` and `sender mode`
entries in `CONTEXT.md`, both updated in this change.

### 3. Two implementations, not one path with a pluggable curve

**Chosen:** with no engine ecrecover the node calls `tx.getSenderAddress()`
verbatim — the same code, the same errors, the same `senderPubKey` caching as
before. **Why:** the acceptance bar is that the two AGREE, and agreement proven by
a differential is worth more than agreement assumed by shared code. It also keeps
the default path byte-for-byte unchanged, so this task cannot regress a consumer
who installs no engine. **Rejected:** routing both paths through
`src/sender-recovery.ts` with `@ethereumjs/util`'s `ecrecover` as the default
primitive — tidier, but it would have silently changed the default path's error
messages and dropped its caching, and it would have made the differential compare
one implementation with itself. **Touches:** `src/sender-recovery.ts` duplicates
`@ethereumjs/tx`'s EIP-2 and recovery-id rules on purpose; the duplication is what
`test/revm-sender-recovery.spec.ts` measures.

### 4. An unrecoverable signature throws a plain `Error`, not a new `RpcError` code

**Chosen:** the same shape `@ethereumjs/tx` throws today, with a different
message. **Why:** a new code would mean the SAME bad transaction produced two
different errors depending on which engine is installed, which is precisely what
the seam exists to prevent. **Rejected:** `RpcError(-32000, ...)`, geth's
vocabulary for a refused transaction — defensible, but it is a user-visible
change to the default path's contract that this task was not asked to make, and it
would have to be made for BOTH implementations at once. **Touches:** anyone who
later decides `eth_sendRawTransaction*` should refuse a malformed signature in
geth's vocabulary must change `parseTx` for both paths together, not just the
engine one.

### 5. The default `@ethereumjs/evm` engine does NOT implement `ecrecover`

**Chosen:** leave it absent. **Why:** its recovery IS the fallback, so
implementing it would wrap `@ethereumjs/util` as an engine method purely to make
the node take the other branch — one more layer, zero behaviour change, and the
fallback path would then never be exercised by the shipped default. **Touches:**
`test/revm-sender-recovery.spec.ts` asserts `fallbackEngineId === '@ethereumjs/evm'`
and relies on that engine having none.

### 6. `countingEngines` now forwards `ecrecover`

`test/helpers/conformance.ts`'s wrapper rebuilds the engine object field by field,
so an optional seam method it did not forward would be SILENTLY ABSENT on every
suite that uses it — and the node's response to a missing `ecrecover` is to fall
back quietly. Not a design choice so much as a hazard worth naming: the next
optional seam method has to be added there too, and the comment now says so.

### 7. The bundle baseline was re-pinned, in the core graph

+1.1 KB raw for `src/sender-recovery.ts`, which every consumer pays including one
who installs no engine. The alternative — putting the recovery rules behind the
optional `embedded-eth-node/revm` subpath — was rejected because they are the
NODE's rules, not revm's, and a third-party engine that offers `ecrecover` must
get the same EIP-2 and recovery-id treatment. See section 5 above for the numbers
and `packages/benchmarks/test/evm.spec.ts` for the re-pin's own paragraph.
