/**
 * The BUNDLER-RESOLVED wasm delivery shape, for TypeScript.
 *
 * `revm-wasm` exports its prebuilt module as a `./revm.wasm` subpath, which a
 * bundler resolves as an ASSET rather than as code. The suite builds it with
 * esbuild's `binary` loader (Vite's `?arraybuffer`, webpack's `asset/inline`),
 * so the bytes are in the build and the browser fetches nothing. TypeScript has
 * no notion of that, so the test suite declares the shape it gets back.
 */
declare module 'revm-wasm/revm.wasm' {
	// Over a plain `ArrayBuffer` (never a `SharedArrayBuffer`), which is what makes
	// the bytes a `BufferSource` — i.e. directly compilable with
	// `WebAssembly.compile`, as ./helpers/revm-conformance.ts does to share ONE
	// compilation across the several engines its battery needs.
	const bytes: Uint8Array<ArrayBuffer>;
	export default bytes;
}
