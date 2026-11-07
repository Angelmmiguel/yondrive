/**
 * Passphrase to root key. Argon2id is the one slow step; HKDF then splits the
 * root into the KEK that stays in the browser and the auth key that goes to
 * the server. Both functions are pure and synchronous so they run unchanged
 * inside the worker and in tests.
 */
import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase64, encodeBase64, utf8, type Bytes } from './encoding';
import { assertKey, KEY_LENGTH, randomBytes } from './random';

/** Fewer than 12 code points after normalisation. */
export class PassphraseTooShortError extends Error {
	constructor() {
		super('passphrase must be at least 12 characters');
		this.name = 'PassphraseTooShortError';
	}
}

/** More than 1024 code points after normalisation. */
export class PassphraseTooLongError extends Error {
	constructor() {
		super('passphrase must be at most 1024 characters');
		this.name = 'PassphraseTooLongError';
	}
}

/** KDF parameters that are malformed or outside the accepted bounds. */
export class InvalidKdfParamsError extends Error {
	constructor(detail: string) {
		super(`invalid kdf parameters: ${detail}`);
		this.name = 'InvalidKdfParamsError';
	}
}

/** Argon2id parameters as stored on the server. */
export interface KdfParams {
	name: 'argon2id';
	/** Memory in KiB. */
	m: number;
	/** Iterations. */
	t: number;
	/** Lanes. */
	p: number;
	/** 16 bytes, base64. */
	salt: string;
}

export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 1024;
export const SALT_LENGTH = 16;

/** The cost of a new account: 64 MiB, three passes, one lane. */
export const DEFAULT_KDF: Omit<KdfParams, 'salt'> = { name: 'argon2id', m: 65536, t: 3, p: 1 };

const bounds = { m: [8192, 1048576], t: [1, 10], p: [1, 1] } as const;

const KEK_INFO = 'yondrive/kek/v1';
const AUTH_INFO = 'yondrive/auth/v1';

/**
 * Normalises a passphrase to NFKC so that the same keystrokes on different
 * platforms produce the same bytes, then enforces the length limits in code
 * points.
 */
export function normalizePassphrase(passphrase: string): string {
	const normalized = passphrase.normalize('NFKC');
	const length = Array.from(normalized).length;
	if (length < MIN_PASSPHRASE) throw new PassphraseTooShortError();
	if (length > MAX_PASSPHRASE) throw new PassphraseTooLongError();
	return normalized;
}

/** Default parameters with a fresh random salt. */
export function newKdfParams(): KdfParams {
	return { ...DEFAULT_KDF, salt: encodeBase64(randomBytes(SALT_LENGTH)) };
}

/**
 * Validates parameters received from the server. The bounds are what makes a
 * hostile server unable to hand back a cost so low that the passphrase becomes
 * guessable. Only the known fields are copied out.
 */
export function parseKdfParams(value: unknown): KdfParams {
	if (value === null || typeof value !== 'object') {
		throw new InvalidKdfParamsError('not an object');
	}
	const record: Record<string, unknown> = { ...value };
	if (record.name !== 'argon2id') throw new InvalidKdfParamsError('unknown algorithm');
	const m = bounded(record.m, 'm');
	const t = bounded(record.t, 't');
	const p = bounded(record.p, 'p');
	if (typeof record.salt !== 'string') throw new InvalidKdfParamsError('salt is not a string');
	let salt: Bytes;
	try {
		salt = decodeBase64(record.salt);
	} catch {
		throw new InvalidKdfParamsError('salt is not base64');
	}
	if (salt.length !== SALT_LENGTH) throw new InvalidKdfParamsError('salt is not 16 bytes');
	return { name: 'argon2id', m, t, p, salt: record.salt };
}

function bounded(value: unknown, field: keyof typeof bounds): number {
	const [min, max] = bounds[field];
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new InvalidKdfParamsError(`${field} must be an integer between ${min} and ${max}`);
	}
	return value;
}

/**
 * Argon2id over the normalised passphrase; 32 bytes. Slow by design. The bounds
 * are checked here as well, so no path to this function can skip them.
 */
export function deriveRoot(passphrase: string, params: KdfParams): Bytes {
	const { m, t, p, salt: encodedSalt } = parseKdfParams(params);
	const password = utf8(normalizePassphrase(passphrase));
	const salt = decodeBase64(encodedSalt);
	try {
		return argon2id(password, salt, {
			m,
			t,
			p,
			dkLen: KEY_LENGTH
		}) as Bytes;
	} finally {
		password.fill(0);
	}
}

/**
 * Argon2id over a link's password. Section 19 of docs/CRYPTO.md sets no length, as
 * a link may have been made by another client, so only the parameters are bounded.
 */
export function deriveLinkRoot(password: string, params: KdfParams): Bytes {
	const { m, t, p, salt: encodedSalt } = parseKdfParams(params);
	const bytes = utf8(password.normalize('NFKC'));
	try {
		return argon2id(bytes, decodeBase64(encodedSalt), { m, t, p, dkLen: KEY_LENGTH }) as Bytes;
	} finally {
		bytes.fill(0);
	}
}

/**
 * The KEK alone. It never leaves the device. An SSO account derives its auth key
 * from the unlock passphrase with `expandRoot` as well, and sends it only as a
 * `current_auth_key`, to prove a current credential, never to sign in.
 */
export function deriveKek(root: Uint8Array): Bytes {
	return expand(root, KEK_INFO);
}

/**
 * Splits a root (or a recovery key, which is already uniformly random) into
 * the two purpose-bound keys of an account. HKDF is one-way, so the auth key the
 * server sees says nothing about the KEK.
 */
export function expandRoot(root: Uint8Array): { kek: Bytes; authKey: Bytes } {
	return { kek: deriveKek(root), authKey: expand(root, AUTH_INFO) };
}

/** HKDF-SHA256 without salt, 32 bytes. A string `info` is its UTF-8 bytes. */
export function expand(key: Uint8Array, info: string | Uint8Array): Bytes {
	assertKey(key);
	const label = typeof info === 'string' ? utf8(info) : info;
	return hkdf(sha256, key, undefined, label, KEY_LENGTH) as Bytes;
}
