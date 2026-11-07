/**
 * What an account flow can fail with, in terms a screen can act on. API errors
 * the flows have nothing to add to, and the crypto library's input errors, pass
 * through unchanged; `describeError` turns any of them into a sentence.
 */
import {
	InvalidKdfParamsError,
	PassphraseTooLongError,
	PassphraseTooShortError
} from '$lib/crypto/kdf';
import { InvalidRecoveryPhraseError } from '$lib/crypto/recovery';
import type { ModeRefusal } from '$lib/crypto/sealer';
import { ApiError, type ErrorCode } from '$lib/api/types';

/** The username and passphrase do not open an account. */
export class WrongCredentialsError extends Error {
	constructor() {
		super('wrong username or passphrase');
		this.name = 'WrongCredentialsError';
	}
}

/** The current passphrase given to confirm an action, or to unlock, is wrong. */
export class WrongPassphraseError extends Error {
	constructor() {
		super('wrong passphrase');
		this.name = 'WrongPassphraseError';
	}
}

/** The words are a valid key, or the username has no such key. */
export class WrongRecoveryKeyError extends Error {
	constructor() {
		super('wrong username or recovery key');
		this.name = 'WrongRecoveryKeyError';
	}
}

/** A rekey was sent and its outcome unknown, and the retry was refused: the first may have gone through. */
export class RekeyMaybeAppliedError extends Error {
	constructor() {
		super('the change may already have gone through');
		this.name = 'RekeyMaybeAppliedError';
	}
}

/** The operation needs unlocked keys, or a lock arrived while it was running. */
export class LockedError extends Error {
	constructor() {
		super('locked');
		this.name = 'LockedError';
	}
}

/** The device refuses the mode the server claims. See docs/CRYPTO.md section 14. */
export class ModeRefusedError extends Error {
	constructor(readonly reason: ModeRefusal) {
		super(`mode refused: ${reason}`);
		this.name = 'ModeRefusedError';
	}
}

const API_MESSAGES: Partial<Record<ErrorCode, string>> = {
	network: 'The server cannot be reached. Check your connection and try again.',
	rate_limited: 'Too many attempts. Wait a minute and try again.',
	too_large: 'That is too large for the server to accept.',
	setup_token_invalid:
		'This setup link is not valid. Use the latest link from the server logs: restarting the server issues a new one.',
	already_setup: 'This server has already been set up.',
	not_setup: 'This server has not been set up yet.',
	invalid_username:
		'A username is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
	invalid_email: 'That email address does not look right.',
	invalid_public_url:
		'That address is not usable. Use http:// or https:// with a host, and no query or fragment.',
	invalid_settings: 'Some of those settings are not valid.',
	username_taken: 'That username is taken.',
	email_taken: 'That email address is already in use.',
	invalid_credentials: 'Wrong username or passphrase.',
	wrong_credential: 'That passphrase is not correct.',
	user_disabled: 'This account has been disabled. Ask your administrator.',
	invite_invalid: 'This invite is not valid. It may have been used, revoked or expired.',
	signup_closed: 'This server only accepts invited users. Ask your administrator for an invite.',
	invalid_invite: 'Those invite settings are not valid.',
	totp_invalid: 'That code is not correct. Codes work once and change every 30 seconds.',
	totp_already_enabled: 'Two-factor sign-in is already on.',
	totp_not_pending: 'Start enrolling again: this enrolment is no longer open.',
	totp_not_enabled: 'Two-factor sign-in is not on.',
	invalid_token_name: 'A device name is 1 to 128 characters.',
	cannot_modify_self: 'You cannot do that to your own account.',
	invalid_quota: 'That quota is not valid.',
	wrong_mode: 'This server keeps its keys end to end, so an administrator cannot reset passwords.',
	reset_invalid: 'This reset link is not valid. It may have been used or expired.',
	sso_disabled: 'Single sign-on is not turned on here.',
	sso_required:
		'This account signs in through your identity provider. Continue with it from the sign-in page; “Forgot your passphrase?” on the unlock screen then takes these words.',
	sso_only: 'This account signs in through your identity provider, and has no password here.',
	local_accounts_disabled: 'Signing in with a passphrase is turned off on this server.',
	local_accounts_lockout:
		'That would leave nobody able to sign in. Local accounts can only go off with single sign-on on and a local administrator left.',
	identity_not_relinkable:
		'Their next sign-in could not find this account under the match mode, so it would make an empty one. Give the account an email address or change the match mode first.',
	already_enrolled: 'This account already has its keys.',
	totp_local_only: 'Your identity provider handles the second factor of this account.',
	reauth_required: 'Sign in again through your identity provider, and try that again.',
	invalid_issuer:
		'That is not a usable issuer address. It has to be https, unless insecure ones are allowed.',
	invalid_oidc_settings:
		'Some of those settings are not valid: check the label, scopes and client.',
	oidc_discovery_failed: 'YonDrive could not read the provider’s configuration from that address.',
	oidc_issuer_mismatch: 'The provider spells its issuer differently. Use exactly its spelling.',
	oidc_keys_failed: 'The provider offers no signing key YonDrive can use.',
	unauthorized: 'Your session has ended. Sign in again.',
	not_found: 'That no longer exists.',
	forbidden: 'You are not allowed to do that.'
};

/** A sentence for the person at the screen. Never includes anything sensitive. */
export function describeError(e: unknown): string {
	if (e instanceof WrongCredentialsError) return 'Wrong username or passphrase.';
	if (e instanceof WrongPassphraseError) return 'That passphrase is not correct.';
	if (e instanceof WrongRecoveryKeyError) {
		return 'Those words do not open this account. Check the username and the recovery key.';
	}
	if (e instanceof RekeyMaybeAppliedError) {
		return 'The change may already have gone through. Sign in with your new passphrase.';
	}
	if (e instanceof LockedError) return 'The app was locked before this could finish.';
	if (e instanceof PassphraseTooShortError) return 'A passphrase needs at least 12 characters.';
	if (e instanceof PassphraseTooLongError) return 'A passphrase can have at most 1024 characters.';
	if (e instanceof InvalidRecoveryPhraseError) {
		return e.code === 'words'
			? 'A recovery key is 24 words from the list you were given.'
			: 'One of those words is mistyped: the recovery key does not check out.';
	}
	if (e instanceof InvalidKdfParamsError) {
		return 'The server sent key derivation settings this app refuses.';
	}
	if (e instanceof ApiError) {
		return API_MESSAGES[e.code] ?? 'Something went wrong on the server. Try again.';
	}
	return 'Something went wrong. Try again.';
}
