import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64, encodeFields, idBytes, u32, u64, utf8 } from './encoding';

describe('base64', () => {
	it('round-trips with padding', () => {
		expect(encodeBase64(utf8('ab'))).toBe('YWI=');
		expect(decodeBase64('YWI=')).toEqual(utf8('ab'));
	});

	it.each(['YWI', 'Y!I=', 'YWI=='])('rejects %s', (text) => {
		expect(() => decodeBase64(text)).toThrow();
	});
});

describe('integers', () => {
	it('are big-endian', () => {
		expect(bytesToHex(u32(0x01020304))).toBe('01020304');
		expect(bytesToHex(u64(0x0102030405))).toBe('0000000102030405');
		expect(bytesToHex(u64(Number.MAX_SAFE_INTEGER))).toBe('001fffffffffffff');
	});

	it.each([-1, 1.5, 2 ** 32])('u32 rejects %d', (value) => {
		expect(() => u32(value)).toThrow(RangeError);
	});

	it.each([-1, 1.5, 2 ** 53])('u64 rejects %d', (value) => {
		expect(() => u64(value)).toThrow(RangeError);
	});
});

describe('idBytes', () => {
	it('refuses an empty id', () => {
		expect(idBytes('n1')).toEqual(utf8('n1'));
		expect(() => idBytes('')).toThrow(TypeError);
	});
});

describe('encodeFields', () => {
	it('length-prefixes the label and every field', () => {
		expect(bytesToHex(encodeFields('ab', utf8('c'), new Uint8Array(0)))).toBe(
			'00000002' + '6162' + '00000001' + '63' + '00000000'
		);
	});

	it('cannot be confused by moving bytes between fields', () => {
		expect(encodeFields('l', utf8('ab'), utf8('c'))).not.toEqual(
			encodeFields('l', utf8('a'), utf8('bc'))
		);
		expect(encodeFields('la', utf8('b'))).not.toEqual(encodeFields('l', utf8('ab')));
	});
});
