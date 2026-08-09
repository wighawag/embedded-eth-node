/**
 * support.mjs: dependency resolution and timing helpers shared by the three
 * probes in this folder. No measurement lives here.
 *
 * WHY THE RESOLUTION DANCE. These probes must run with NO install of their own
 * (the spike may not touch `package.json` or `pnpm-lock.yaml`), so they borrow
 * the repo's installed packages, exactly as
 * `docs/spikes/prague-intrinsic-gas-floor-or-refuse/probe-hardfork-costing.mjs`
 * does. One extra step is needed here: `require.resolve` returns the CJS build,
 * and the node's own `dist/` imports the ESM one, a different module instance
 * with a DIFFERENT `SimpleStateManager` class object. Probe 2 counts checkpoints
 * by patching that class's prototype, which would silently count nothing if it
 * patched the CJS copy. So we map `dist/cjs` -> `dist/esm` and assert the
 * identity we depend on ({@link assertSameStateManagerInstance}).
 */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const HERE = new URL('.', import.meta.url);
/** Repo root, from this file's fixed location under `docs/spikes/<slug>/`. */
export const REPO_ROOT = new URL('../../../', HERE);
const NODE_PKG = new URL('packages/embedded-eth-node/package.json', REPO_ROOT);

const require = createRequire(NODE_PKG);

/** Import a dependency of `embedded-eth-node` as ESM, not as its CJS twin. */
export async function dep(name) {
	const cjs = require.resolve(name);
	const esm = cjs.includes('/dist/cjs/')
		? cjs.replace('/dist/cjs/', '/dist/esm/')
		: cjs;
	return import(pathToFileURL(esm).href);
}

/** Import a built module of the node itself (`pnpm install` builds `dist/`). */
export async function nodeDist(file) {
	const url = new URL(`packages/embedded-eth-node/dist/${file}`, REPO_ROOT);
	try {
		return await import(url.href);
	} catch (err) {
		throw new Error(
			`could not import ${url.pathname}. These probes read the node's BUILT ` +
				`output; run \`pnpm install\` (which builds it) at the repo root first. ` +
				`Cause: ${err.message}`,
		);
	}
}

export const {SimpleStateManager} = await dep('@ethereumjs/statemanager');
export const util = await dep('@ethereumjs/util');
export const {SimpleStateManagerWithClearStorage} = await nodeDist(
	'state-manager.js',
);

/**
 * The node's `stateMode:'none'` state manager and the class these probes patch
 * must be the SAME class object, or every count is a zero that looks like an
 * answer.
 */
export function assertSameStateManagerInstance() {
	const same =
		Object.getPrototypeOf(SimpleStateManagerWithClearStorage.prototype) ===
		SimpleStateManager.prototype;
	if (!same) {
		throw new Error(
			'the @ethereumjs/statemanager this probe resolved is NOT the one the ' +
				"node's dist imports (two module instances). Counting by prototype " +
				'patch would report 0 for everything. Fix the resolution in support.mjs.',
		);
	}
}

// ---------------------------------------------------------------- timing ----

/**
 * Time `fn` and return microseconds per call.
 *
 * Repeats until at least `minMs` of wall clock has elapsed AND `minIters`
 * iterations have run, after a warmup of the same shape. Returns the MEDIAN of
 * `samples` such batches, because a single batch on a JIT that is still warming
 * up is noise, and the median is what survives a GC pause landing in one batch.
 *
 * `setup` (optional) runs before each iteration and is NOT timed, which is what
 * lets a destructive operation (checkpoint, clearStorage) be measured repeatedly
 * against the same starting state. A batch also stops at `maxWallMs` of TOTAL
 * time (setup included), which matters more than it looks: timing a microsecond
 * `commit()` whose setup is a 15 ms `checkpointSync()` would otherwise need
 * millions of iterations to accumulate 50 ms of timed work, and the probe would
 * appear to hang.
 */
export function bench(
	fn,
	{minMs = 50, minIters = 5, samples = 7, maxWallMs = 400, setup} = {},
) {
	const batch = () => {
		let iters = 0;
		let elapsed = 0;
		const deadline = minMs * 1e6;
		const wallDeadline = process.hrtime.bigint() + BigInt(maxWallMs * 1e6);
		while (
			iters < minIters ||
			(elapsed < deadline && process.hrtime.bigint() < wallDeadline)
		) {
			if (setup) setup();
			const t0 = process.hrtime.bigint();
			fn();
			elapsed += Number(process.hrtime.bigint() - t0);
			iters++;
		}
		return elapsed / iters / 1000; // microseconds per call
	};
	batch(); // warmup, discarded
	const results = [];
	for (let i = 0; i < samples; i++) results.push(batch());
	results.sort((a, b) => a - b);
	return results[results.length >> 1];
}

/** Time one async call once, in milliseconds. */
export async function timeAsync(fn) {
	const t0 = process.hrtime.bigint();
	const value = await fn();
	return {ms: Number(process.hrtime.bigint() - t0) / 1e6, value};
}

/** Median of `n` async runs, in milliseconds. */
export async function benchAsync(fn, n = 7) {
	await fn(); // warmup
	const ms = [];
	for (let i = 0; i < n; i++) ms.push((await timeAsync(fn)).ms);
	ms.sort((a, b) => a - b);
	return ms[n >> 1];
}

export const µs = (v) => (v < 10 ? v.toFixed(3) : v < 1000 ? v.toFixed(1) : Math.round(v).toString());

// ------------------------------------------------------------ reporting ----

let failures = 0;

/** A named assertion; prints PASS/FAIL and makes the probe exit non-zero. */
export function check(label, ok, detail = '') {
	if (!ok) failures++;
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  | ${detail}` : ''}`);
	return ok;
}

export function exitWithFailures() {
	if (failures > 0) {
		console.log(`\n${failures} CHECK(S) FAILED\n`);
		process.exitCode = 1;
	} else {
		console.log('\nall checks passed\n');
	}
}

/** Print a markdown-ish table so the output can be pasted into measurements.md. */
export function table(headers, rows) {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
	);
	const line = (cells) =>
		'  | ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
	console.log(line(headers));
	console.log('  |-' + widths.map((w) => '-'.repeat(w)).join('-|-') + '-|');
	for (const r of rows) console.log(line(r));
}

/**
 * The installed version of a dependency, found by walking UP from its resolved
 * entry point to the owning `package.json`.
 *
 * Deliberately not a hard-coded `node_modules/.pnpm/<name>@<version>/…` path:
 * these probes are meant to still RUN (and report the new version) when the
 * package moves, which is the whole point of printing the version at all. A
 * pinned path would make the version bump the probes exist to detect throw
 * before a single measurement was taken.
 */
export async function packageVersion(name) {
	const {readFile} = await import('node:fs/promises');
	const path = await import('node:path');
	let dir = path.dirname(require.resolve(name));
	for (;;) {
		try {
			const pkg = JSON.parse(
				await readFile(path.join(dir, 'package.json'), 'utf8'),
			);
			if (pkg.name === name) return pkg.version;
		} catch {
			// no package.json here, or not the one we want: keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return 'unknown';
		dir = parent;
	}
}

/** The machine and versions every measurement in this folder was taken on. */
export async function environment() {
	const os = await import('node:os');
	return {
		node: process.version,
		platform: `${os.platform()} ${os.arch()}`,
		cpu: os.cpus()[0]?.model ?? 'unknown',
		statemanager: await packageVersion('@ethereumjs/statemanager'),
	};
}

export async function printEnvironment() {
	const env = await environment();
	console.log(
		`  node ${env.node}, ${env.platform}, ${env.cpu}, @ethereumjs/statemanager ${env.statemanager}`,
	);
}
