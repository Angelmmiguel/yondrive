/**
 * The one place the encryption modes differ. Callers get a `Sealer` for the
 * server's suite and use it the same way in both modes: in suite `none` keys
 * are empty byte strings that flow through untouched, wrapped values are empty,
 * and signatures are empty and always verify. Nothing outside this file branches
 * on the suite. A screen that exists only with keys, such as unlock, recovery or
 * the "Not encrypted" indicator, asks `encrypted`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { OVERHEAD, SealError } from './aead';
import {
	assertFrameLength,
	decryptFrame,
	deriveVersionKey,
	encryptFrame,
	type FramePosition,
	type VersionRef
} from './content';
import { encodeFields, utf8, type Bytes } from './encoding';
import { expandRoot } from './kdf';
import {
	generateIdentity,
	generateMasterKey,
	openIdentity,
	sealIdentity,
	unwrapMasterKey,
	wrapMasterKey,
	type Identity,
	type PublicKeys,
	type WrapPurpose
} from './keys';
import { signVersion, verifyVersion, type VersionManifest } from './manifest';
import {
	decodeMetadata,
	encodeMetadata,
	nameHmac,
	normalizeName,
	openMetadata,
	sealMetadata
} from './metadata';
import {
	generateNodeKey,
	openNodeKeyFrom,
	sealNodeKeyTo,
	unwrapNodeKey,
	unwrapRootNodeKey,
	wrapNodeKey,
	wrapRootNodeKey
} from './node';
import {
	clearPersistedMasterKey,
	persistMasterKey,
	resumeMasterKey,
	type SessionKeyApi
} from './persist';
import { constantTimeEqual, zero } from './random';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from './recovery';
import { openIndexSegment, openThumbnail, sealIndexSegment, sealThumbnail } from './small-blob';

export const SUITE_E2E = 'xchacha20poly1305-v1';
export const SUITE_NONE = 'none';
export type Suite = typeof SUITE_E2E | typeof SUITE_NONE;

/** The suite named by a stored or received value, or null if it is not one. */
export function parseSuite(value: unknown): Suite | null {
	return value === SUITE_E2E || value === SUITE_NONE ? value : null;
}

/** A user's usable keys; empty byte strings in suite `none`. */
export interface UserKeys {
	masterKey: Bytes;
	identity: Identity;
}

/** A user's keys as the server stores them; every field empty in suite `none`. */
export interface UserKeyRecord {
	wrappedMaster: Bytes;
	recoveryWrappedMaster: Bytes;
	publicKeys: PublicKeys;
	sealedX25519: Bytes;
	sealedEd25519: Bytes;
}

/** One stored frame and the SHA-256 of its bytes, kept by the server beside it. */
export interface SealedFrame {
	data: Bytes;
	sha256: Bytes;
}

/** Seals and opens the frames of one version. Close it to zero its key. */
export interface VersionCipher {
	sealFrame(position: FramePosition, plaintext: Uint8Array): SealedFrame;
	/** Checks `frame.sha256`, then opens the frame. Random access is fine. */
	openFrame(position: FramePosition, frame: SealedFrame): Bytes;
	close(): void;
}

export interface Sealer {
	readonly suite: Suite;
	readonly encrypted: boolean;
	/** Stored bytes per frame on top of its plaintext; frame `i` starts at `i * (frameSize + frameOverhead)`. */
	readonly frameOverhead: number;

	createUser(kek: Uint8Array, recoveryKek: Uint8Array): { keys: UserKeys; record: UserKeyRecord };
	wrapMaster(masterKey: Uint8Array, kek: Uint8Array, purpose: WrapPurpose): Bytes;
	unwrapMaster(wrapped: Uint8Array, kek: Uint8Array, purpose: WrapPurpose): Bytes;
	openUser(record: UserKeyRecord, masterKey: Bytes): UserKeys;

	/** A fresh recovery key; empty in suite `none`, which has none. */
	newRecoveryKey(): Bytes;
	/** The 24 words to show for a recovery key; none in suite `none`. */
	recoveryWords(recoveryKey: Uint8Array): string[];
	/** Decodes words typed by a person, or throws `InvalidRecoveryPhraseError`. */
	parseRecoveryPhrase(phrase: string): Bytes;
	/** The wrapping key and auth key of a recovery key; empty in suite `none`. */
	expandRecoveryKey(recoveryKey: Uint8Array): { kek: Bytes; authKey: Bytes };

	persistSession(masterKey: Uint8Array, api: SessionKeyApi): Promise<void>;
	/** The master key after a reload, or null when the user has to unlock again. */
	resumeSession(api: SessionKeyApi): Promise<Bytes | null>;
	clearSession(): void;

	newNodeKey(): Bytes;
	wrapRootNodeKey(nodeKey: Uint8Array, masterKey: Uint8Array, nodeId: string): Bytes;
	unwrapRootNodeKey(wrapped: Uint8Array, masterKey: Uint8Array, nodeId: string): Bytes;
	wrapNodeKey(nodeKey: Uint8Array, parentKey: Uint8Array, parentId: string, nodeId: string): Bytes;
	unwrapNodeKey(
		wrapped: Uint8Array,
		parentKey: Uint8Array,
		parentId: string,
		nodeId: string
	): Bytes;
	sealNodeKeyTo(nodeKey: Uint8Array, recipient: PublicKeys, nodeId: string): Bytes;
	openNodeKeyFrom(sealed: Uint8Array, keys: UserKeys, nodeId: string): Bytes;

	sealMetadata(nodeKey: Uint8Array, nodeId: string, value: unknown): Bytes;
	openMetadata(nodeKey: Uint8Array, nodeId: string, stored: Uint8Array): unknown;
	/** The duplicate-detection tag of a name, under its parent folder's key. */
	nameTag(parentKey: Uint8Array, name: string): Bytes;

	openVersion(nodeKey: Uint8Array, ref: VersionRef): VersionCipher;
	/**
	 * The one key a version's frames need, to hand to a worker without giving it
	 * the node key and with that everything under the node. Empty in suite `none`.
	 */
	versionKey(nodeKey: Uint8Array, ref: VersionRef): Bytes;
	/** `openVersion` from that key, which it takes over: closing zeroes it. */
	openVersionKey(versionKey: Bytes, ref: VersionRef): VersionCipher;
	signVersion(manifest: VersionManifest, keys: UserKeys): Bytes;
	/** Throws `SealError('signature')` unless the author's key signed this manifest. */
	verifyVersion(manifest: VersionManifest, signature: Uint8Array, author: PublicKeys): void;

	sealThumbnail(nodeKey: Uint8Array, nodeId: string, blobId: string, image: Uint8Array): Bytes;
	openThumbnail(nodeKey: Uint8Array, nodeId: string, blobId: string, stored: Uint8Array): Bytes;
	sealIndexSegment(masterKey: Uint8Array, blobId: string, segment: Uint8Array): Bytes;
	openIndexSegment(masterKey: Uint8Array, blobId: string, stored: Uint8Array): Bytes;
}

function frameDigest(data: Uint8Array): Bytes {
	return sha256(data) as Bytes;
}

function checkFrameDigest(frame: SealedFrame): void {
	if (!constantTimeEqual(frameDigest(frame.data), frame.sha256)) throw new SealError('integrity');
}

function e2eCipher(versionKey: Bytes, ref: VersionRef): VersionCipher {
	return {
		sealFrame(position, plaintext) {
			const data = encryptFrame(versionKey, ref, position, plaintext);
			return { data, sha256: frameDigest(data) };
		},
		openFrame(position, frame) {
			checkFrameDigest(frame);
			return decryptFrame(versionKey, ref, position, frame.data);
		},
		close() {
			zero(versionKey);
		}
	};
}

const e2eSealer: Sealer = {
	suite: SUITE_E2E,
	encrypted: true,
	frameOverhead: OVERHEAD,

	createUser(kek, recoveryKek) {
		const masterKey = generateMasterKey();
		const identity = generateIdentity();
		return {
			keys: { masterKey, identity },
			record: {
				wrappedMaster: wrapMasterKey(masterKey, kek, 'passphrase'),
				recoveryWrappedMaster: wrapMasterKey(masterKey, recoveryKek, 'recovery'),
				...sealIdentity(identity, masterKey)
			}
		};
	},
	wrapMaster: wrapMasterKey,
	unwrapMaster: unwrapMasterKey,
	openUser(record, masterKey) {
		return { masterKey, identity: openIdentity(record, masterKey) };
	},

	newRecoveryKey: generateRecoveryKey,
	recoveryWords: (recoveryKey) => formatRecoveryKey(recoveryKey).split(' '),
	parseRecoveryPhrase: parseRecoveryKey,
	expandRecoveryKey: expandRoot,

	persistSession: persistMasterKey,
	resumeSession: resumeMasterKey,
	clearSession: clearPersistedMasterKey,

	newNodeKey: generateNodeKey,
	wrapRootNodeKey,
	unwrapRootNodeKey,
	wrapNodeKey,
	unwrapNodeKey,
	sealNodeKeyTo: (nodeKey, recipient, nodeId) => sealNodeKeyTo(nodeKey, recipient.x25519, nodeId),
	openNodeKeyFrom: (sealed, keys, nodeId) => openNodeKeyFrom(sealed, keys.identity.x25519, nodeId),

	sealMetadata,
	openMetadata,
	nameTag: nameHmac,

	openVersion: (nodeKey, ref) => e2eCipher(deriveVersionKey(nodeKey, ref), ref),
	versionKey: deriveVersionKey,
	openVersionKey: e2eCipher,
	signVersion: (manifest, keys) => signVersion(manifest, keys.identity.ed25519.privateKey),
	verifyVersion: (manifest, signature, author) =>
		verifyVersion(manifest, signature, author.ed25519),

	sealThumbnail,
	openThumbnail,
	sealIndexSegment,
	openIndexSegment
};

const empty = (): Bytes => new Uint8Array(0);

function emptyUserKeys(): UserKeys {
	return {
		masterKey: empty(),
		identity: {
			x25519: { publicKey: empty(), privateKey: empty() },
			ed25519: { publicKey: empty(), privateKey: empty() }
		}
	};
}

function noneCipher(ref: VersionRef): VersionCipher {
	return {
		sealFrame(position, plaintext) {
			assertFrameLength(ref, position, plaintext.length);
			return { data: plaintext.slice() as Bytes, sha256: frameDigest(plaintext) };
		},
		openFrame(position, frame) {
			assertFrameLength(ref, position, frame.data.length);
			checkFrameDigest(frame);
			return frame.data.slice();
		},
		close() {}
	};
}

const noneSealer: Sealer = {
	suite: SUITE_NONE,
	encrypted: false,
	frameOverhead: 0,

	createUser() {
		return {
			keys: emptyUserKeys(),
			record: {
				wrappedMaster: empty(),
				recoveryWrappedMaster: empty(),
				publicKeys: { x25519: empty(), ed25519: empty() },
				sealedX25519: empty(),
				sealedEd25519: empty()
			}
		};
	},
	wrapMaster: empty,
	unwrapMaster: empty,
	openUser: emptyUserKeys,

	newRecoveryKey: empty,
	recoveryWords: () => [],
	parseRecoveryPhrase: empty,
	expandRecoveryKey: () => ({ kek: empty(), authKey: empty() }),

	persistSession: async () => {},
	resumeSession: async () => empty(),
	clearSession: () => {},

	newNodeKey: empty,
	wrapRootNodeKey: empty,
	unwrapRootNodeKey: empty,
	wrapNodeKey: empty,
	unwrapNodeKey: empty,
	sealNodeKeyTo: empty,
	openNodeKeyFrom: empty,

	sealMetadata: (_nodeKey, _nodeId, value) => encodeMetadata(value),
	openMetadata: (_nodeKey, _nodeId, stored) => decodeMetadata(stored),
	nameTag: (_parentKey, name) =>
		sha256(encodeFields('yondrive/name/none/v1', utf8(normalizeName(name)))) as Bytes,

	openVersion: (_nodeKey, ref) => noneCipher(ref),
	versionKey: empty,
	openVersionKey: (_versionKey, ref) => noneCipher(ref),
	signVersion: empty,
	verifyVersion: () => {},

	sealThumbnail: (_nodeKey, _nodeId, _blobId, image) => image.slice() as Bytes,
	openThumbnail: (_nodeKey, _nodeId, _blobId, stored) => stored.slice() as Bytes,
	sealIndexSegment: (_masterKey, _blobId, segment) => segment.slice() as Bytes,
	openIndexSegment: (_masterKey, _blobId, stored) => stored.slice() as Bytes
};

/** The sealer of a suite. */
export function sealerFor(suite: Suite): Sealer {
	return suite === SUITE_E2E ? e2eSealer : noneSealer;
}

/**
 * Whether the server's record shows the account holds keys, from any non-empty
 * key material: the input of the guard below. A server hiding only some of it
 * is still caught. It is deliberately not a `Sealer` method, because the sealer in
 * question would be the one chosen by the claim being checked.
 */
export function accountHasWrappedKeys(record: UserKeyRecord | null): boolean {
	if (record === null) return false;
	return [
		record.wrappedMaster,
		record.recoveryWrappedMaster,
		record.sealedX25519,
		record.sealedEd25519,
		record.publicKeys.x25519,
		record.publicKeys.ed25519
	].some((material) => material.length > 0);
}

/** Why a client refuses the mode the server claims. */
export type ModeRefusal = 'account-has-keys' | 'device-pinned' | 'unknown-suite';

/**
 * Whether a client may accept mode `none`: never when the account has wrapped
 * keys, since an account in that mode has none, and never on a device that
 * pinned end-to-end mode. A device with no pin and an account with no keys has
 * nothing to compare against and accepts; docs/SECURITY.md records that limit.
 */
export function mayAcceptNone(input: {
	accountHasWrappedKeys: boolean;
	pinned: Suite | null;
}): { accept: true } | { accept: false; reason: ModeRefusal } {
	if (input.accountHasWrappedKeys) return { accept: false, reason: 'account-has-keys' };
	if (input.pinned === SUITE_E2E) return { accept: false, reason: 'device-pinned' };
	return { accept: true };
}

/**
 * The full check to run on what the server claims. The mode is written once at
 * setup, so a change in either direction from the device's pin is an alert. On
 * acceptance the caller pins `suite` if it has no pin yet.
 */
export function decideMode(input: {
	claimed: unknown;
	accountHasWrappedKeys: boolean;
	pinned: Suite | null;
}): { accept: true; suite: Suite } | { accept: false; reason: ModeRefusal } {
	const suite = parseSuite(input.claimed);
	if (suite === null) return { accept: false, reason: 'unknown-suite' };
	if (suite === SUITE_NONE) {
		const decision = mayAcceptNone(input);
		return decision.accept ? { accept: true, suite } : decision;
	}
	if (input.pinned === SUITE_NONE) return { accept: false, reason: 'device-pinned' };
	return { accept: true, suite };
}
