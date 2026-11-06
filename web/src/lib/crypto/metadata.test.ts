import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { SealError } from './aead';
import { utf8 } from './encoding';
import {
	decodeMetadata,
	encodeMetadata,
	nameHmac,
	normalizeName,
	openMetadata,
	sealMetadata
} from './metadata';
import { ZeroKeyError } from './random';

const nodeKey = new Uint8Array(32).map((_, i) => i + 1);
const other = new Uint8Array(32).map((_, i) => i + 2);
const value = { name: 'Plan.docx', tags: ['work', 'ñandú'], modified: 1760000000 };

describe('sealMetadata and openMetadata', () => {
	it('round-trips JSON', () => {
		expect(openMetadata(nodeKey, 'n1', sealMetadata(nodeKey, 'n1', value))).toEqual(value);
	});

	it('is bound to the node', () => {
		const sealed = sealMetadata(nodeKey, 'n1', value);

		expect(() => openMetadata(nodeKey, 'n2', sealed)).toThrow(SealError);
	});

	it('refuses another key and a flipped byte', () => {
		const sealed = sealMetadata(nodeKey, 'n1', value);

		expect(() => openMetadata(other, 'n1', sealed)).toThrow(SealError);
		sealed[sealed.length - 1] ^= 1;
		expect(() => openMetadata(nodeKey, 'n1', sealed)).toThrow(SealError);
	});

	it('refuses a zeroed node key', () => {
		expect(() => sealMetadata(new Uint8Array(32), 'n1', value)).toThrow(ZeroKeyError);
	});
});

describe('encodeMetadata and decodeMetadata', () => {
	it('is plain JSON bytes', () => {
		expect(encodeMetadata({ a: 1 })).toEqual(utf8('{"a":1}'));
		expect(decodeMetadata(utf8('{"a":1}'))).toEqual({ a: 1 });
	});

	it('refuses what is not JSON', () => {
		expect(() => encodeMetadata(undefined)).toThrow(TypeError);
		expect(() => decodeMetadata(utf8('{'))).toThrow(SealError);
		expect(() => decodeMetadata(new Uint8Array([0xff]))).toThrow(SealError);
	});
});

describe('normalizeName', () => {
	it.each([
		['composes', 'café.txt', 'café.txt'],
		['lower-cases', 'Report.DOCX', 'report.docx'],
		['lower-cases beyond ASCII', 'ÑANDÚ', 'ñandú'],
		['ignores the locale for the Turkish dotted I', 'İ', 'i̇'],
		['applies the final sigma rule', 'ΣΑΣ', 'σας'],
		['leaves sharp s alone', 'Straße', 'straße'],
		['keeps compatibility forms apart', 'ﬁ', 'ﬁ'],
		['keeps whitespace', ' a  b ', ' a  b ']
	])('%s', (_, name, expected) => {
		expect(normalizeName(name)).toBe(expected);
	});

	it('is idempotent', () => {
		for (const name of ['café', 'ΣΑΣ', 'İx', 'Å']) {
			expect(normalizeName(normalizeName(name))).toBe(normalizeName(name));
		}
	});
});

describe('nameHmac', () => {
	it('is HMAC-SHA256 of the normalised name under the name subkey', () => {
		const key = hkdf(sha256, nodeKey, undefined, utf8('yondrive/name/v1'), 32);

		expect(nameHmac(nodeKey, 'Report.DOCX')).toEqual(hmac(sha256, key, utf8('report.docx')));
	});

	it('collides for the same name in another form, within a folder', () => {
		expect(nameHmac(nodeKey, 'CAFÉ')).toEqual(nameHmac(nodeKey, 'café'));
	});

	it('differs for different names and different folders', () => {
		expect(nameHmac(nodeKey, 'a')).not.toEqual(nameHmac(nodeKey, 'b'));
		expect(nameHmac(nodeKey, 'a')).not.toEqual(nameHmac(other, 'a'));
	});
});
