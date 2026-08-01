/**
 * evm.spec.ts — drives each in-browser EVM backend in a real Chromium under
 * Playwright via playwright-browser-harness, asserts correctness, and prints the
 * measured timings. It also measures per-backend bundle size by building each
 * cut alone with esbuild and weighing the output (gzipped + raw).
 *
 * Build + serve ONCE for the whole file (the cut bundles all backends), reusing
 * the harness's `buildBundle` (with the `nodePolyfills` preset for ethereumjs/
 * tevm's buffer/process needs) + its COOP/COEP server via the `prebuilt` mount.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {mkdtemp, copyFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {
	mountHarness,
	buildBundle,
	startServer,
} from 'playwright-browser-harness';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

const BACKENDS = [
	'ethereumjs-tuned',
	'ethereumjs-default',
	'tevm',
	'embedded-eth-node',
	'embedded-eth-node-trusted',
	'embedded-eth-node-fabricated',
	'revm',
] as const;

// The revm-wasm module ships prebuilt inside the `revm-wasm` package, so there is
// nothing to build and nothing to vendor: this is where the served copy comes
// from, and where the bundle-size row weighs it.
const revmWasmPath = require.resolve('revm-wasm/revm.wasm');

const TX_COUNT = 20;
const SUM_TO = 2000;
const EXPECTED_SUM = ((SUM_TO - 1) * SUM_TO) / 2; // 1999000
const KECCAK_ITERS = 2000;
// One simulated on-chain-game frame = this many small view reads back to back.
const FRAME_CALLS = 100;
const FRAME_BUDGET_MS = 16.6; // 60fps
// Cross-backend keccak correctness: every backend must produce the SAME chained
// keccak256 result. We don't hardcode the value — we assert all backends agree
// (and the first run pins it), which catches any keccak/abi.encodePacked drift.
let keccakReference: string | undefined;
// Cross-backend GAS equality. Every backend implements the same spec, so the same
// call MUST cost the same execution gas. This is the gate for ever replacing the
// interpreter (e.g. with a Rust/Zig wasm EVM): engines that disagree on gas
// disagree on where execution runs OUT of gas, so a client that replays the chain
// would fork. Matching return values is NOT sufficient — gas must match too.
const gasReference: Record<string, string> = {};

const collected: Record<string, unknown>[] = [];

/**
 * THE DEFAULT ENTRY POINT'S BUNDLE BASELINE, pinned deliberately.
 *
 * Story 3 of `work/specs/tasked/revm-engine-behind-eth-call.md` is "I pay
 * nothing for a feature I do not use": a consumer who imports
 * `embedded-eth-node` and never `embedded-eth-node/revm` must ship no revm. That
 * promise is only worth what enforces it, so these numbers are an ASSERTION and
 * not a printed row — measured with the esbuild config below, by
 * `revm-engine-subpath`, the change that added the subpath.
 *
 * WHAT THEY SAY, precisely: the same measurement immediately BEFORE that change
 * was 412.3 KB raw / 124.0 KB gzip, so adding a whole second EVM engine to the
 * package cost the default entry 0.1 KB — and that 0.1 KB is not revm. It is the
 * node-side `getBlockHash` accessor added to `ReadEngineContext` (real core code,
 * a few lines in `node.ts`). Zero bytes of `revm-wasm` are in this graph, which
 * is what the metafile check below states directly.
 *
 * Re-pin DELIBERATELY when the default entry legitimately grows, in the same
 * change that grows it, and say why in the changeset. A red assertion here means
 * either that or an accidental import into the core graph.
 *
 * Raw bytes are esbuild-deterministic, so that bound is exact. The gzip bound
 * carries 1% of slack because the zlib shipped with different Node builds does
 * not compress byte-identically, which is noise rather than growth.
 */
const DEFAULT_ENTRY_BASELINE = {rawKB: 412.4, gzipKB: 124.1};
const GZIP_SLACK = 1.01;

// Build + serve once for the whole file (the cut contains all backends).
let prebuilt: {outdir: string; serverUrl: string};
let closeServer: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	const outdir = await mkdtemp(join(tmpdir(), 'evm-harness-'));
	await buildBundle({
		cut,
		outdir,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	// The backend fetches the module at runtime, so the .wasm has to sit next to
	// the bundle in the served directory.
	await copyFile(revmWasmPath, join(outdir, 'revm.wasm'));
	const srv = await startServer({root: outdir, coi: false});
	prebuilt = {outdir, serverUrl: srv.url};
	closeServer = srv.close;
});

test.afterAll(async () => {
	if (closeServer) await closeServer();
});

for (const backend of BACKENDS) {
	test(`backend ${backend}: deploy + ${TX_COUNT} state transitions + read + compute`, async ({
		page,
	}) => {
		const h = await mountHarness(page, {cut, coi: false, prebuilt});
		const r = await h.run({
			phase: 'once',
			params: {
				backend,
				txCount: TX_COUNT,
				sumTo: SUM_TO,
				keccakIters: KECCAK_ITERS,
				frameCalls: FRAME_CALLS,
				repeat: 7,
			},
		});

		console.log(`\n[${backend}] errors:`, r.errors);
		console.log(`[${backend}] results:`, JSON.stringify(r.results));
		console.log(`[${backend}] timings:`, JSON.stringify(r.timings));

		expect(r.errors).toEqual([]);
		expect(r.results.finalNumber).toBe(String(TX_COUNT));
		expect(r.results.computeResult).toBe(String(EXPECTED_SUM));

		// keccak256 chain result must be a 32-byte hash and IDENTICAL across all
		// backends (they all run the same EVM spec — divergence = a real bug).
		const keccak = r.results.keccakResult as string;
		expect(keccak).toMatch(/^0x[0-9a-f]{64}$/);
		if (keccakReference === undefined) keccakReference = keccak;
		else expect(keccak).toBe(keccakReference);

		// GAS EQUALITY across backends — the interpreter-swap gate (see gasReference).
		// Backends that don't expose execution gas simply skip; those that do must all
		// agree, exactly, for every probed call.
		for (const key of ['computeGas', 'keccakGas', 'readGas'] as const) {
			const got = r.results[key] as string | undefined;
			if (got === undefined) continue;
			expect(BigInt(got) > 0n).toBe(true);
			if (gasReference[key] === undefined) gasReference[key] = got;
			else
				expect(
					`${key}=${got}`,
					`backend ${backend} charged different gas for ${key} than the first backend — ` +
						`the engines disagree on the spec, which is a state-fork risk`,
				).toBe(`${key}=${gasReference[key]}`);
		}

		// NOTE: embedded-eth-node's own honesty/correctness/conformance assertions
		// live in the library package's test suite (slim-node-checks, conformance,
		// statetest, viem-surface, persistence-reload). This benchmark only measures
		// the cross-backend perf + asserts keccak-chain equality above.

		const t = Object.fromEntries(r.timings.map((x) => [x.label, x.ms]));
		collected.push({
			backend,
			...t,
			framePerCallMs: t.frame != null ? t.frame / FRAME_CALLS : undefined,
			frameFitsIn60fps:
				t.frame != null ? t.frame <= FRAME_BUDGET_MS : undefined,
			computeMGasPerSec: r.results.computeMGasPerSec,
			keccakMGasPerSec: r.results.keccakMGasPerSec,
			computeGas: r.results.computeGas,
			keccakGas: r.results.keccakGas,
			keccakResult: r.results.keccakResult,
			legacyTxReceiptBite: r.results.legacyTxReceiptBite,
		});

		await h.dispose();
	});
}

// EVERY backend must actually RUN. A backend that silently drops out takes its
// gas row out of the gate above without failing anything, which is how a gate
// quietly stops being one. The revm row used to skip whenever its wasm was not
// vendored on the machine; it is an ordinary npm dependency now, so nothing here
// is conditional and this test says so out loud.
test('every backend contributed to the gate', () => {
	expect(collected.map((c) => c.backend)).toEqual([...BACKENDS]);
	const revm = collected.find((c) => c.backend === 'revm');
	expect(revm?.computeGas).toBe(gasReference.computeGas);
	expect(revm?.keccakGas).toBe(gasReference.keccakGas);
	expect(revm?.keccakResult).toBe(keccakReference);
});

test('bundle size per backend (raw + gzip)', async () => {
	const bufferEntry = require.resolve('buffer/');
	const sizes: Record<string, {rawKB: number; gzipKB: number}> = {};
	// The default entry's module graph, kept for the "revm is not in it" check.
	let defaultEntryInputs: string[] = [];
	for (const backend of BACKENDS) {
		// the trusted/fabricated rows are the SAME package as 'embedded-eth-node'
		// (only a node option and the send path differ), so they add no bytes and
		// need no separate size entry.
		if (backend.startsWith('embedded-eth-node-')) continue;
		// revm's cost is the .wasm itself, reported separately below; esbuild cannot
		// weigh a module that is fetched at runtime.
		if (backend === 'revm') continue;
		const entry =
			backend === 'tevm'
				? `import {makeTevmBackend} from '${resolve(here, './helpers/backend-tevm.ts')}'; console.log(makeTevmBackend);`
				: backend === 'ethereumjs-default'
					? `import {makeEthereumjsDefaultBackend} from '${resolve(here, './helpers/backend-ethereumjs.ts')}'; console.log(makeEthereumjsDefaultBackend);`
					: backend === 'embedded-eth-node'
						? `import {createNode} from 'embedded-eth-node'; console.log(createNode);`
						: `import {makeEthereumjsTunedBackend} from '${resolve(here, './helpers/backend-ethereumjs.ts')}'; console.log(makeEthereumjsTunedBackend);`;
		const out = await esbuild.build({
			stdin: {contents: entry, resolveDir: here, loader: 'ts'},
			bundle: true,
			format: 'esm',
			target: 'es2022',
			platform: 'browser',
			minify: true,
			write: false,
			plugins: [
				{
					name: 'buf',
					setup(b) {
						b.onResolve({filter: /^(node:)?buffer$/}, () => ({
							path: bufferEntry,
						}));
						b.onResolve({filter: /^(node:)?process$/}, () => ({
							path: 'p',
							namespace: 's',
						}));
						b.onLoad({filter: /^p$/, namespace: 's'}, () => ({
							contents: 'export default {env:{},browser:true};',
							loader: 'js',
						}));
					},
				},
			],
			define: {global: 'globalThis'},
			metafile: true,
		});
		if (backend === 'embedded-eth-node')
			defaultEntryInputs = Object.keys(out.metafile.inputs);
		const raw = out.outputFiles[0].contents;
		const gz = gzipSync(raw);
		sizes[backend] = {
			rawKB: +(raw.byteLength / 1024).toFixed(1),
			gzipKB: +(gz.byteLength / 1024).toFixed(1),
		};
	}
	const wasm = await readFile(revmWasmPath);
	sizes['revm (wasm module only)'] = {
		rawKB: +(wasm.byteLength / 1024).toFixed(1),
		gzipKB: +(gzipSync(wasm).byteLength / 1024).toFixed(1),
	};
	expect(sizes['revm (wasm module only)'].rawKB).toBeGreaterThan(0);

	console.log('\n=== bundle sizes ===\n', JSON.stringify(sizes, null, 2));

	// THE DEFAULT ENTRY HAS NOT GROWN. `embedded-eth-node/revm` is a separate
	// entry point and the core references only the `ReadEngine` TYPE (erased at
	// build time), so a consumer who does not opt in ships exactly what they
	// shipped before revm existed.
	expect(
		sizes['embedded-eth-node'].rawKB,
		`the default entry point grew to ${sizes['embedded-eth-node'].rawKB} KB raw (baseline ${DEFAULT_ENTRY_BASELINE.rawKB} KB) — ` +
			'either something was imported into the core graph, or the growth is intended and this baseline must be re-pinned in the same change',
	).toBeLessThanOrEqual(DEFAULT_ENTRY_BASELINE.rawKB);
	expect(sizes['embedded-eth-node'].gzipKB).toBeLessThanOrEqual(
		DEFAULT_ENTRY_BASELINE.gzipKB * GZIP_SLACK,
	);
	// ...and revm is not in its dependency graph AT ALL. The size bound alone
	// would not catch a small accidental import; this names the thing.
	const revmInputs = defaultEntryInputs.filter((p) => p.includes('revm-wasm'));
	expect(
		revmInputs,
		"`revm-wasm` reached the default entry point's module graph; it belongs to the `embedded-eth-node/revm` subpath only",
	).toEqual([]);
	expect(defaultEntryInputs.length).toBeGreaterThan(0);
	console.log(
		'\n=== collected timings ===\n',
		JSON.stringify(collected, null, 2),
	);

	// Throughput table. MGas/s is the backend-independent unit: comparable across
	// engines AND to published evmone/revm/geth figures, unlike wall-clock ms which
	// only means something for this exact contract.
	console.log('\n=== interpreter throughput + frame budget ===');
	console.log(
		'backend'.padEnd(20) +
			'compute'.padStart(14) +
			'keccak'.padStart(14) +
			'frame/call'.padStart(13) +
			'floor/call'.padStart(13) +
			'  60fps?',
	);
	for (const c of collected) {
		const n = (v: unknown, d = 2) =>
			typeof v === 'number' ? v.toFixed(d) : String(v ?? '-');
		console.log(
			String(c.backend).padEnd(20) +
				`${n(c.computeMGasPerSec)} MGas/s`.padStart(14) +
				`${n(c.keccakMGasPerSec)} MGas/s`.padStart(14) +
				`${n(c.framePerCallMs, 3)} ms`.padStart(13) +
				`${n(c.floor, 3)} ms`.padStart(13) +
				`  ${c.frameFitsIn60fps ? 'yes' : 'NO'}`,
		);
	}
	console.log(
		`\nframe = ${FRAME_CALLS} small view reads back to back; 60fps budget = ${FRAME_BUDGET_MS} ms/frame`,
	);
});
