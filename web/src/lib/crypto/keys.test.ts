import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';
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

	it('refuses to wrap a zeroed master key', () => {
		expect(() => wrapMasterKey(new Uint8Array(32), kek, 'passphrase')).toThrow(ZeroKeyError);
	});

	it('refuses an opened value of all zeros', () => {
		const zeros = seal(kek, new Uint8Array(32), encodeFields('yondrive/master/passphrase/v1'));

		expect(() => unwrapMasterKey(zeros, kek, 'passphrase')).toThrow(
			expect.objectContaining({ code: 'format' })
		);
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

	it.each(['x25519', 'ed25519'] as const)('refuses to seal a zeroed %s private key', (kind) => {
		const identity = generateIdentity();
		identity[kind].privateKey.fill(0);

		expect(() => sealIdentity(identity, master)).toThrow(ZeroKeyError);
	});

	it('refuses a sealed private key of all zeros', () => {
		const sealed = sealIdentity(generateIdentity(), master);
		sealed.sealedEd25519 = seal(
			master,
			new Uint8Array(32),
			encodeFields('yondrive/identity/ed25519/v1', sealed.publicKeys.ed25519)
		);

		expect(() => openIdentity(sealed, master)).toThrow(expect.objectContaining({ code: 'format' }));
	});

	it('zeroes the opened X25519 private key when the Ed25519 one fails to open', () => {
		const identity = generateIdentity();
		const sealed = sealIdentity(identity, master);
		sealed.sealedEd25519[sealed.sealedEd25519.length - 1] ^= 1;
		const filled: string[] = [];
		const original = Uint8Array.prototype.fill;
		const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
			this: Uint8Array,
			...args
		) {
			filled.push(Array.from(this).join());
			return original.apply(this, args);
		});

		expect(() => openIdentity(sealed, master)).toThrow(SealError);

		spy.mockRestore();
		expect(filled).toContain(Array.from(identity.x25519.privateKey).join());
	});

	it('zeroes both private keys', () => {
		const identity = generateIdentity();

		zeroIdentity(identity);

		expect(identity.x25519.privateKey).toEqual(new Uint8Array(32));
		expect(identity.ed25519.privateKey).toEqual(new Uint8Array(32));
	});
});
