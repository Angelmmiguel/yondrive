import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

// The Go server listens on YONDRIVE_ADDR (its own default is 127.0.0.1:8080),
// and Vite proxies to the same address, so changing the port is one variable in
// .env.local for both halves. A bare ":port" means loopback.
const addr = process.env.YONDRIVE_ADDR ?? '127.0.0.1:8080';
const apiTarget = `http://${addr.startsWith(':') ? `127.0.0.1${addr}` : addr}`;

// SvelteKit options live in svelte.config.js; passing any of them here would
// make SvelteKit ignore that file.
export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
	build: {
		// The CSP allows no data: fonts, so no asset may be inlined into the CSS.
		assetsInlineLimit: 0
	},
	server: {
		// The browser only ever talks to Vite, which forwards /api to the Go
		// server: one origin, so `Sec-Fetch-Site: same-origin` reaches Go
		// unchanged and cookies behave exactly as in production. No
		// changeOrigin and no rewrite, for the same reason. /auth is where an
		// identity provider sends a browser back to.
		proxy: { '/api': apiTarget, '/auth': apiTarget }
	},
	test: {
		environment: 'node',
		expect: { requireAssertions: true },
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
