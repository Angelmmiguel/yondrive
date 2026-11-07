/**
 * Key pinning primitives. A client remembers the fingerprint of each contact
 * on first use and warns when it changes; two people who want to be certain
 * compare a safety number over any other channel. Where the pins are kept is
 * the account layer's business.
 */
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { open, seal } from './aead';
import { encodeFields, idBytes, type Bytes } from './encoding';
import { expand } from './kdf';
import type { PublicKeys } from './keys';
import { constantTimeEqual, zero } from './random';

const SAFETY_GROUPS = 12;
const SAFETY_GROUP_BYTES = 5;
const SAFETY_GROUP_MODULUS = 100000;

/** What the current fingerprint means against the pin, if any. */
export type PinStatus = 'first-use' | 'match' | 'changed';

/** The SHA-256 fingerprint of a user's two public keys. */
export function fingerprint(keys: PublicKeys): Bytes {
	return sha256(encodeFields('yondrive/fingerprint/v1', keys.x25519, keys.ed25519)) as Bytes;
}

/**
 * Twelve groups of five decimal digits computed from two users' fingerprints.
 * Both sides get the same string whichever order they pass them in.
 */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
	const [low, high] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
	const digest = sha512(encodeFields('yondrive/safety-number/v1', low, high));
	const groups: string[] = [];
	for (let group = 0; group < SAFETY_GROUPS; group++) {
		let value = 0;
		for (let i = 0; i < SAFETY_GROUP_BYTES; i++) {
			value = value * 256 + digest[group * SAFETY_GROUP_BYTES + i];
		}
		groups.push(String(value % SAFETY_GROUP_MODULUS).padStart(5, '0'));
	}
	return groups.join(' ');
}

/** Compares a contact's current fingerprint with the pinned one, if there is one. */
export function checkPin(pinned: Uint8Array | null, current: Uint8Array): PinStatus {
	if (pinned === null) return 'first-use';
	return constantTimeEqual(pinned, current) ? 'match' : 'changed';
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

const pinsAad = (userId: string) => encodeFields('yondrive/pins/seal/v1', idBytes(userId));

/**
 * The pins as a device keeps them, under a key from the master key. A pin is not
 * secret from whoever holds this device, but who someone shares with is nobody
 * else's business, and nothing else may write one.
 */
export function sealPins(pins: Uint8Array, master: Uint8Array, userId: string): Bytes {
	const key = expand(master, 'yondrive/pins/v1');
	try {
		return seal(key, pins, pinsAad(userId));
	} finally {
		zero(key);
	}
}

export function openPins(stored: Uint8Array, master: Uint8Array, userId: string): Bytes {
	const key = expand(master, 'yondrive/pins/v1');
	try {
		return open(key, stored, pinsAad(userId));
	} finally {
		zero(key);
	}
}
