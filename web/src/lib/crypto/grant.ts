/**
 * The signature on a grant. A sealed grant says nothing about who made it, as
 * anyone holding a public key can make one, the server included, so the granter
 * signs the node, both users, the role, the key generation and the sealed bytes.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { SealError } from './aead';
import { encodeFields, idBytes, u32, utf8, type Bytes } from './encoding';
import { assertKey } from './random';

/** What a grant's signature covers. */
export interface GrantFields {
	nodeId: string;
	granterId: string;
	granteeId: string;
	role: string;
	/** The generation of the node key that `sealedKey` holds. */
	generation: number;
	sealedKey: Uint8Array;
}

/** The exact bytes that are signed. */
export function grantMessage(grant: GrantFields): Bytes {
	return encodeFields(
		'yondrive/grant/v1',
		idBytes(grant.nodeId),
		idBytes(grant.granterId),
		idBytes(grant.granteeId),
		utf8(grant.role),
		u32(grant.generation),
		grant.sealedKey
	);
}

/** Signs a grant with the granter's Ed25519 private key. */
export function signGrant(grant: GrantFields, privateKey: Uint8Array): Bytes {
	assertKey(privateKey);
	return ed25519.sign(grantMessage(grant), privateKey) as Bytes;
}

/**
 * Verifies strictly, as a version's signature is, and throws `SealError('signature')`
 * so that a forgotten check of a return value cannot pass as success. That this key
 * is the pinned one of the node's owner is the caller's question.
 */
export function verifyGrant(
	grant: GrantFields,
	signature: Uint8Array,
	publicKey: Uint8Array
): void {
	let valid: boolean;
	try {
		valid = ed25519.verify(signature, grantMessage(grant), publicKey, { zip215: false });
	} catch {
		throw new SealError('signature');
	}
	if (!valid) throw new SealError('signature');
}
