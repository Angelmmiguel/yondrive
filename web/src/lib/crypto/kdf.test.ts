import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { encodeBase64 } from './encoding';
import { ZeroKeyError } from './random';
import {
	DEFAULT_KDF,
	deriveKek,
	expand,
	deriveRoot,
	expandRoot,
	InvalidKdfParamsError,
	newKdfParams,
	normalizePassphrase,
	parseKdfParams,
	PassphraseTooLongError,
	PassphraseTooShortError,
	type KdfParams
} from './kdf';

/** The cheapest parameters the bounds allow, to keep the suite fast. */
function tiny(salt = Buffer.alloc(16, 7)): KdfParams {
	return { name: 'argon2id', m: 8192, t: 1, p: 1, salt: encodeBase64(salt) };
}

describe('known answers', () => {
	// RFC 9106 §5.3, the Argon2id test vector: t=3, m=32 KiB, p=4, tag length
	// 32, with the secret and associated data the RFC includes.
	it('argon2id reproduces the RFC 9106 §5.3 vector', () => {
		const tag = argon2id(Buffer.alloc(32, 0x01), Buffer.alloc(16, 0x02), {
			t: 3,
			m: 32,
			p: 4,
			dkLen: 32,
			key: Buffer.alloc(8, 0x03),
			personalization: Buffer.alloc(12, 0x04)
		});
		expect(bytesToHex(tag)).toBe(
			'0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659'
		);
	});

	// RFC 5869 appendix A.1, test case 1 with SHA-256.
	it('hkdf reproduces RFC 5869 test case 1', () => {
		const okm = hkdf(
			sha256,
			Buffer.alloc(22, 0x0b),
			hexToBytes('000102030405060708090a0b0c'),
			hexToBytes('f0f1f2f3f4f5f6f7f8f9'),
			42
		);
		expect(bytesToHex(okm)).toBe(
			'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
		);
	});
});

describe('normalizePassphrase', () => {
	it('applies NFKC', () => {
		expect(normalizePassphrase('cafe\u0301 au lait 12')).toBe('caf\u00e9 au lait 12');
		expect(normalizePassphrase('\ufb01sh and chips')).toBe('fish and chips');
	});

	it('counts code points, not UTF-16 units', () => {
		expect(normalizePassphrase('🔑'.repeat(12))).toBe('🔑'.repeat(12));
		expect(() => normalizePassphrase('🔑'.repeat(11))).toThrow(PassphraseTooShortError);
	});

	it('rejects short and long passphrases', () => {
		expect(() => normalizePassphrase('short')).toThrow(PassphraseTooShortError);
		expect(() => normalizePassphrase('')).toThrow(PassphraseTooShortError);
		expect(normalizePassphrase('a'.repeat(1024))).toHaveLength(1024);
		expect(() => normalizePassphrase('a'.repeat(1025))).toThrow(PassphraseTooLongError);
	});
});

describe('newKdfParams', () => {
	it('uses the defaults with a fresh 16-byte salt', () => {
		const a = newKdfParams();
		const b = newKdfParams();

		expect(a).toMatchObject(DEFAULT_KDF);
		expect(Buffer.from(a.salt, 'base64')).toHaveLength(16);
		expect(a.salt).not.toBe(b.salt);
		expect(parseKdfParams(a)).toEqual(a);
	});
});

describe('parseKdfParams', () => {
	const salt = encodeBase64(new Uint8Array(16));
	const good = { name: 'argon2id', m: 65536, t: 3, p: 1, salt };

	it('accepts the defaults and keeps only the known fields', () => {
		expect(parseKdfParams({ ...good, extra: 'x' })).toEqual(good);
		expect(parseKdfParams({ ...good, m: 8192, t: 1 })).toMatchObject({ m: 8192, t: 1 });
		expect(parseKdfParams({ ...good, m: 1048576, t: 10 })).toMatchObject({ m: 1048576, t: 10 });
	});

	it.each([
		['a hostile cost', { ...good, m: 1, t: 1 }],
		['m below the floor', { ...good, m: 8191 }],
		['m above the ceiling', { ...good, m: 1048577 }],
		['m not an integer', { ...good, m: 65536.5 }],
		['m as a string', { ...good, m: '65536' }],
		['t zero', { ...good, t: 0 }],
		['t too high', { ...good, t: 11 }],
		['p two', { ...good, p: 2 }],
		['p zero', { ...good, p: 0 }],
		['another algorithm', { ...good, name: 'scrypt' }],
		['no name', { m: 65536, t: 3, p: 1, salt }],
		['a short salt', { ...good, salt: encodeBase64(new Uint8Array(15)) }],
		['a long salt', { ...good, salt: encodeBase64(new Uint8Array(17)) }],
		['a salt that is not base64', { ...good, salt: '!!!!' }],
		['a missing salt', { name: 'argon2id', m: 65536, t: 3, p: 1 }],
		['null', null],
		['a string', 'argon2id'],
		['an array', [good]]
	])('rejects %s', (_, value) => {
		expect(() => parseKdfParams(value)).toThrow(InvalidKdfParamsError);
	});
});

describe('deriveRoot', () => {
	it('is deterministic and 32 bytes', () => {
		const a = deriveRoot('correct horse battery', tiny());
		const b = deriveRoot('correct horse battery', tiny());

		expect(a).toHaveLength(32);
		expect(a).toEqual(b);
		expect(a.buffer).toBeInstanceOf(ArrayBuffer);
	});

	it('depends on the salt and the passphrase', () => {
		const base = deriveRoot('correct horse battery', tiny());

		expect(deriveRoot('correct horse battery', tiny(Buffer.alloc(16, 8)))).not.toEqual(base);
		expect(deriveRoot('correct horse batterz', tiny())).not.toEqual(base);
	});

	it('derives the same root from composed and decomposed input', () => {
		expect(deriveRoot('cafe\u0301 au lait 12', tiny())).toEqual(
			deriveRoot('caf\u00e9 au lait 12', tiny())
		);
	});

	it('enforces the parameter bounds itself', () => {
		expect(() => deriveRoot('correct horse battery', { ...tiny(), m: 64 })).toThrow(
			InvalidKdfParamsError
		);
		expect(() => deriveRoot('correct horse battery', { ...tiny(), t: 0 })).toThrow(
			InvalidKdfParamsError
		);
		expect(() => deriveRoot('correct horse battery', { ...tiny(), salt: 'AAAA' })).toThrow(
			InvalidKdfParamsError
		);
	});

	it('enforces the passphrase limits', () => {
		expect(() => deriveRoot('short', tiny())).toThrow(PassphraseTooShortError);
	});
});

describe('expandRoot', () => {
	const root = new Uint8Array(32).map((_, i) => i);

	it('yields two distinct 32-byte keys, deterministically', () => {
		const { kek, authKey } = expandRoot(root);

		expect(kek).toHaveLength(32);
		expect(authKey).toHaveLength(32);
		expect(kek).not.toEqual(authKey);
		expect(expandRoot(root)).toEqual({ kek, authKey });
	});

	it('is HKDF-SHA256 without salt under the documented labels', () => {
		const info = (label: string) => new TextEncoder().encode(label);

		expect(expandRoot(root)).toEqual({
			kek: hkdf(sha256, root, undefined, info('yondrive/kek/v1'), 32),
			authKey: hkdf(sha256, root, undefined, info('yondrive/auth/v1'), 32)
		});
	});
});

describe('deriveKek and expand', () => {
	const root = new Uint8Array(32).map((_, i) => i + 1);

	it('deriveKek gives the KEK of expandRoot, with no auth key to leak', () => {
		expect(deriveKek(root)).toEqual(expandRoot(root).kek);
	});

	it('refuses a zeroed key and anything that is not 32 bytes', () => {
		expect(() => expand(new Uint8Array(32), 'x')).toThrow(ZeroKeyError);
		expect(() => expand(new Uint8Array(0), 'x')).toThrow(RangeError);
	});
});
