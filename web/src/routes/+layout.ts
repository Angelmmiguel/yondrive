import { theme } from '$lib/state/theme.svelte';

// Everything past sign-in is decrypted in the browser, so there is nothing a
// server could render: the app is a pure SPA behind adapter-static's
// index.html fallback.
export const ssr = false;

/** Runs once per page load; client-side navigation does not repeat it. */
export function load(): void {
	theme.start();
}
