/**
 * Authenticated encryption for everything the app stores: XChaCha20-Poly1305
 * under a version byte and a random 24-byte nonce. The nonce is long enough
 * that random generation never repeats in practice, so no counter has to be
 * persisted anywhere.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import type { Bytes } from './encoding';
import { assertKey, randomBytes } from './random';

export const VERSION = 0x01;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;
/** Bytes a sealed message carries on top of its plaintext. */
export const OVERHEAD = 1 + NONCE_LENGTH + TAG_LENGTH;

/** Why stored data was refused. Nothing more specific is ever said. */
export type SealErrorCode =
	| 'version'
	| 'length'
	| 'auth'
	| 'format'
	| 'integrity'
	| 'order'
	| 'truncated'
	| 'extended'
	| 'manifest'
	| 'signature';

/** Stored data that cannot be opened or does not verify. */
export class SealError extends Error {
	readonly code: SealErrorCode;

	constructor(code: SealErrorCode) {
		super(`cannot open sealed data: ${code}`);
		this.name = 'SealError';
		this.code = code;
	}
}

/** Encrypts `plaintext`, binding `aad` so the result is only valid in that role. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Bytes {
	assertKey(key);
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = xchacha20poly1305(key, nonce, aad);
	const out = new Uint8Array(OVERHEAD + plaintext.length);
	out[0] = VERSION;
	out.set(nonce, 1);
	out.set(cipher.encrypt(plaintext), 1 + NONCE_LENGTH);
	return out;
}

/**
 * Decrypts the output of `seal` under the same key and aad. A zeroed key is
 * refused here too: anyone can forge a message that opens under all zeros, so
 * a read racing a lock must not accept one.
 */
export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Bytes {
	assertKey(key);
	if (sealed.length < OVERHEAD) throw new SealError('length');
	if (sealed[0] !== VERSION) throw new SealError('version');
	const nonce = sealed.subarray(1, 1 + NONCE_LENGTH);
	const cipher = xchacha20poly1305(key, nonce, aad);
	try {
		return cipher.decrypt(sealed.subarray(1 + NONCE_LENGTH)) as Bytes;
	} catch {
		throw new SealError('auth');
	}
}
