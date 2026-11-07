import { defineConfig, devices } from '@playwright/test';

// Browser tests against the built app the Go binary embeds, so the real CSP
// and the real headers are exercised. Each spec file starts its own throwaway
// server through tests/server.ts; `just web-e2e` builds the app first.
export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: { trace: 'retain-on-failure' },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		// The stand-in for Safari, on the few flows every browser must do. It needs
		// the EGL driver the flake's shell points at (flake.nix).
		{ name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: 'smoke.spec.ts' }
	]
});
