/**
 * What a screen does with an error: a sentence to show. A session the server no
 * longer knows also moves the app to sign-in, whichever screen found out.
 */
import { defaultDeps, type Deps } from '$lib/account/deps';
import { describeError } from '$lib/account/errors';
import { isApiError } from '$lib/api/types';

export function failure(e: unknown, deps: Pick<Deps, 'session'> = defaultDeps): string {
	if (isApiError(e, 'unauthorized')) deps.session.signedOut();
	return describeError(e);
}
