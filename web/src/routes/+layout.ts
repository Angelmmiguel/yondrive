import { boot, bootLink } from '$lib/app/boot';
import { isLinkPath } from '$lib/app/routing';
import { theme } from '$lib/state/theme.svelte';

// Everything past sign-in is decrypted in the browser, so there is nothing a
// server could render: the app is a pure SPA behind adapter-static's
// index.html fallback.
export const ssr = false;

/** Runs once per page load; client-side navigation does not repeat it. */
export async function load(): Promise<void> {
	theme.start();
	// From the address, not the `url` argument, so that this does not run again on every navigation.
	await (isLinkPath(location.pathname) ? bootLink() : boot());
}
