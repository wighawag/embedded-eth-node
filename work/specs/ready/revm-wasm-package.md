---
title: A published revm-wasm package, built reproducibly from a pinned revm
slug: revm-wasm-package
humanOnly: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

The revm WebAssembly artifact that both engine specs depend on currently exists only as an untracked scratch directory inside a local clone of revm. It is copied into this repo on demand by `scripts/vendor-revm.mjs` and deliberately gitignored, because it is a ~1.2 MB binary from an external exploration rather than a dependency.

That is fine for evaluation and impossible for shipping. There is no published package, no reproducible build, no version anyone else can install, and no home for the Rust that produces it. Until that exists, `embedded-eth-node` cannot depend on revm at all — a consumer would have to build it themselves.

Worse, the consuming code currently owns things the package should: the benchmark backend hand-rolls the outcome-blob decoder, the 72-byte account packing and the host wiring. The blob format has already moved v1 to v2 to v3, and each move silently invalidated a hand-rolled decoder.

## Solution

A SEPARATE repository producing an npm package that ships the prebuilt `.wasm` plus a typed JavaScript API, so consumers need no Rust toolchain. It owns everything below the engine seam: the wasm, the glue, the host implementation, the decoder and the types.

`embedded-eth-node` then depends on a published version instead of a vendored scratch build, and `scripts/vendor-revm.mjs` and the gitignored `vendor/` directory can be retired.

## User Stories

1. As a consumer, I want to install the package from npm and get a working EVM with no Rust toolchain, so that using it is as easy as any other dependency.
2. As a consumer, I want TypeScript types for the whole surface, so that the `@ts-ignore`s in the consuming code disappear.
3. As a consumer, I want a typed decoder for execution results, so that I never parse bytes myself and a format change is a compile error rather than a silent misparse.
4. As a consumer, I want the package to expose the standalone `ecrecover`, so that I can use it for sender recovery independently of running the interpreter.
5. As a consumer, I want to obtain the wasm either as a bundler-resolved asset or by fetching a URL at runtime, so that both delivery shapes in the engine specs are supported by the package rather than by each consumer.
6. As a consumer, I want the revm version and the blob format version readable at runtime, so that a bug report can state exactly what was running.
7. As a maintainer, I want the artifact built from an exactly pinned revm revision with pinned toolchain versions, so that a rebuild is reproducible and auditable.
8. As a maintainer, I want the build to run in the package repo's own release workflow, so that no Rust toolchain is ever required in `embedded-eth-node`'s CI.
9. As a maintainer, I want storage in the JS host INDEXED PER ACCOUNT, so that clearing an account's storage is proportional to that account rather than to total state.
10. As a maintainer, I want the package's own test suite to include the engine's differential fixtures, so that a rebuild that changes behaviour fails in the package rather than downstream.
11. As a maintainer, I want the acceptance check for a rebuild to be behavioural rather than byte-identity, so that a toolchain bump that produces different bytes but identical results is not a false alarm.
12. As a maintainer, I want the package MIT licensed, matching revm, so that it can ship inside this MIT package.

## Implementation Decisions

- A SEPARATE repository, not a directory in this monorepo. The Rust toolchain belongs in the package's repo, not in `embedded-eth-node`'s CI. Confirmed with the maintainer.
- Ship the prebuilt `.wasm` in the published tarball. Consumers never build.
- Build configuration is fixed by measurement and both halves are load-bearing: **all precompiles, `opt-level = 3`**. Subsetting precompiles CHANGES GAS, because an omitted precompile address stops being pre-warmed and costs an extra cold access; and `opt-level = "z"` halves the artifact but costs 2.4x to 6x on keccak, which is the workload that motivated the whole exercise.
- Pin revm by exact revision, and pin the rustc, wasm-bindgen and wasm-opt versions used, since all three move the output bytes.
- Do NOT assert byte-identity on rebuild. Assert the behavioural gate instead: gas equality and result equality against recorded fixtures.
- The package owns the outcome decoder, the account packing, the host implementation and the types. Consumers should never see a byte offset.

## Testing Decisions

- The engine's existing differential harness runs with no Rust toolchain and should move into the package as its test suite: recorded expected outcomes plus the wasm, compared byte for byte.
- The behavioural acceptance check for any rebuild is the same one `embedded-eth-node` uses downstream: identical execution gas and identical results. That check has already caught a real non-conformance, so it is the right bar.
- Test in more than one JavaScript engine. A wasm module behaves differently enough across V8 and JavaScriptCore that measuring only one hid a material difference during evaluation.

## Out of Scope

- Changes to `embedded-eth-node` itself: consuming the published package is part of the two engine specs, and retiring `scripts/vendor-revm.mjs` follows once a published version exists.
- Upstreaming anything to revm. The only change made to revm during evaluation was a one-file `Cargo.toml` tweak so its own test runner could reach the pure-Rust backends; offering that upstream is optional and unrelated.
- Supporting build configurations other than all-precompiles at `opt-level = 3`, unless a measured need appears.

## Further Notes

- Current artifact size: 434,009 bytes gzipped for the shipping configuration, roughly 2.4x under the 1 MB ceiling the maintainer set.
- The exploration produced three reports (feasibility and size; logs, code and commit; fees, access lists and a fee-aware differential) which are the design input for this package and should be carried across rather than re-derived.
- `humanOnly` is set because creating a repository, choosing a package name and configuring publishing are decisions a human must drive, not because the work itself needs human judgement.
