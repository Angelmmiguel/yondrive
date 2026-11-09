/**
 * Comments: a body sealed for its file and signed by its author, and a thread's
 * anchor sealed and signed apart, by whoever placed it last. Both are sealed
 * under the comment subkey of the node key of the generation they record, and
 * bound to the ids of the node, the thread and the comment, so the server cannot
 * move one to another file, thread or comment, or claim another generation.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { open, seal, SealError } from './aead';
import { encodeFields, idBytes, u32, type Bytes } from './encoding';
import { expand } from './kdf';
import { decodeMetadata, encodeMetadata } from './metadata';
import { assertKey, zero } from './random';

/** Where a comment's body belongs. A thread's first comment has its own id as `threadId`. */
export interface CommentRef {
	nodeId: string;
	threadId: string;
	commentId: string;
	/** The generation of the node key it is sealed under. */
	generation: number;
}

/** Where a thread's anchor belongs. */
export interface AnchorRef {
	nodeId: string;
	threadId: string;
	generation: number;
}

/** What a body's signature covers: the sealed bytes, with who wrote them. */
export interface CommentFields extends CommentRef {
	authorId: string;
	sealed: Uint8Array;
}

/** What an anchor's signature covers. */
export interface AnchorFields extends AnchorRef {
	signerId: string;
	sealed: Uint8Array;
}

function under<T>(nodeKey: Uint8Array, use: (key: Bytes) => T): T {
	const key = expand(nodeKey, 'yondrive/comment/v1');
	try {
		return use(key);
	} finally {
		zero(key);
	}
}

const bodyAad = (ref: CommentRef) =>
	encodeFields(
		'yondrive/comment/body/v1',
		idBytes(ref.nodeId),
		idBytes(ref.threadId),
		idBytes(ref.commentId),
		u32(ref.generation)
	);

const anchorAad = (ref: AnchorRef) =>
	encodeFields(
		'yondrive/comment/anchor/v1',
		idBytes(ref.nodeId),
		idBytes(ref.threadId),
		u32(ref.generation)
	);

/** Seals a body, a JSON value, under the node key of `ref.generation`. */
export function sealCommentBody(nodeKey: Uint8Array, ref: CommentRef, value: unknown): Bytes {
	return under(nodeKey, (key) => seal(key, encodeMetadata(value), bodyAad(ref)));
}

export function openCommentBody(nodeKey: Uint8Array, ref: CommentRef, sealed: Uint8Array): unknown {
	return under(nodeKey, (key) => decodeMetadata(open(key, sealed, bodyAad(ref))));
}

export function sealCommentAnchor(nodeKey: Uint8Array, ref: AnchorRef, value: unknown): Bytes {
	return under(nodeKey, (key) => seal(key, encodeMetadata(value), anchorAad(ref)));
}

export function openCommentAnchor(
	nodeKey: Uint8Array,
	ref: AnchorRef,
	sealed: Uint8Array
): unknown {
	return under(nodeKey, (key) => decodeMetadata(open(key, sealed, anchorAad(ref))));
}

/** The exact bytes a body's author signs. */
export function commentMessage(c: CommentFields): Bytes {
	return encodeFields(
		'yondrive/comment/signed/v1',
		idBytes(c.nodeId),
		idBytes(c.threadId),
		idBytes(c.commentId),
		idBytes(c.authorId),
		u32(c.generation),
		c.sealed
	);
}

/** The exact bytes an anchor's signer signs. */
export function anchorMessage(a: AnchorFields): Bytes {
	return encodeFields(
		'yondrive/comment/anchor/signed/v1',
		idBytes(a.nodeId),
		idBytes(a.threadId),
		idBytes(a.signerId),
		u32(a.generation),
		a.sealed
	);
}

function sign(message: Bytes, privateKey: Uint8Array): Bytes {
	assertKey(privateKey);
	return ed25519.sign(message, privateKey) as Bytes;
}

/** Strict RFC 8032, and a throw rather than a result that could go unchecked. */
function verify(message: Bytes, signature: Uint8Array, publicKey: Uint8Array): void {
	let valid: boolean;
	try {
		valid = ed25519.verify(signature, message, publicKey, { zip215: false });
	} catch {
		throw new SealError('signature');
	}
	if (!valid) throw new SealError('signature');
}

export const signComment = (c: CommentFields, privateKey: Uint8Array): Bytes =>
	sign(commentMessage(c), privateKey);

/** Throws `SealError('signature')`. Whether the author may comment is the caller's question. */
export const verifyComment = (c: CommentFields, signature: Uint8Array, publicKey: Uint8Array) =>
	verify(commentMessage(c), signature, publicKey);

export const signAnchor = (a: AnchorFields, privateKey: Uint8Array): Bytes =>
	sign(anchorMessage(a), privateKey);

export const verifyAnchor = (a: AnchorFields, signature: Uint8Array, publicKey: Uint8Array) =>
	verify(anchorMessage(a), signature, publicKey);
