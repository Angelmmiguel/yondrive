/**
 * Changing credentials from a signed-in session, and setting a new password from
 * a reset link. A session alone is not enough for any of it, so each asks for the
 * current passphrase first.
 */
import { parseKdfParams } from '$lib/crypto/kdf';
import { encodeBase64 } from '$lib/crypto/encoding';
import { zero, ZeroKeyError } from '$lib/crypto/random';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';
import type { Account } from '$lib/api/types';
import { confirming, currentAuthKey, deriveKeys } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { LockedError } from './errors';
import { rekeyBody } from './wire';

interface Open {
	sealer: Sealer;
	account: Account;
	keys: UserKeys;
	/** Throws if a lock arrived since. */
	live: () => void;
}

/** What a credential change works with. Held over the KDF, which a lock can outrun. */
function open(deps: Deps): Open {
	const { sealer, account, keys } = deps.session;
	if (sealer === null || account === null || keys === null) throw new LockedError();
	return {
		sealer,
		account,
		keys,
		live: () => {
			if (deps.session.keys !== keys) throw new LockedError();
		}
	};
}

async function refreshAccount(deps: Deps): Promise<void> {
	const account = await deps.api.getMe();
	if (deps.session.account !== null) deps.session.account = account;
}

/** Runs `work`, reporting a key zeroed under its feet as the lock it was. */
async function underLock<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		throw e instanceof ZeroKeyError ? new LockedError() : e;
	}
}

export async function changePassphrase(
	input: { current: string; next: string },
	deps: Deps = defaultDeps
): Promise<void> {
	const { sealer, account, keys, live } = open(deps);
	const kdf = deps.newKdfParams();
	await underLock(async () => {
		const current = await currentAuthKey(input.current, parseKdfParams(account.kdf), deps);
		try {
			const next = await deriveKeys(input.next, kdf, deps);
			try {
				live();
				const wrapped = sealer.wrapMaster(keys.masterKey, next.kek, 'passphrase');
				await confirming(
					deps.api.rekey(
						rekeyBody({
							currentAuthKey: current,
							passphrase: { authKey: next.authKey, kdf, wrapped }
						})
					)
				);
			} finally {
				zero(next.kek, next.authKey);
			}
		} finally {
			zero(current);
		}
	});
	await refreshAccount(deps);
}

/**
 * Replaces the recovery key with one whose words have already been saved and
 * typed back. The old one stops working in the same transaction.
 */
export async function replaceRecoveryKey(
	input: { current: string; recoveryKey: Uint8Array },
	deps: Deps = defaultDeps
): Promise<void> {
	const { sealer, account, keys, live } = open(deps);
	await underLock(async () => {
		const current = await currentAuthKey(input.current, parseKdfParams(account.kdf), deps);
		const recovery = sealer.expandRecoveryKey(input.recoveryKey);
		try {
			live();
			const wrapped = sealer.wrapMaster(keys.masterKey, recovery.kek, 'recovery');
			await confirming(
				deps.api.rekey(
					rekeyBody({
						currentAuthKey: current,
						recovery: { authKey: recovery.authKey, wrapped }
					})
				)
			);
		} finally {
			zero(current, recovery.kek, recovery.authKey);
		}
	});
	await refreshAccount(deps);
}

/** A new password from a reset link. The server refuses it in a mode with keys. */
export async function resetPassword(
	input: { token: string; passphrase: string },
	deps: Deps = defaultDeps
): Promise<void> {
	const kdf = deps.newKdfParams();
	const { kek, authKey } = await deriveKeys(input.passphrase, kdf, deps);
	try {
		await deps.api.completePasswordReset({
			token: input.token,
			auth_key: encodeBase64(authKey),
			kdf
		});
	} finally {
		zero(kek, authKey);
	}
}
