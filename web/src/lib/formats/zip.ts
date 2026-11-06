// ZIP reader and writer on the native deflate-raw streams. Entries that are not
// replaced are written back with their original local record and central
// directory bytes, so an untouched entry is byte-identical after a save.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export class ZipError extends Error {}

export interface ZipEntry {
	name: string;
	/** 0 stored, 8 deflate. */
	method: number;
	crc32: number;
	compressedSize: number;
	size: number;
	/** Local header, data and any data descriptor, as found in the package. */
	local: Uint8Array;
	/** The central directory record, as found in the package. */
	central: Uint8Array;
	/** The compressed bytes only. */
	compressed: Uint8Array;
}

export interface ZipArchive {
	/** In the order of the central directory. */
	entries: ZipEntry[];
	get(name: string): ZipEntry | undefined;
}

/** A replacement or addition. Replacing keeps the entry's position. */
export type ZipChange = { name: string; data: Uint8Array };

const crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function pump(stream: TransformStream<Uint8Array, Uint8Array>, input: Uint8Array) {
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const write = async () => {
		await writer.write(input as Uint8Array<ArrayBuffer>);
		await writer.close();
	};
	const read = async () => {
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return chunks;
			chunks.push(value);
		}
	};
	const [, chunks] = await Promise.all([write(), read()]);
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

export const deflateRaw = (data: Uint8Array) =>
	pump(new CompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>, data);
export const inflateRaw = (data: Uint8Array) =>
	pump(new DecompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>, data);

/** Returns the uncompressed bytes of an entry, checking its CRC. */
export async function entryData(e: ZipEntry): Promise<Uint8Array> {
	let out: Uint8Array;
	if (e.method === 0) out = e.compressed;
	else if (e.method === 8) out = await inflateRaw(e.compressed);
	else throw new ZipError(`unsupported compression method ${e.method}`);
	if (out.length !== e.size || crc32(out) !== e.crc32)
		throw new ZipError(`bad checksum: ${e.name}`);
	return out;
}

export function readZip(buf: Uint8Array): ZipArchive {
	const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (v.getUint32(i, true) === SIG_EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError('end of central directory not found');
	const count = v.getUint16(eocd + 10, true);
	const cdSize = v.getUint32(eocd + 12, true);
	const cdOffset = v.getUint32(eocd + 16, true);
	if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
		throw new ZipError('zip64 is not supported');
	}
	const dec = new TextDecoder('utf-8', { fatal: false });
	const raw: { e: Omit<ZipEntry, 'local' | 'compressed'>; offset: number }[] = [];
	let p = cdOffset;
	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || v.getUint32(p, true) !== SIG_CENTRAL) {
			throw new ZipError('bad central directory');
		}
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const end = p + 46 + nameLen + extraLen + commentLen;
		if (end > buf.length) throw new ZipError('bad central directory');
		raw.push({
			offset: v.getUint32(p + 42, true),
			e: {
				name: dec.decode(buf.subarray(p + 46, p + 46 + nameLen)),
				method: v.getUint16(p + 10, true),
				crc32: v.getUint32(p + 16, true),
				compressedSize: v.getUint32(p + 20, true),
				size: v.getUint32(p + 24, true),
				central: buf.subarray(p, end)
			}
		});
		p = end;
	}
	// A record runs up to the next record or the directory, which also takes in
	// a trailing data descriptor.
	const starts = raw.map((r) => r.offset).sort((a, b) => a - b);
	const entries = raw.map(({ e, offset }) => {
		if (offset + 30 > buf.length || v.getUint32(offset, true) !== SIG_LOCAL) {
			throw new ZipError(`bad local header: ${e.name}`);
		}
		const dataStart = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
		const next = starts.find((s) => s > offset) ?? cdOffset;
		if (dataStart + e.compressedSize > next) throw new ZipError(`overlapping entry: ${e.name}`);
		return {
			...e,
			local: buf.subarray(offset, next),
			compressed: buf.subarray(dataStart, dataStart + e.compressedSize)
		};
	});
	const byName = new Map(entries.map((e) => [e.name, e]));
	return { entries, get: (n) => byName.get(n) };
}

function localHeader(name: Uint8Array, utf8: boolean, crc: number, csize: number, size: number) {
	const h = new Uint8Array(30 + name.length);
	const v = new DataView(h.buffer);
	v.setUint32(0, SIG_LOCAL, true);
	v.setUint16(4, 20, true);
	v.setUint16(6, utf8 ? 0x800 : 0, true);
	v.setUint16(8, 8, true);
	v.setUint16(10, 0, true);
	v.setUint16(12, 0x21, true); // 1980-01-01
	v.setUint32(14, crc, true);
	v.setUint32(18, csize, true);
	v.setUint32(22, size, true);
	v.setUint16(26, name.length, true);
	h.set(name, 30);
	return h;
}

function centralRecord(h: Uint8Array, offset: number) {
	const c = new Uint8Array(46 + h.length - 30);
	const v = new DataView(c.buffer);
	v.setUint32(0, SIG_CENTRAL, true);
	v.setUint16(4, 20, true);
	c.set(h.subarray(4, 30), 6); // version needed .. name length
	v.setUint16(30, 0, true);
	v.setUint32(42, offset, true);
	c.set(h.subarray(30), 46);
	return c;
}

/**
 * Writes an archive: every entry of `base` in its original order, with
 * `changes` replacing entries of the same name and any others appended.
 * Without a change, an entry's bytes are copied untouched.
 */
export async function writeZip(
	base: ZipArchive | null,
	changes: ZipChange[] = []
): Promise<Uint8Array> {
	const enc = new TextEncoder();
	const pending = new Map(changes.map((c) => [c.name, c]));
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	const push = (local: Uint8Array, cd: Uint8Array) => {
		parts.push(local);
		central.push(cd);
		offset += local.length;
	};
	const build = async (name: string, data: Uint8Array) => {
		const nameBytes = enc.encode(name);
		const utf8 = nameBytes.some((b) => b > 0x7f);
		const comp = await deflateRaw(data);
		const h = localHeader(nameBytes, utf8, crc32(data), comp.length, data.length);
		const cd = centralRecord(h, offset);
		const rec = new Uint8Array(h.length + comp.length);
		rec.set(h);
		rec.set(comp, h.length);
		push(rec, cd);
	};
	for (const e of base?.entries ?? []) {
		const change = pending.get(e.name);
		if (change) {
			pending.delete(e.name);
			await build(e.name, change.data);
		} else {
			const cd = e.central.slice();
			new DataView(cd.buffer).setUint32(42, offset, true);
			push(e.local, cd);
		}
	}
	for (const c of pending.values()) await build(c.name, c.data);
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const v = new DataView(end.buffer);
	v.setUint32(0, SIG_EOCD, true);
	v.setUint16(8, central.length, true);
	v.setUint16(10, central.length, true);
	v.setUint32(12, cdSize, true);
	v.setUint32(16, offset, true);
	const out = new Uint8Array(offset + cdSize + 22);
	let o = 0;
	for (const p of [...parts, ...central, end]) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
