import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { NONCE_LENGTH, open, OVERHEAD, seal, SealError, VERSION } from './aead';
import { utf8 } from './encoding';
import { ZeroKeyError } from './random';

const key = new Uint8Array(32).map((_, i) => i + 1);
const plaintext = utf8('hello, drive');
const aad = utf8('test/v1');

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof SealError) return e.code;
		throw e;
	}
	throw new Error('did not throw');
}

const sunscreen =
	"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";

describe('known answers', () => {
	it('xchacha20poly1305 reproduces the draft-irtf-cfrg-xchacha §A.3.1 vector', () => {
		const vectorKey = hexToBytes(
			'808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'
		);
		const nonce = hexToBytes('404142434445464748494a4b4c4d4e4f5051525354555657');
		const vectorAad = hexToBytes('50515253c0c1c2c3c4c5c6c7');
		const ciphertext =
			'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
			'731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
			'2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
			'21f9664c97637da9768812f615c68b13b52e';
		const tag = 'c0875924c1c7987947deafd8780acf49';

		const sealed = xchacha20poly1305(vectorKey, nonce, vectorAad).encrypt(utf8(sunscreen));

		expect(bytesToHex(sealed)).toBe(ciphertext + tag);
		expect(xchacha20poly1305(vectorKey, nonce, vectorAad).decrypt(sealed)).toEqual(utf8(sunscreen));
	});

	it('chacha20poly1305 reproduces the RFC 8439 §2.8.2 vector', () => {
		const sealed = chacha20poly1305(
			hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'),
			hexToBytes('070000004041424344454647'),
			hexToBytes('50515253c0c1c2c3c4c5c6c7')
		).encrypt(utf8(sunscreen));

		expect(bytesToHex(sealed.subarray(-16))).toBe('1ae10b594f09e26a7e902ecbd0600691');
	});
});

describe('seal and open', () => {
	it('round-trips under the same key and aad', () => {
		const sealed = seal(key, plaintext, aad);

		expect(sealed).toHaveLength(OVERHEAD + plaintext.length);
		expect(sealed[0]).toBe(VERSION);
		expect(open(key, sealed, aad)).toEqual(plaintext);
	});

	it('handles an empty plaintext', () => {
		const sealed = seal(key, new Uint8Array(0), aad);

		expect(sealed).toHaveLength(OVERHEAD);
		expect(open(key, sealed, aad)).toEqual(new Uint8Array(0));
	});

	it('uses a fresh nonce every time', () => {
		const a = seal(key, plaintext, aad);
		const b = seal(key, plaintext, aad);

		expect(a.subarray(1, 1 + NONCE_LENGTH)).not.toEqual(b.subarray(1, 1 + NONCE_LENGTH));
	});

	it.each([
		['ciphertext', 1 + NONCE_LENGTH],
		['tag', OVERHEAD + plaintext.length - 1],
		['nonce', 5]
	])('rejects a flipped %s byte', (_, at) => {
		const sealed = seal(key, plaintext, aad);
		sealed[at] ^= 0x01;

		expect(code(() => open(key, sealed, aad))).toBe('auth');
	});

	it('rejects another version byte', () => {
		const sealed = seal(key, plaintext, aad);
		sealed[0] = 0x02;

		expect(code(() => open(key, sealed, aad))).toBe('version');
	});

	it('rejects data too short to carry a tag', () => {
		const sealed = seal(key, plaintext, aad);

		expect(code(() => open(key, sealed.subarray(0, OVERHEAD - 1), aad))).toBe('length');
		expect(code(() => open(key, new Uint8Array(0), aad))).toBe('length');
	});

	it('rejects the wrong aad', () => {
		expect(code(() => open(key, seal(key, plaintext, aad), utf8('test/v2')))).toBe('auth');
	});

	it('rejects the wrong key', () => {
		const other = new Uint8Array(32).map((_, i) => i + 2);

		expect(code(() => open(other, seal(key, plaintext, aad), aad))).toBe('auth');
	});

	it('says nothing beyond the code', () => {
		const sealed = seal(key, plaintext, aad);
		sealed[sealed.length - 1] ^= 0x01;

		expect(() => open(key, sealed, aad)).toThrow('cannot open sealed data: auth');
	});
});

describe('a zeroed key', () => {
	const zeroed = new Uint8Array(32);

	it('cannot seal, so that nothing in flight seals under a locked session', () => {
		expect(() => seal(zeroed, new Uint8Array([1]), aad)).toThrow(ZeroKeyError);
	});

	it('cannot open, even a message genuinely sealed under zeros', () => {
		const nonce = new Uint8Array(NONCE_LENGTH);
		const forged = new Uint8Array(OVERHEAD + 1);
		forged[0] = VERSION;
		forged.set(xchacha20poly1305(zeroed, nonce, aad).encrypt(new Uint8Array([1])), 25);

		expect(() => open(zeroed, forged, aad)).toThrow(ZeroKeyError);
	});
});
