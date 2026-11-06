/**
 * Randomness and byte hygiene. Every random byte in the app comes from
 * `crypto.getRandomValues`; there is deliberately no fallback, because a key
 * drawn from `Math.random` is not a key.
 */
import type { Bytes } from './encoding';

export const KEY_LENGTH = 32;

/** The platform offers no cryptographically secure random source. */
export class CryptoUnavailableError extends Error {
	constructor() {
		super('crypto.getRandomValues is not available');
		this.name = 'CryptoUnavailableError';
	}
}

/** A key of all zeros: what a lock leaves behind, never a key to use. */
export class ZeroKeyError extends Error {
	constructor() {
		super('the key has been zeroed');
		this.name = 'ZeroKeyError';
	}
}

/**
 * Refuses anything but a live 32-byte key. Lock zeroes keys in place, and work
 * still in flight must fail rather than seal or derive anything under nothing.
 */
export function assertKey(key: Uint8Array): void {
	if (key.length !== KEY_LENGTH) throw new RangeError('a key is 32 bytes');
	let bits = 0;
	for (const byte of key) bits |= byte;
	if (bits === 0) throw new ZeroKeyError();
}

/** Returns `n` cryptographically random bytes. */
export function randomBytes(n: number): Bytes {
	const source = globalThis.crypto;
	if (source === undefined || typeof source.getRandomValues !== 'function') {
		throw new CryptoUnavailableError();
	}
	const out = new Uint8Array(n);
	source.getRandomValues(out);
	return out;
}

/**
 * Compares two byte strings without an early exit on the first difference,
 * so the time taken says nothing about where they diverge. Unequal lengths
 * are reported immediately; every length this app compares is public.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

/**
 * Overwrites buffers with zeros once a key is no longer needed. This is best
 * effort: JavaScript gives no control over copies the engine or garbage
 * collector may have made, so it shortens a key's lifetime in memory rather
 * than guaranteeing it.
 */
export function zero(...buffers: Uint8Array[]): void {
	for (const buffer of buffers) {
		buffer.fill(0);
	}
}

/**
 * Reports whether the page runs somewhere the browser does not consider
 * secure, except on the loopback names a self-hosted app is legitimately
 * reached by during development. Outside a browser it reports false.
 */
export function isInsecureContext(): boolean {
	if (typeof window === 'undefined') return false;
	if (window.isSecureContext) return false;
	const host = window.location.hostname;
	return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
}
