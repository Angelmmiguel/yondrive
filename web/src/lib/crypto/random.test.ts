import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertKey,
	constantTimeEqual,
	CryptoUnavailableError,
	isInsecureContext,
	randomBytes,
	ZeroKeyError,
	zero
} from './random';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('randomBytes', () => {
	it('draws from crypto.getRandomValues', () => {
		const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');

		const a = randomBytes(32);
		const b = randomBytes(32);

		expect(a).toHaveLength(32);
		expect(a.buffer).toBeInstanceOf(ArrayBuffer);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(a).not.toEqual(b);
		spy.mockRestore();
	});

	it('refuses to run without a secure source rather than falling back', () => {
		vi.stubGlobal('crypto', undefined);
		expect(() => randomBytes(1)).toThrow(CryptoUnavailableError);

		vi.stubGlobal('crypto', {});
		expect(() => randomBytes(1)).toThrow(CryptoUnavailableError);
	});
});

describe('constantTimeEqual', () => {
	it('compares contents', () => {
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
		expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});
});

describe('zero', () => {
	it('overwrites every buffer', () => {
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([4, 5]);

		zero(a, b);

		expect(a).toEqual(new Uint8Array(3));
		expect(b).toEqual(new Uint8Array(2));
	});
});

describe('isInsecureContext', () => {
	function stubWindow(isSecureContext: boolean, hostname: string) {
		vi.stubGlobal('window', { isSecureContext, location: { hostname } });
	}

	it('is false outside a browser', () => {
		expect(isInsecureContext()).toBe(false);
	});

	it('is false in a secure context', () => {
		stubWindow(true, 'drive.example');
		expect(isInsecureContext()).toBe(false);
	});

	it.each(['localhost', '127.0.0.1', '[::1]'])('tolerates plain http on %s', (host) => {
		stubWindow(false, host);
		expect(isInsecureContext()).toBe(false);
	});

	it.each(['drive.example', '192.168.1.10', 'nas.local'])('flags plain http on %s', (host) => {
		stubWindow(false, host);
		expect(isInsecureContext()).toBe(true);
	});
});

describe('assertKey', () => {
	it('accepts a live key', () => {
		expect(() => assertKey(new Uint8Array(32).fill(1))).not.toThrow();
	});

	it('refuses a zeroed key', () => {
		expect(() => assertKey(new Uint8Array(32))).toThrow(ZeroKeyError);
	});

	it.each([0, 16, 33])('refuses a key of %d bytes', (length) => {
		expect(() => assertKey(new Uint8Array(length).fill(1))).toThrow(RangeError);
	});
});
