import { defineConfig, mergeConfig } from 'vitest/config';
import { svelteTesting } from '@testing-library/svelte/vite';
import viteConfig from './vite.config.ts';

// The tests' own config, on top of the app's. What only tests need is loaded
// here, so `vite build` never runs it.
export default mergeConfig(
	viteConfig,
	defineConfig({
		plugins: [svelteTesting()],
		test: {
			environment: 'node',
			expect: { requireAssertions: true },
			include: ['src/**/*.{test,spec}.{js,ts}']
		}
	})
);
