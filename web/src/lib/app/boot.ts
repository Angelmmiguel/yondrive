/**
 * What runs once per page load, and again when setup finishes: asks the server
 * what state it is in, runs the guard on what it claims and, with a live session,
 * reopens it. Screens then follow `session`.
 */
import { defaultDeps, type Deps } from '$lib/account/deps';
import { ModeRefusedError } from '$lib/account/errors';
import { acceptMode } from '$lib/account/mode';
import { resume } from '$lib/account/session';
import { isApiError } from '$lib/api/types';

export async function boot(deps: Deps = defaultDeps): Promise<void> {
	const { api, session } = deps;
	try {
		const health = await api.getHealth();
		session.health = health;
		if (!health.setup) {
			session.status = 'needs-setup';
			return;
		}
		session.sealer = acceptMode(health.mode, null, deps);
		await resume(await api.getMe(), deps);
	} catch (e) {
		if (e instanceof ModeRefusedError) return;
		if (isApiError(e, 'unauthorized')) session.signedOut();
		else session.status = 'offline';
	}
}
