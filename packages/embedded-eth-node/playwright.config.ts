import {defineConfig, devices} from '@playwright/test';

// The browser tests use playwright-browser-harness, which brings up its OWN
// COOP/COEP server per test, so there is no `webServer` entry. Chromium is the
// target. EVM execution needs no cross-origin isolation (no SharedArrayBuffer /
// OPFS), so the specs run coi:false.
export default defineConfig({
	testDir: './test',
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	timeout: 120_000,
	// Two engines: the node ships to browsers, so its correctness suite should run
	// on more than V8. `webkit` is JavaScriptCore + WebKit, i.e. Safari's engine
	// (not Safari.app, and not iOS — a real device is still needed before shipping).
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
