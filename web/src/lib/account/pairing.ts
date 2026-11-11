/**
 * Adding a device by code, the browser's side (docs/CRYPTO.md section 22). The
 * pairing is started with a current credential, as making a token is; once the
 * person has seen the same six digits on both screens, the browser draws the
 * device's token secret, seals it and in end-to-end mode the master key to the
 * device, and gives the server only the hash and the sealed bytes.
 */
import type { DeviceToken, Pairing } from '$lib/api/types';
import { encodeBase64, type Bytes } from '$lib/crypto/encoding';
import type { KeyPair } from '$lib/crypto/keys';
import {
	newTokenSecret,
	sealPairingPayload,
	tokenHash,
	type PairingPayload
} from '$lib/crypto/pairing';
import { constantTimeEqual, KEY_LENGTH, zero } from '$lib/crypto/random';
import { confirming } from './credentials';
import { defaultDeps, type Deps } from './deps';
import { LockedError } from './errors';

/** Opens a pairing; `authKey` is the current one, empty where a recent sign-in stands in. */
export function startPairing(authKey: Bytes, deps: Deps = defaultDeps): Promise<Pairing> {
	return confirming(deps.api.startPairing({ current_auth_key: encodeBase64(authKey) }));
}

/** What the device receives: the token secret, and in end-to-end mode the master key. */
export function buildPayload(secret: string, deps: Deps = defaultDeps): PairingPayload {
	const { sealer, keys, status } = deps.session;
	if (sealer === null || keys === null || status !== 'unlocked') throw new LockedError();
	if (!sealer.encrypted) return { v: 1, suite: sealer.suite, token: secret };
	const master = keys.masterKey;
	// A lock zeroes the key in place, and a zeroed key must not go out as if it were one.
	if (master.length !== KEY_LENGTH || constantTimeEqual(master, new Uint8Array(KEY_LENGTH))) {
		throw new LockedError();
	}
	return { v: 1, suite: sealer.suite, token: secret, master_key: encodeBase64(master) };
}

/**
 * Hands the device that claimed the pairing its token. `keys` are the browser's
 * for this pairing and `deviceKey` the key the server reports for the device,
 * which the six digits vouched for.
 */
export async function confirmPairing(
	input: { pairingId: string; keys: KeyPair; deviceKey: Uint8Array },
	deps: Deps = defaultDeps
): Promise<DeviceToken> {
	const secret = newTokenSecret();
	const sealed = sealPairingPayload(
		input.keys,
		input.deviceKey,
		input.pairingId,
		buildPayload(secret, deps)
	);
	const hash = tokenHash(secret);
	try {
		return await deps.api.confirmPairing(input.pairingId, {
			token_hash: encodeBase64(hash),
			sealed_payload: encodeBase64(sealed)
		});
	} finally {
		zero(hash, sealed);
	}
}
