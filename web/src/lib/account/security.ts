/**
 * The actions that a session alone must not be able to take: enrolling in TOTP,
 * turning it off, minting a device token, inviting another admin, deleting a user,
 * issuing a password reset link, forgetting an identity and changing how people sign
 * in. Each proves the passphrase first, or for an account with none, a recent sign-in.
 */
import type {
	CreatedInvite,
	CreatedPasswordReset,
	CreatedToken,
	CreateInviteRequest,
	RecoveryCodes,
	ServerSettings,
	TotpEnrolment,
	UpdateSettingsRequest
} from '$lib/api/types';
import { encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { zero } from '$lib/crypto/random';
import { confirming, freshAuthKey } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { LockedError } from './errors';
import type { SecondFactor } from './login';

async function withCurrentKey<T>(
	passphrase: string,
	deps: Deps,
	work: (key: Bytes) => Promise<T>
): Promise<T> {
	if (deps.session.account === null) throw new LockedError();
	const key = await freshAuthKey(passphrase, deps);
	try {
		return await confirming(work(key));
	} finally {
		zero(key);
	}
}

export function enrolTotp(passphrase: string, deps: Deps = defaultDeps): Promise<TotpEnrolment> {
	return withCurrentKey(passphrase, deps, (key) =>
		deps.api.enrolTotp({ current_auth_key: encodeBase64(key) })
	);
}

/** Puts TOTP in force and shows it on the account; returns the codes to show once. */
export async function confirmTotp(code: string, deps: Deps = defaultDeps): Promise<RecoveryCodes> {
	const codes = await deps.api.confirmTotp({ code: code.trim() });
	deps.session.account = await deps.api.getMe();
	return codes;
}

export async function disableTotp(
	input: { passphrase: string; factor: SecondFactor },
	deps: Deps = defaultDeps
): Promise<void> {
	try {
		await withCurrentKey(input.passphrase, deps, (key) =>
			deps.api.disableTotp({
				current_auth_key: encodeBase64(key),
				code: 'code' in input.factor ? input.factor.code.trim() : undefined,
				recovery_code: 'recoveryCode' in input.factor ? input.factor.recoveryCode.trim() : undefined
			})
		);
	} finally {
		await deps.api
			.getMe()
			.then((account) => (deps.session.account = account))
			.catch(() => {});
	}
}

export function createDeviceToken(
	input: { name: string; passphrase: string },
	deps: Deps = defaultDeps
): Promise<CreatedToken> {
	return withCurrentKey(input.passphrase, deps, (key) =>
		deps.api.createToken({
			name: input.name,
			platform: 'other',
			current_auth_key: encodeBase64(key)
		})
	);
}

/**
 * Creates an invite. Only one for an admin needs the passphrase, since it hands
 * out the same powers as the session that asks.
 */
export function createInvite(
	input: { request: CreateInviteRequest; passphrase?: string },
	deps: Deps = defaultDeps
): Promise<CreatedInvite> {
	if (input.passphrase === undefined) return deps.api.createInvite(input.request);
	return withCurrentKey(input.passphrase, deps, (key) =>
		deps.api.createInvite({ ...input.request, current_auth_key: encodeBase64(key) })
	);
}

export function createPasswordResetLink(
	input: { userId: string; passphrase: string },
	deps: Deps = defaultDeps
): Promise<CreatedPasswordReset> {
	return withCurrentKey(input.passphrase, deps, (key) =>
		deps.api.createPasswordReset(input.userId, { current_auth_key: encodeBase64(key) })
	);
}

export function unlinkUserIdentity(
	input: { userId: string; passphrase: string },
	deps: Deps = defaultDeps
): Promise<void> {
	return withCurrentKey(input.passphrase, deps, (key) =>
		deps.api.unlinkIdentity(input.userId, { current_auth_key: encodeBase64(key) })
	);
}

/** A change to the server's settings that the API wants a current credential for. */
export function changeSettings(
	input: { request: UpdateSettingsRequest; passphrase: string },
	deps: Deps = defaultDeps
): Promise<ServerSettings> {
	return withCurrentKey(input.passphrase, deps, (key) =>
		deps.api.updateSettings({ ...input.request, current_auth_key: encodeBase64(key) })
	);
}

export function deleteUserAccount(
	input: { userId: string; passphrase: string },
	deps: Deps = defaultDeps
): Promise<void> {
	return withCurrentKey(input.passphrase, deps, (key) =>
		deps.api.deleteUser(input.userId, { current_auth_key: encodeBase64(key) })
	);
}
