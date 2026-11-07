/**
 * Signing in through an identity provider. The provider's word gets a session and
 * opens nothing: in a mode with keys the account has its own unlock passphrase and
 * recovery key, which the provider never sees, and makes them here on first sign-in.
 */
import { oidcStartUrl } from '$lib/api/client';
import { isApiError } from '$lib/api/types';
import { encodeBase64 } from '$lib/crypto/encoding';
import { normalizePassphrase } from '$lib/crypto/kdf';
import { zeroIdentity } from '$lib/crypto/keys';
import { accountHasWrappedKeys } from '$lib/crypto/sealer';
import { zero } from '$lib/crypto/random';
import { deriveKeys } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { LockedError } from './errors';
import { acceptMode } from './mode';
import { rememberSession } from './session';
import { enrolBody, recordOf } from './wire';

/** What a failed sign-in comes back with in `?sso_error=`, in words. */
const SSO_ERRORS: Record<string, string> = {
	sso_state_invalid:
		'That sign-in took too long or started somewhere else. Try again from this page.',
	sso_denied: 'The sign-in was cancelled or refused at your identity provider.',
	sso_provider_error:
		'YonDrive could not complete the sign-in with your identity provider. Ask your administrator to check the settings.',
	sso_token_invalid:
		'Your identity provider answered with something YonDrive could not verify. Ask your administrator to check the settings.',
	sso_identity_conflict:
		'This account is linked to a different identity. An administrator can unlink it.',
	sso_email_unverified:
		'Your identity provider has not verified your email address, which an existing account here uses. Verify it there, and try again.',
	sso_not_invited: 'This server only lets invited people in. Ask your administrator for an invite.',
	rate_limited: 'Too many attempts. Wait a minute and try again.',
	user_disabled: 'This account has been disabled. Ask your administrator.',
	invite_invalid: 'This invite is not valid. It may have been used, revoked or expired.',
	sso_disabled: 'Single sign-on is not turned on here.',
	internal: 'Something went wrong on the server. Try again.'
};

/** A sentence for `?sso_error=`. The code comes from an address, so nothing of it is shown. */
export function ssoErrorMessage(code: string): string {
	return Object.hasOwn(SSO_ERRORS, code) ? SSO_ERRORS[code] : SSO_ERRORS.internal;
}

/** Leaves for the provider, as a whole page. */
export function continueWithProvider(deps: Pick<Deps, 'leave'> = defaultDeps): void {
	deps.leave(oidcStartUrl());
}

/** Leaves for the provider with an invite, whose token stays out of any address. */
export async function continueWithInvite(
	token: string,
	deps: Pick<Deps, 'api' | 'leave'> = defaultDeps
): Promise<void> {
	const { authorize_url: url } = await deps.api.startOidcWithInvite({ invite_token: token });
	deps.leave(url);
}

/** Where a person goes back to after signing in again, kept for this tab. */
const RETURN_KEY = 'yondrive.return';

/**
 * An action wants a sign-in from the last five minutes, which is what proves a current
 * credential for an account with no passphrase. Off to the provider; `takeReturn` brings
 * the person back to this page, to do it again.
 */
export function signInAgain(
	deps: Pick<Deps, 'leave'> = defaultDeps,
	storage: Pick<Storage, 'setItem'> = sessionStorage,
	path: string = location.pathname
): void {
	try {
		storage.setItem(RETURN_KEY, path);
	} catch {
		// Without storage the person lands on the home page.
	}
	deps.leave(oidcStartUrl(true));
}

/** The page to go back to after signing in again, once. Only ever one of this app's. */
export function takeReturn(storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage) {
	try {
		const path = storage.getItem(RETURN_KEY);
		storage.removeItem(RETURN_KEY);
		return path !== null && /^\/(?![/\\])/.test(path) ? path : null;
	} catch {
		return null;
	}
}

/**
 * The keys of an account signing in for the first time: the master key, the identity
 * and the wrapped copies, under the unlock passphrase and the recovery key. `recoveryKey`
 * stays the caller's, who has shown its words and had them typed back.
 */
export async function enrol(
	input: { passphrase: string; recoveryKey: Uint8Array },
	deps: Deps = defaultDeps
): Promise<void> {
	const { sealer, account } = deps.session;
	if (sealer === null || account === null) throw new LockedError();
	// Enrolling over keys that exist would replace them for good.
	if (accountHasWrappedKeys(recordOf(account))) throw new LockedError();
	normalizePassphrase(input.passphrase);
	const kdf = deps.newKdfParams();
	const { kek, authKey } = await deriveKeys(input.passphrase, kdf, deps);
	const recovery = sealer.expandRecoveryKey(input.recoveryKey);
	const { keys, record } = sealer.createUser(kek, recovery.kek);
	try {
		const next = await deps.api.enrolOidc(
			enrolBody({
				kdf,
				unlockAuthKey: encodeBase64(authKey),
				recoveryAuthKey: encodeBase64(recovery.authKey),
				record
			})
		);
		const accepted = acceptMode(next.mode, recordOf(next), deps);
		deps.session.open(accepted, next, keys);
		await rememberSession(accepted, keys, deps);
	} catch (e) {
		zero(keys.masterKey);
		zeroIdentity(keys.identity);
		if (!isApiError(e, 'already_enrolled')) throw e;
		// Another tab was quicker, and its keys are the ones. This one unlocks with them.
		deps.session.locked(sealer, await deps.api.getMe());
	} finally {
		zero(kek, authKey, recovery.kek, recovery.authKey);
	}
}
