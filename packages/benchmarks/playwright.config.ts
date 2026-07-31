import {defineConfig, devices} from '@playwright/test';

// The benchmarks use playwright-browser-harness, which brings up its OWN
// COOP/COEP server per test, so there is no `webServer` entry. EVM execution
// needs no cross-origin isolation, so coi:false.
//
// TWO ENGINES, on purpose. A JS EVM and a wasm EVM do NOT degrade the same way
// across engines, and measuring only V8 hides it completely:
//
//                        compute, Chromium -> WebKit
//   @ethereumjs/evm            22.5 -> 76.0 ms   (2.6-3.6x SLOWER)
//   revm-wasm                   2.7 ->  2.0 ms   (no penalty; slightly faster)
//
// On WebKit every JS backend misses a 60fps frame budget and revm is the only one
// that fits. For an in-browser game targeting Safari/iOS that is the single most
// decision-relevant number in this suite, and it is invisible on Chromium alone.
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
	timeout: 120_000,
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
