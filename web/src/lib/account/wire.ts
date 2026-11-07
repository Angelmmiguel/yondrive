/**
 * Between the API's base64 fields and the Sealer's bytes. Which fields exist
 * follows from the bytes alone: what the sealer left empty is left out, and what
 * the server left out is empty, which is how the two modes share one code path.
 */
import type { Account, AccountKeys, Kdf, NewAccount, RekeyRequest } from '$lib/api/types';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { accountHasWrappedKeys, type UserKeyRecord } from '$lib/crypto/sealer';
import type { SessionKeyApi } from '$lib/crypto/persist';
import { isApiError } from '$lib/api/types';
import type { Deps } from './deps';

const NOTHING = new Uint8Array(0);

/** A field that is left out when it is empty. */
export function optional(bytes: Uint8Array): string | undefined {
	return bytes.length > 0 ? encodeBase64(bytes) : undefined;
}

/** The sealer's view of what an account document holds. */
export function recordOf(account: Pick<Account, 'keys'>): UserKeyRecord {
	const keys = account.keys;
	return {
		wrappedMaster: decodeOrEmpty(keys?.wrapped_master_key),
		recoveryWrappedMaster: decodeOrEmpty(keys?.wrapped_master_key_recovery),
		sealedX25519: decodeOrEmpty(keys?.sealed_x25519),
		sealedEd25519: decodeOrEmpty(keys?.sealed_ed25519),
		publicKeys: {
			x25519: decodeOrEmpty(keys?.public_keys.x25519),
			ed25519: decodeOrEmpty(keys?.public_keys.ed25519)
		}
	};
}

function decodeOrEmpty(value: string | undefined): Bytes {
	return value === undefined ? (NOTHING.slice() as Bytes) : decodeBase64(value);
}

/** The API's form of a record, absent when there is no key material. */
function accountKeysOf(record: UserKeyRecord): AccountKeys | undefined {
	if (!accountHasWrappedKeys(record)) return undefined;
	return {
		wrapped_master_key: encodeBase64(record.wrappedMaster),
		wrapped_master_key_recovery: encodeBase64(record.recoveryWrappedMaster),
		sealed_x25519: encodeBase64(record.sealedX25519),
		sealed_ed25519: encodeBase64(record.sealedEd25519),
		public_keys: {
			x25519: encodeBase64(record.publicKeys.x25519),
			ed25519: encodeBase64(record.publicKeys.ed25519)
		}
	};
}

export function newAccountBody(input: {
	username: string;
	email: string;
	authKey: Uint8Array;
	kdf: Kdf;
	recoveryAuthKey: Uint8Array;
	record: UserKeyRecord;
}): NewAccount {
	const email = input.email.trim();
	return {
		username: input.username,
		email: email === '' ? undefined : email,
		auth_key: encodeBase64(input.authKey),
		kdf: input.kdf,
		recovery_auth_key: optional(input.recoveryAuthKey),
		keys: accountKeysOf(input.record)
	};
}

/** The groups of a rekey; each is left out, or partly so, as the sealer leaves it. */
export function rekeyBody(input: {
	currentAuthKey: Uint8Array;
	passphrase?: { authKey: Uint8Array; kdf: Kdf; wrapped: Uint8Array };
	recovery?: { authKey: Uint8Array; wrapped: Uint8Array };
}): RekeyRequest {
	return {
		current_auth_key: encodeBase64(input.currentAuthKey),
		auth_key: input.passphrase && encodeBase64(input.passphrase.authKey),
		kdf: input.passphrase?.kdf,
		wrapped_master_key: input.passphrase && optional(input.passphrase.wrapped),
		recovery_auth_key: input.recovery && optional(input.recovery.authKey),
		wrapped_master_key_recovery: input.recovery && optional(input.recovery.wrapped)
	};
}

/** The two session key routes, in the bytes the crypto layer speaks. */
export function sessionKeyApi(deps: Pick<Deps, 'api'>): SessionKeyApi {
	return {
		putSessionKey: (key) => deps.api.putSessionKey({ key: encodeBase64(key) }),
		async getSessionKey() {
			try {
				return decodeBase64((await deps.api.getSessionKey()).key);
			} catch (e) {
				if (isApiError(e, 'no_session_key')) return null;
				throw e;
			}
		}
	};
}
