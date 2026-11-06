/**
 * Surviving a page refresh without the passphrase. The master key is stored in
 * sessionStorage sealed under a random session key that lives only in the
 * server's memory: the disk holds ciphertext, the server holds a key, and
 * neither half is useful alone. Logout or expiry deletes the server half.
 */
import { ApiError } from '$lib/api/types';
import { decodeBase64, encodeBase64, type Bytes } from './encoding';
import { unwrapMasterKey, wrapMasterKey } from './keys';
import { KEY_LENGTH, randomBytes, zero } from './random';

export const STORAGE_KEY = 'yondrive.master';

/** The two routes this module needs; the account layer passes the API client's. */
export interface SessionKeyApi {
	putSessionKey(key: Uint8Array): Promise<void>;
	getSessionKey(): Promise<Bytes | null>;
}

/** Hands a fresh session key to the server and stores the master key sealed under it. */
export async function persistMasterKey(master: Uint8Array, api: SessionKeyApi): Promise<void> {
	const sessionKey = randomBytes(KEY_LENGTH);
	try {
		await api.putSessionKey(sessionKey);
		sessionStorage.setItem(STORAGE_KEY, encodeBase64(wrapMasterKey(master, sessionKey, 'session')));
	} finally {
		zero(sessionKey);
	}
}

/**
 * Recovers the master key after a reload, or returns null when there is nothing
 * stored or the server no longer holds the session key. Anything that fails to
 * unwrap is discarded, since it can never open again.
 */
export async function resumeMasterKey(api: SessionKeyApi): Promise<Bytes | null> {
	const stored = sessionStorage.getItem(STORAGE_KEY);
	if (stored === null) return null;

	let sessionKey: Bytes | null;
	try {
		sessionKey = await api.getSessionKey();
	} catch (e) {
		if (e instanceof ApiError && e.status === 401) {
			clearPersistedMasterKey();
			return null;
		}
		throw e;
	}
	if (sessionKey === null) {
		clearPersistedMasterKey();
		return null;
	}

	try {
		return unwrapMasterKey(decodeBase64(stored), sessionKey, 'session');
	} catch {
		// A stored value that is not base64, or a SealError: either way the
		// blob will never open again, so it is not worth keeping.
		clearPersistedMasterKey();
		return null;
	} finally {
		zero(sessionKey);
	}
}

/** Forgets the sealed master key. */
export function clearPersistedMasterKey(): void {
	sessionStorage.removeItem(STORAGE_KEY);
}
