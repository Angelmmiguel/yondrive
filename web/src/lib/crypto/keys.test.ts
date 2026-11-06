import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { seal, SealError } from './aead';
import { encodeFields } from './encoding';
import {
	generateIdentity,
	generateMasterKey,
	openIdentity,
	sealIdentity,
	unwrapMasterKey,
	wrapMasterKey,
	zeroIdentity,
	type WrapPurpose
} from './keys';
import { ZeroKeyError } from './random';

const purposes: WrapPurpose[] = ['passphrase', 'recovery', 'session'];
const master = new Uint8Array(32).map((_, i) => 200 - i);
const kek = new Uint8Array(32).map((_, i) => i * 3 + 1);

describe('generateMasterKey', () => {
	it('is 32 random bytes', () => {
		const a = generateMasterKey();

		expect(a).toHaveLength(32);
		expect(a).not.toEqual(generateMasterKey());
	});
});

describe('wrapMasterKey and unwrapMasterKey', () => {
	it.each(purposes)('round-trip for %s', (purpose) => {
		const sealed = wrapMasterKey(master, kek, purpose);

		expect(sealed).toHaveLength(32 + 41);
		expect(unwrapMasterKey(sealed, kek, purpose)).toEqual(master);
	});

	it('refuses to open under another purpose', () => {
		for (const purpose of purposes) {
			const sealed = wrapMasterKey(master, kek, purpose);
			for (const other of purposes) {
				if (other === purpose) continue;
				expect(() => unwrapMasterKey(sealed, kek, other)).toThrow(SealError);
			}
		}
	});

	it('refuses to open under another kek', () => {
		const sealed = wrapMasterKey(master, kek, 'passphrase');
		const other = new Uint8Array(32).map((_, i) => i * 3 + 2);

		expect(() => unwrapMasterKey(sealed, other, 'passphrase')).toThrow(SealError);
	});

	it('refuses a zeroed kek', () => {
		expect(() => wrapMasterKey(master, new Uint8Array(32), 'passphrase')).toThrow(ZeroKeyError);
	});

	it('refuses a sealed value that is not 32 bytes', () => {
		const short = seal(kek, new Uint8Array(16), encodeFields('yondrive/master/passphrase/v1'));

		expect(() => unwrapMasterKey(short, kek, 'passphrase')).toThrow(SealError);
	});
});

describe('identity', () => {
	it('generates matching keypairs', () => {
		const identity = generateIdentity();

		expect(x25519.getPublicKey(identity.x25519.privateKey)).toEqual(identity.x25519.publicKey);
		expect(ed25519.getPublicKey(identity.ed25519.privateKey)).toEqual(identity.ed25519.publicKey);
		expect(generateIdentity().x25519.privateKey).not.toEqual(identity.x25519.privateKey);
	});

	it('round-trips through the master key', () => {
		const identity = generateIdentity();

		expect(openIdentity(sealIdentity(identity, master), master)).toEqual(identity);
	});

	it('refuses another master key', () => {
		const sealed = sealIdentity(generateIdentity(), master);

		expect(() => openIdentity(sealed, kek)).toThrow(SealError);
	});

	it('refuses a swapped public key', () => {
		const sealed = sealIdentity(generateIdentity(), master);
		const other = generateIdentity();

		expect(() =>
			openIdentity(
				{ ...sealed, publicKeys: { ...sealed.publicKeys, x25519: other.x25519.publicKey } },
				master
			)
		).toThrow(SealError);
		expect(() =>
			openIdentity(
				{ ...sealed, publicKeys: { ...sealed.publicKeys, ed25519: other.ed25519.publicKey } },
				master
			)
		).toThrow(SealError);
	});

	it('refuses the two private keys swapped', () => {
		const sealed = sealIdentity(generateIdentity(), master);

		expect(() =>
			openIdentity(
				{ ...sealed, sealedX25519: sealed.sealedEd25519, sealedEd25519: sealed.sealedX25519 },
				master
			)
		).toThrow(SealError);
	});

	it('refuses a private key that does not give its public key', () => {
		const a = generateIdentity();
		const publicKey = generateIdentity().x25519.publicKey;
		const sealed = sealIdentity(a, master);
		sealed.publicKeys.x25519 = publicKey;
		sealed.sealedX25519 = seal(
			master,
			a.x25519.privateKey,
			encodeFields('yondrive/identity/x25519/v1', publicKey)
		);

		expect(() => openIdentity(sealed, master)).toThrow(expect.objectContaining({ code: 'format' }));
	});

	it('zeroes both private keys', () => {
		const identity = generateIdentity();

		zeroIdentity(identity);

		expect(identity.x25519.privateKey).toEqual(new Uint8Array(32));
		expect(identity.ed25519.privateKey).toEqual(new Uint8Array(32));
	});
});
