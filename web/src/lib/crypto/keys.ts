/**
 * The keys of a user: a random master key, wrapped under whatever opens it, and
 * the X25519 and Ed25519 identity keypairs sealed under the master key. Each
 * sealed private key binds its public key, so the server cannot pair it with
 * another one.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { open, seal, SealError } from './aead';
import { encodeFields, type Bytes } from './encoding';
import { constantTimeEqual, KEY_LENGTH, randomBytes, zero } from './random';

/** What a wrapped master key opens with; each gets its own AAD. */
export type WrapPurpose = 'passphrase' | 'recovery' | 'session';

export interface KeyPair {
	publicKey: Bytes;
	privateKey: Bytes;
}

/** A user's identity keypairs, usable and in memory only. */
export interface Identity {
	x25519: KeyPair;
	ed25519: KeyPair;
}

export interface PublicKeys {
	x25519: Bytes;
	ed25519: Bytes;
}

/** An identity as the server stores it. */
export interface SealedIdentity {
	publicKeys: PublicKeys;
	sealedX25519: Bytes;
	sealedEd25519: Bytes;
}

/** A fresh 32-byte master key. */
export function generateMasterKey(): Bytes {
	return randomBytes(KEY_LENGTH);
}

/** Seals the master key under `kek` for one purpose. */
export function wrapMasterKey(master: Uint8Array, kek: Uint8Array, purpose: WrapPurpose): Bytes {
	return seal(kek, master, masterAad(purpose));
}

/** Opens a wrapped master key; fails with `SealError` under the wrong key or purpose. */
export function unwrapMasterKey(sealed: Uint8Array, kek: Uint8Array, purpose: WrapPurpose): Bytes {
	return exactKey(open(kek, sealed, masterAad(purpose)));
}

function masterAad(purpose: WrapPurpose): Bytes {
	return encodeFields(`yondrive/master/${purpose}/v1`);
}

/** Fresh identity keypairs. */
export function generateIdentity(): Identity {
	const x = randomBytes(KEY_LENGTH);
	const ed = randomBytes(KEY_LENGTH);
	return {
		x25519: { publicKey: x25519.getPublicKey(x) as Bytes, privateKey: x },
		ed25519: { publicKey: ed25519.getPublicKey(ed) as Bytes, privateKey: ed }
	};
}

/** Seals both private keys under the master key. */
export function sealIdentity(identity: Identity, master: Uint8Array): SealedIdentity {
	return {
		publicKeys: { x25519: identity.x25519.publicKey, ed25519: identity.ed25519.publicKey },
		sealedX25519: seal(master, identity.x25519.privateKey, x25519Aad(identity.x25519.publicKey)),
		sealedEd25519: seal(master, identity.ed25519.privateKey, ed25519Aad(identity.ed25519.publicKey))
	};
}

/** Opens both private keys and checks that each one really gives its public key. */
export function openIdentity(sealed: SealedIdentity, master: Uint8Array): Identity {
	const { publicKeys } = sealed;
	const x = exactKey(open(master, sealed.sealedX25519, x25519Aad(publicKeys.x25519)));
	const ed = exactKey(open(master, sealed.sealedEd25519, ed25519Aad(publicKeys.ed25519)));
	if (
		!constantTimeEqual(x25519.getPublicKey(x), publicKeys.x25519) ||
		!constantTimeEqual(ed25519.getPublicKey(ed), publicKeys.ed25519)
	) {
		zero(x, ed);
		throw new SealError('format');
	}
	return {
		x25519: { publicKey: publicKeys.x25519, privateKey: x },
		ed25519: { publicKey: publicKeys.ed25519, privateKey: ed }
	};
}

/** Zeroes both private keys; best effort, see `zero`. */
export function zeroIdentity(identity: Identity): void {
	zero(identity.x25519.privateKey, identity.ed25519.privateKey);
}

function x25519Aad(publicKey: Uint8Array): Bytes {
	return encodeFields('yondrive/identity/x25519/v1', publicKey);
}

function ed25519Aad(publicKey: Uint8Array): Bytes {
	return encodeFields('yondrive/identity/ed25519/v1', publicKey);
}

function exactKey(key: Bytes): Bytes {
	if (key.length !== KEY_LENGTH) throw new SealError('format');
	return key;
}
