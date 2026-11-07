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
