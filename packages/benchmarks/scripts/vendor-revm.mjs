/**
 * vendor-revm.mjs — copy the revm-wasm spike artifacts into `vendor/revm/` so the
 * benchmark can bundle them, or install a STUB when they are not available.
 *
 * The artifacts are produced by a separate feasibility spike in a revm clone and
 * are NOT committed here: `evm_bg.wasm` alone is ~1.1 MB, and it is an external
 * exploration rather than a dependency of this repo. `vendor/` is gitignored.
 *
 * The stub matters: `backend-revm.ts` imports these paths STATICALLY so esbuild
 * can bundle them, which means the import must resolve even on a machine that has
 * never seen the spike. The stub resolves and throws only if actually called, and
 * `vendor/revm/present.json` tells the spec whether to run the backend at all.
 *
 * Usage:
 *   node scripts/vendor-revm.mjs [srcDir]
 *   REVM_SPIKE_DIST=/path/to/dist-speed/c-all-precompiles node scripts/vendor-revm.mjs
 *
 * Default source is the sibling revm clone's speed-optimised, all-precompiles
 * build. That configuration is deliberate: the spike measured that omitting
 * precompiles CHANGES GAS (omitted addresses stop being pre-warmed, costing
 * +2500 per cold access), and that `opt-level="z"` costs ~5x on keccak. So the
 * only configuration that is both gas-equivalent to a real node and fast enough
 * to be worth measuring is `c-all-precompiles` at `-O3`.
 */
import {
	existsSync,
	mkdirSync,
	copyFileSync,
	writeFileSync,
	statSync,
} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const outDir = join(pkgRoot, 'vendor', 'revm');

const DEFAULT_DIST = resolve(
	pkgRoot,
	'../../../revm/spike/dist-speed/c-all-precompiles',
);
const dist = resolve(
	process.argv[2] ?? process.env.REVM_SPIKE_DIST ?? DEFAULT_DIST,
);
// `eeth_host.js` in the dist tree is only a re-export shim pointing back into the
// spike's harness; copy the real implementation over it so `vendor/revm` is
// self-contained and bundleable.
const hostSrc = resolve(dist, '../../harness/eeth_host.js');

mkdirSync(outDir, {recursive: true});

const need = [
	['evm.js', join(dist, 'evm.js')],
	['evm_bg.wasm', join(dist, 'evm_bg.wasm')],
	['eeth_host.js', hostSrc],
];
const missing = need.filter(([, src]) => !existsSync(src));

if (missing.length === 0) {
	for (const [name, src] of need) copyFileSync(src, join(outDir, name));
	const wasmBytes = statSync(join(outDir, 'evm_bg.wasm')).size;
	writeFileSync(
		join(outDir, 'present.json'),
		JSON.stringify({present: true, source: dist, wasmBytes}, null, 2),
	);
	console.log(
		`vendored revm from ${dist} (evm_bg.wasm ${(wasmBytes / 1024).toFixed(0)} KB)`,
	);
} else {
	// Stub: resolves so the bundle always builds; throws only if someone runs it
	// anyway, and never silently pretends to be a working EVM.
	const why =
		`revm wasm artifacts are not vendored. Run the revm feasibility spike, then:\n` +
		`  node scripts/vendor-revm.mjs [pathTo/dist-speed/c-all-precompiles]\n` +
		`missing: ${missing.map(([, s]) => s).join(', ')}`;
	const thrower = (name) =>
		`export function ${name}() { throw new Error(${JSON.stringify(why)}); }\n`;
	writeFileSync(
		join(outDir, 'evm.js'),
		`// AUTO-GENERATED STUB - see scripts/vendor-revm.mjs\n` +
			`export default async function init() { throw new Error(${JSON.stringify(why)}); }\n` +
			thrower('call') +
			thrower('call_persistent') +
			thrower('call_noop') +
			thrower('build_config') +
			thrower('initSync'),
	);
	writeFileSync(
		join(outDir, 'eeth_host.js'),
		`// AUTO-GENERATED STUB - see scripts/vendor-revm.mjs\n` +
			thrower('setMemory') +
			thrower('setHost') +
			thrower('setNullStorage') +
			thrower('makeState'),
	);
	writeFileSync(
		join(outDir, 'present.json'),
		JSON.stringify({present: false, expected: dist}, null, 2),
	);
	console.log(`revm artifacts NOT found at ${dist} - installed stub.`);
	console.log('the revm benchmark row will be skipped.');
}
