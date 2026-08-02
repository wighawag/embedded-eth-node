---
'embedded-eth-node': patch
---

The revm engine's exported hardfork tables are FROZEN, so the construction guard cannot be assigned away.

`REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` are public on the
`embedded-eth-node/revm` subpath so "which forks does this engine serve" is
answerable in code rather than by provoking a throw. They were typed
`Readonly<Record<...>>`, which is erased at runtime, so a consumer could re-admit
a refused fork with one assignment (`REVM_SPEC_BY_HARDFORK.prague = 'PRAGUE'`)
and `createRevmEngine()` would then connect on it — producing an
`eth_estimateGas` revm itself rejects (`GasFloorMoreThanGasLimit`, and on Osaka
`TxGasLimitGreaterThanCap` for the default 30M read budget). A client uses an
estimate as the transaction's gas limit, so that guard is the only thing between
such an assignment and a silently wrong number.

Both tables are now `Object.freeze`d. Reading them is unchanged; WRITING to
either now fails at the assignment (a `TypeError` in strict mode, a dropped write
in sloppy mode) instead of silently removing the guard. The guard deliberately
still reads the tables themselves rather than a copy taken at module load, so the
table a consumer inspects and the table the engine consults cannot disagree; the
reasoning is recorded at the code site in `src/revm.ts`.

No behaviour changes for any admitted fork (`berlin`, `london`, `paris`,
`shanghai`, `cancun` — unchanged), and no refusal message changed. Also asserted
now, in `test/revm-engine.spec.ts`: the tables report frozen, a re-admitting edit
leaves them exactly as they were, the guard still refuses `prague` afterwards in
the same words, and the engine's existing refusal to serve a read before
`connect()` bound it to a node is measured rather than merely written.
