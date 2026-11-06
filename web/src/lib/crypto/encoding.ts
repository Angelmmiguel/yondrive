/**
 * Byte encodings shared by every construction. `encodeFields` is the single
 * framing rule behind all AADs, signed messages and labelled hashes in
 * docs/CRYPTO.md: length prefixes make two different field lists unable to
 * produce the same bytes.
 */
import { base64 } from '@scure/base';

export type Bytes = Uint8Array<ArrayBuffer>;

/** Encodes bytes as padded standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
	return base64.encode(bytes);
}

/** Decodes padded standard base64, throwing on any character or padding error. */
export function decodeBase64(text: string): Bytes {
	return Uint8Array.from(base64.decode(text));
}

export function utf8(text: string): Bytes {
	return new TextEncoder().encode(text);
}

/** An unsigned 32-bit big-endian integer. */
export function u32(value: number): Bytes {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		throw new RangeError('not an unsigned 32-bit integer');
	}
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value);
	return out;
}

/** An unsigned 64-bit big-endian integer, from a safe JavaScript integer. */
export function u64(value: number): Bytes {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError('not a safe unsigned integer');
	}
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(value));
	return out;
}

/** The UTF-8 bytes of a node or version id. An empty id is always a bug. */
export function idBytes(id: string): Bytes {
	if (id.length === 0) throw new TypeError('empty id');
	return utf8(id);
}

/** `LP(label) || LP(field) ...`, where LP is a u32 length followed by the bytes. */
export function encodeFields(label: string, ...fields: Uint8Array[]): Bytes {
	const parts = [utf8(label), ...fields];
	const out = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(u32(part.length), at);
		out.set(part, at + 4);
		at += 4 + part.length;
	}
	return out;
}
