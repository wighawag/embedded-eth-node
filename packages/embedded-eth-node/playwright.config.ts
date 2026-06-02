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
	projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
