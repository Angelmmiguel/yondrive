/**
 * Device pairing, as docs/CRYPTO.md section 22 has it. The browser's ephemeral
 * X25519 key travels in a code's fragment and never to the server; the device
 * claims the code with a key of its own, and both screens show six digits hashed
 * from the two keys, which a server that swapped one cannot match. The browser
 * then seals the device its token, and in end-to-end mode the master key, under
 * a key the two agree.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { open, seal, SealError } from './aead';
import { decodeBase64, encodeFields, idBytes, utf8, type Bytes } from './encoding';
import { expand } from './kdf';
import type { KeyPair } from './keys';
import { constantTimeEqual, KEY_LENGTH, randomBytes, zero } from './random';
import { parseSuite, SUITE_E2E, type Suite } from './sealer';

export const PAIRING_VERSION = '1';

const PAIRING_ID = /^[0-9a-f]{32}$/;
const CODE_DIGITS = 6;

/** What the browser seals to the device. */
export interface PairingPayload {
	v: 1;
	suite: Suite;
	/** The token secret, as sent in `Authorization: Bearer`. */
	token: string;
	/** The master key in base64, in end-to-end mode only. */
	master_key?: string;
}

/** A fresh ephemeral key pair, for one pairing. */
export function generatePairingKeys(): KeyPair {
	const privateKey = randomBytes(KEY_LENGTH);
	return { privateKey, publicKey: x25519.getPublicKey(privateKey) as Bytes };
}

/** Whether `key` can be an X25519 key of a pairing: 32 bytes, not all zeros. */
export function liveKey(key: Uint8Array): boolean {
	return key.length === KEY_LENGTH && !constantTimeEqual(key, new Uint8Array(KEY_LENGTH));
}

/**
 * The six digits both screens show. Each side passes the browser's key first and
 * the device's second.
 */
export function pairingCode(
	browserKey: Uint8Array,
	deviceKey: Uint8Array,
	pairingId: string
): string {
	const digest = sha256(
		encodeFields('yondrive/pairing/code/v1', browserKey, deviceKey, idBytes(pairingId))
	);
	const n = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0);
	return String(n % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

const payloadAad = (browserKey: Uint8Array, deviceKey: Uint8Array, pairingId: string) =>
	encodeFields('yondrive/pairing/payload/v1', browserKey, deviceKey, idBytes(pairingId));

function wrapKeyOf(
	privateKey: Uint8Array,
	peer: Uint8Array,
	browserKey: Uint8Array,
	deviceKey: Uint8Array
): Bytes {
	if (!liveKey(peer)) throw new SealError('format');
	let shared: Uint8Array;
	try {
		shared = x25519.getSharedSecret(privateKey, peer);
	} catch {
		throw new SealError('format');
	}
	try {
		if (!liveKey(shared)) throw new SealError('format');
		return expand(shared, encodeFields('yondrive/pairing/key/v1', browserKey, deviceKey));
	} finally {
		zero(shared);
	}
}

/** The browser's side: the payload, sealed to the device's key. */
export function sealPairingPayload(
	keys: KeyPair,
	deviceKey: Uint8Array,
	pairingId: string,
	payload: PairingPayload
): Bytes {
	const wrap = wrapKeyOf(keys.privateKey, deviceKey, keys.publicKey, deviceKey);
	const plaintext = utf8(JSON.stringify(payload));
	try {
		return seal(wrap, plaintext, payloadAad(keys.publicKey, deviceKey, pairingId));
	} finally {
		zero(wrap, plaintext);
	}
}

/**
 * The device's side: opens the payload with its own key pair and the browser's
 * key from the code, and refuses one whose version, suite or master key is not
 * what this section allows.
 */
export function openPairingPayload(
	keys: KeyPair,
	browserKey: Uint8Array,
	pairingId: string,
	sealed: Uint8Array
): PairingPayload {
	const wrap = wrapKeyOf(keys.privateKey, browserKey, browserKey, keys.publicKey);
	let plaintext: Bytes;
	try {
		plaintext = open(wrap, sealed, payloadAad(browserKey, keys.publicKey, pairingId));
	} finally {
		zero(wrap);
	}
	try {
		return parsePayload(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
	} catch (e) {
		if (e instanceof SealError) throw e;
		throw new SealError('format');
	} finally {
		zero(plaintext);
	}
}

function parsePayload(text: string): PairingPayload {
	const value: unknown = JSON.parse(text);
	if (typeof value !== 'object' || value === null) throw new SealError('format');
	const { v, suite, token, master_key: masterKey } = value as Record<string, unknown>;
	const parsed = parseSuite(suite);
	if (v !== 1 || parsed === null || typeof token !== 'string' || token === '') {
		throw new SealError('format');
	}
	if (parsed !== SUITE_E2E) {
		if (masterKey !== undefined) throw new SealError('format');
		return { v: 1, suite: parsed, token };
	}
	if (typeof masterKey !== 'string' || decodeBase64(masterKey).length !== KEY_LENGTH) {
		throw new SealError('format');
	}
	return { v: 1, suite: parsed, token, master_key: masterKey };
}

/** A new token secret: 32 random bytes in unpadded base64url. */
export function newTokenSecret(): string {
	const bytes = randomBytes(KEY_LENGTH);
	try {
		return base64urlnopad.encode(bytes);
	} finally {
		zero(bytes);
	}
}

/** What the server stores of a token secret. */
export function tokenHash(secret: string): Bytes {
	return sha256(utf8(secret)) as Bytes;
}

/** The address a code shows: the browser's key goes in the fragment. */
export function encodePairingLink(
	origin: string,
	pairingId: string,
	browserKey: Uint8Array
): string {
	return `${origin}/pair#${PAIRING_VERSION}.${pairingId}.${base64urlnopad.encode(browserKey)}`;
}

/**
 * The server, the pairing and the browser's key in a scanned address, or null
 * if it is not one this version understands.
 */
export function parsePairingLink(
	link: string
): { origin: string; pairingId: string; browserKey: Bytes } | null {
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return null;
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/pair') {
		return null;
	}
	const [version, pairingId, key, ...rest] = url.hash.slice(1).split('.');
	if (version !== PAIRING_VERSION || rest.length > 0 || !PAIRING_ID.test(pairingId ?? '')) {
		return null;
	}
	let browserKey: Bytes;
	try {
		browserKey = Uint8Array.from(base64urlnopad.decode(key ?? ''));
	} catch {
		return null;
	}
	if (!liveKey(browserKey)) return null;
	return { origin: url.origin, pairingId, browserKey };
}
