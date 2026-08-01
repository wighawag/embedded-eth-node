import {defineConfig, devices} from '@playwright/test';

// The benchmarks use playwright-browser-harness, which brings up its OWN
// COOP/COEP server per test, so there is no `webServer` entry. EVM execution
// needs no cross-origin isolation, so coi:false.
//
// TWO ENGINES, on purpose. A JS EVM and a wasm EVM do not degrade the same way
// across engines, and measuring only V8 hides it:
//
//                        compute, Chromium -> WebKit (quiet machine)
//   @ethereumjs/evm            24.8 -> 36.0 ms   (1.45x slower)
//   revm-wasm                   2.2 ->  2.0 ms   (no penalty)
//
// So revm's lead widens from ~11x on Chromium to ~18x on WebKit. What matters for
// a game is the frame budget (100 small view reads against 16.6ms for 60fps):
//
//                        Chromium        WebKit
//   embedded-eth-node    12.4ms (75%)    15.0ms (90%)   <- on the edge
//   revm-wasm             3.8ms (23%)     5.0ms (30%)
//
// The JS node FITS on a quiet machine and falls out of budget under load; revm
// keeps ~3x headroom. Headroom, not the median, is what decides whether frames
// drop.
//
// BOTH ROWS ABOVE ARE RAW backends, which is not what a consumer ships. The
// `embedded-eth-node-revm-engine` row measures the node WITH the revm read engine
// installed, and that is the number to cite for the recommended configuration:
// it keeps essentially all of raw revm's frame win (the node's own dispatch is
// what remains, and at this call shape it is small). Measured figures, with their
// conditions and the WebKit 1 ms clamp caveat, live in
// docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md.
//
// CORRECTION, recorded on purpose: an earlier revision of this comment claimed
// 2.6-3.6x and "revm is the only backend that fits 60fps on WebKit". That came
// from a single WebKit run taken while the machine was loaded, and it overstated
// the effect roughly twofold. The numbers above are from quiet-machine runs of
// both engines; JS compute on WebKit varied 32-47ms across repeats, so treat the
// ratio as ~1.3-1.9x rather than a constant.
//
// `webkit` is JavaScriptCore + WebKit's wasm engine, i.e. Safari's engine, but it
// is NOT Safari.app and NOT iOS. Treat it as a strong proxy for "does JSC have a
// wasm cliff here" (it does not), and still measure on a real device before
// shipping. `firefox` can be added the same way if SpiderMonkey matters.
//
// CAVEAT, WebKit only: `performance.now()` is clamped to 1 ms (Spectre
// mitigation), so any row below a few ms is quantised and untrustworthy there.
// The `read` and `floor` rows are meaningless on WebKit; `compute`, `keccak` and
// `frame` are large enough to trust.
export default defineConfig({
	testDir: './test',
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	// Generous on purpose. This is a benchmark suite, not a unit suite: the slowest
	// backend (tevm, ~20ms per view call) pays ~2.2s per repeat for the 100-call
	// frame row alone, and each backend runs 7 repeats. 120s was borderline on an
	// idle laptop and flaked under load; a shared CI runner is slower still.
	timeout: 300_000,
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
