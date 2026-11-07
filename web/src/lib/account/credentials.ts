/** A passphrase to the two keys it stands for. Each caller zeroes what it gets. */
import type { Bytes } from '$lib/crypto/encoding';
import { expandRoot, normalizePassphrase, type KdfParams } from '$lib/crypto/kdf';
import { zero } from '$lib/crypto/random';
import type { Deps } from './deps';
import { isApiError } from '$lib/api/types';
import { WrongPassphraseError } from './errors';

/** Runs the KDF, then HKDF. Fails on the passphrase's length before spending any time. */
export async function deriveKeys(
	passphrase: string,
	kdf: KdfParams,
	deps: Pick<Deps, 'deriveRoot'>
): Promise<{ kek: Bytes; authKey: Bytes }> {
	normalizePassphrase(passphrase);
	const root = await deps.deriveRoot(passphrase, kdf);
	try {
		return expandRoot(root);
	} finally {
		zero(root);
	}
}

/** The auth key of the signed-in user's current passphrase, to confirm an action with. */
export async function currentAuthKey(
	passphrase: string,
	kdf: KdfParams,
	deps: Pick<Deps, 'deriveRoot'>
): Promise<Bytes> {
	const { kek, authKey } = await deriveKeys(passphrase, kdf, deps);
	zero(kek);
	return authKey;
}

/** Calls a route that checks a current auth key, naming its refusal. */
export async function confirming<T>(request: Promise<T>): Promise<T> {
	try {
		return await request;
	} catch (e) {
		if (isApiError(e, 'wrong_credential')) throw new WrongPassphraseError();
		throw e;
	}
}
