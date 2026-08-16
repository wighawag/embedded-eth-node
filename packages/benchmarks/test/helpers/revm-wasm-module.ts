/**
 * revm-wasm-module.ts — compile the revm `.wasm` ONCE per page, share it.
 *
 * Two backends need the module: `backend-revm.ts` (raw revm, driving everything)
 * and `backend-slim-node.ts`'s revm-engine row (the node with
 * `webevm/revm` installed). Compilation is the expensive half and the
 * scenario runs a backend several times over, so re-fetching and re-compiling per
 * run would show up in the `coldStart` row as an artefact of the harness rather
 * than of the engine under test. Each run still gets its own INSTANCE, its own
 * linear memory and its own state, so no run can observe another's.
 *
 * The `.wasm` is copied out of the `revm-wasm` package and served next to the
 * bundle by `evm.spec.ts`. It is fetched by URL rather than reached through
 * `revm-wasm/wasm-url`, because the benchmark bundle is built by a bare esbuild
 * pass with no asset pipeline to rewrite an `import.meta.url` reference.
 *
 * Compiled from bytes rather than with `compileStreaming`, which would throw on a
 * static server that does not label the file `application/wasm`. Streaming would
 * save a few milliseconds once per page, and no measured row includes it.
 */
let modulePromise: Promise<WebAssembly.Module> | undefined;

export function compiledRevmModule(): Promise<WebAssembly.Module> {
	if (!modulePromise) {
		modulePromise = fetch(new URL('revm.wasm', location.href))
			.then((res) => res.arrayBuffer())
			.then((bytes) => WebAssembly.compile(bytes));
	}
	return modulePromise;
}
