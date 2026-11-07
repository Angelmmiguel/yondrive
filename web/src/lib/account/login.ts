/**
 * Presenting an auth key, with the second step it may need. A login that wants a
 * code does not run the KDF again: the keys wait in memory, held by the challenge,
 * until it is answered or cancelled.
 */
import type { Account, LoginRequest } from '$lib/api/types';
import { encodeBase64 } from '$lib/crypto/encoding';
import { isApiError } from '$lib/api/types';
import type { Deps } from './deps';

export type SecondFactor = { code: string } | { recoveryCode: string };

/** A login that still needs a code. A wrong code leaves it open for another try. */
export interface TotpChallenge<T> {
	status: 'totp';
	submit(factor: SecondFactor): Promise<LoginStep<T>>;
	/** Zeroes the keys held for the login. */
	cancel(): void;
}

export type LoginStep<T> = { status: 'done'; value: T } | TotpChallenge<T>;

export interface LoginAttempt<T> {
	username: string;
	authKey: Uint8Array;
	/** The error for a key the server does not take. */
	wrong: () => Error;
	/** Turns the signed-in account into the flow's result. */
	complete: (account: Account) => Promise<T>;
	/** Zeroes every key the attempt holds. */
	release: () => void;
}

export async function attemptLogin<T>(
	attempt: LoginAttempt<T>,
	deps: Pick<Deps, 'api'>,
	factor?: SecondFactor
): Promise<LoginStep<T>> {
	const body: LoginRequest = {
		username: attempt.username,
		auth_key: encodeBase64(attempt.authKey),
		totp_code: factor && 'code' in factor ? factor.code.trim() : undefined,
		totp_recovery_code: factor && 'recoveryCode' in factor ? factor.recoveryCode.trim() : undefined
	};
	let account: Account;
	try {
		account = await deps.api.login(body);
	} catch (e) {
		if (isApiError(e, 'totp_required')) return challenge(attempt, deps);
		// Only a wrong code is worth keeping the keys for.
		if (factor !== undefined && isApiError(e, 'totp_invalid', 'rate_limited', 'network')) throw e;
		attempt.release();
		throw isApiError(e, 'invalid_credentials') ? attempt.wrong() : e;
	}
	try {
		return { status: 'done', value: await attempt.complete(account) };
	} finally {
		attempt.release();
	}
}

function challenge<T>(attempt: LoginAttempt<T>, deps: Pick<Deps, 'api'>): TotpChallenge<T> {
	return {
		status: 'totp',
		submit: (factor) => attemptLogin(attempt, deps, factor),
		cancel: attempt.release
	};
}
