import { describe, expect, it } from 'vitest';
import { generateIdentity } from './keys';
import { checkPin, fingerprint, safetyNumber } from './pinning';

function publicKeys() {
	const identity = generateIdentity();
	return { x25519: identity.x25519.publicKey, ed25519: identity.ed25519.publicKey };
}

const a = fingerprint(publicKeys());
const b = fingerprint(publicKeys());

describe('fingerprint', () => {
	it('is 32 bytes and deterministic', () => {
		const keys = publicKeys();

		expect(fingerprint(keys)).toHaveLength(32);
		expect(fingerprint(keys)).toEqual(fingerprint({ ...keys }));
	});

	it('depends on both keys, and on which is which', () => {
		const keys = publicKeys();
		const other = publicKeys();

		expect(fingerprint({ ...keys, x25519: other.x25519 })).not.toEqual(fingerprint(keys));
		expect(fingerprint({ ...keys, ed25519: other.ed25519 })).not.toEqual(fingerprint(keys));
		expect(fingerprint({ x25519: keys.ed25519, ed25519: keys.x25519 })).not.toEqual(
			fingerprint(keys)
		);
	});
});

describe('safetyNumber', () => {
	it('is twelve groups of five digits', () => {
		expect(safetyNumber(a, b)).toMatch(/^\d{5}( \d{5}){11}$/);
	});

	it('does not depend on the order', () => {
		expect(safetyNumber(a, b)).toBe(safetyNumber(b, a));
	});

	it('changes when either side changes', () => {
		const c = fingerprint(publicKeys());

		expect(safetyNumber(a, c)).not.toBe(safetyNumber(a, b));
		expect(safetyNumber(c, b)).not.toBe(safetyNumber(a, b));
	});
});

describe('checkPin', () => {
	it('reports each case', () => {
		expect(checkPin(null, a)).toBe('first-use');
		expect(checkPin(a, Uint8Array.from(a))).toBe('match');
		expect(checkPin(a, b)).toBe('changed');
	});
});
