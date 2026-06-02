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
import {mkdtemp} from 'node:fs/promises';
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
] as const;

const TX_COUNT = 20;
const SUM_TO = 2000;
const EXPECTED_SUM = ((SUM_TO - 1) * SUM_TO) / 2; // 1999000
const KECCAK_ITERS = 2000;
// Cross-backend keccak correctness: every backend must produce the SAME chained
// keccak256 result. We don't hardcode the value — we assert all backends agree
// (and the first run pins it), which catches any keccak/abi.encodePacked drift.
let keccakReference: string | undefined;

const collected: Record<string, unknown>[] = [];

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

		// NOTE: embedded-eth-node's own honesty/correctness/conformance assertions
		// live in the library package's test suite (slim-node-checks, conformance,
		// statetest, viem-surface, persistence-reload). This benchmark only measures
		// the cross-backend perf + asserts keccak-chain equality above.

		const t = Object.fromEntries(r.timings.map((x) => [x.label, x.ms]));
		collected.push({
			backend,
			...t,
			keccakResult: r.results.keccakResult,
			legacyTxReceiptBite: r.results.legacyTxReceiptBite,
		});

		await h.dispose();
	});
}

test('bundle size per backend (raw + gzip)', async () => {
	const bufferEntry = require.resolve('buffer/');
	const sizes: Record<string, {rawKB: number; gzipKB: number}> = {};
	for (const backend of BACKENDS) {
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
		});
		const raw = out.outputFiles[0].contents;
		const gz = gzipSync(raw);
		sizes[backend] = {
			rawKB: +(raw.byteLength / 1024).toFixed(1),
			gzipKB: +(gz.byteLength / 1024).toFixed(1),
		};
	}
	console.log('\n=== bundle sizes ===\n', JSON.stringify(sizes, null, 2));
	console.log(
		'\n=== collected timings ===\n',
		JSON.stringify(collected, null, 2),
	);
});
