/**
 * What a screen does with an error: a sentence to show. A session the server no
 * longer knows also moves the app to sign-in, whichever screen found out, and an
 * action that wants a recent sign-in goes off to get one.
 */
import { defaultDeps, type Deps } from '$lib/account/deps';
import { describeError } from '$lib/account/errors';
import { signInAgain } from '$lib/account/sso';
import { isApiError } from '$lib/api/types';

export function failure(e: unknown, deps: Pick<Deps, 'session' | 'leave'> = defaultDeps): string {
	if (isApiError(e, 'unauthorized')) deps.session.signedOut();
	if (isApiError(e, 'reauth_required')) signInAgain(deps);
	return describeError(e);
}
