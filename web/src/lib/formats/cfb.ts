/**
 * The Compound File Binary container, which holds `.doc` (and `.xls`) streams in
 * a file system of sectors. Every chain is followed with a bound and a record of
 * where it has been, so a crafted file cannot loop, and nothing is read past the
 * end. The writer exists for building test files.
 */

export class CfbError extends Error {}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

export const CFB_LIMITS = { size: 256 * 1024 * 1024, entries: 65536 };

export interface CfbFile {
	/** Stream paths, storages joined by '/'. */
	names(): string[];
	get(path: string): Uint8Array | undefined;
}

interface DirEntry {
	name: string;
	type: number;
	left: number;
	right: number;
	child: number;
	start: number;
	size: number;
}

export function readCfb(buf: Uint8Array, limits = CFB_LIMITS): CfbFile {
	if (buf.length > limits.size) throw new CfbError('too large');
	if (buf.length < 512 || SIGNATURE.some((b, i) => buf[i] !== b))
		throw new CfbError('not a compound file');
	const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const shift = v.getUint16(0x1e, true);
	const miniShift = v.getUint16(0x20, true);
	if ((shift !== 9 && shift !== 12) || miniShift !== 6) throw new CfbError('bad sector size');
	const size = 1 << shift;
	const sectors = Math.floor((buf.length - size) / size) + (buf.length % size === 0 ? 0 : 1);
	const sectorAt = (n: number) => {
		if (n >= sectors) throw new CfbError('sector out of range');
		const start = (n + 1) * size;
		return buf.subarray(start, Math.min(start + size, buf.length));
	};

	// The sectors holding the FAT: 109 in the header, the rest in a DIFAT chain.
	const fatSectors: number[] = [];
	for (let i = 0; i < 109; i++) {
		const s = v.getUint32(0x4c + i * 4, true);
		if (s === FREESECT || s === ENDOFCHAIN) break;
		fatSectors.push(s);
	}
	let difat = v.getUint32(0x44, true);
	const seenDifat = new Set<number>();
	while (difat !== ENDOFCHAIN && difat !== FREESECT) {
		if (seenDifat.has(difat) || seenDifat.size > sectors) throw new CfbError('DIFAT loops');
		seenDifat.add(difat);
		const sec = sectorAt(difat);
		const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
		for (let i = 0; i < size / 4 - 1; i++) {
			const s = dv.getUint32(i * 4, true);
			if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
		}
		difat = dv.getUint32(size - 4, true);
	}
	if (fatSectors.length > sectors) throw new CfbError('FAT larger than the file');
	const fat = new Uint32Array(fatSectors.length * (size / 4));
	fatSectors.forEach((s, i) => {
		const sec = sectorAt(s);
		const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
		for (let k = 0; k < sec.length / 4; k++) fat[i * (size / 4) + k] = dv.getUint32(k * 4, true);
	});

	const chain = (start: number, table: Uint32Array, max: number): number[] => {
		const out: number[] = [];
		const seen = new Set<number>();
		let s = start;
		while (s !== ENDOFCHAIN && s !== FREESECT) {
			if (s >= table.length || seen.has(s) || out.length > max)
				throw new CfbError('bad sector chain');
			if (s === FATSECT) throw new CfbError('bad sector chain');
			seen.add(s);
			out.push(s);
			s = table[s];
		}
		return out;
	};
	const readChain = (start: number, length: number) => {
		const ids = chain(start, fat, sectors);
		const out = new Uint8Array(Math.min(length, ids.length * size));
		let o = 0;
		for (const id of ids) {
			if (o >= out.length) break;
			const sec = sectorAt(id);
			const take = Math.min(sec.length, out.length - o);
			out.set(sec.subarray(0, take), o);
			o += take;
		}
		if (Number.isFinite(length) && o < length) throw new CfbError('stream shorter than it says');
		return out;
	};

	const dirBytes = readChain(v.getUint32(0x30, true), Infinity);
	const entries: DirEntry[] = [];
	const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
	for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
		if (entries.length >= limits.entries) throw new CfbError('too many entries');
		const nameLen = Math.min(dv.getUint16(o + 64, true), 64);
		let name = '';
		for (let k = 0; k + 2 < nameLen; k += 2) name += String.fromCharCode(dv.getUint16(o + k, true));
		entries.push({
			name,
			type: dirBytes[o + 66],
			left: dv.getUint32(o + 68, true),
			right: dv.getUint32(o + 72, true),
			child: dv.getUint32(o + 76, true),
			start: dv.getUint32(o + 116, true),
			size: dv.getUint32(o + 120, true)
		});
	}
	const root = entries[0];
	if (root === undefined || root.type !== 5) throw new CfbError('no root entry');

	const cutoff = v.getUint32(0x38, true);
	let mini: { stream: Uint8Array; fat: Uint32Array } | null = null;
	const miniOf = () => {
		if (mini) return mini;
		const stream = root.size > 0 ? readChain(root.start, root.size) : new Uint8Array(0);
		const miniFatStart = v.getUint32(0x3c, true);
		const raw =
			miniFatStart === ENDOFCHAIN
				? new Uint8Array(0)
				: readChain(miniFatStart, v.getUint32(0x40, true) * size);
		const table = new Uint32Array(raw.length / 4);
		const mv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		for (let k = 0; k < table.length; k++) table[k] = mv.getUint32(k * 4, true);
		mini = { stream, fat: table };
		return mini;
	};

	const paths = new Map<string, DirEntry>();
	const walk = (id: number, prefix: string, depth: number, seen: Set<number>) => {
		if (id === NOSTREAM || id >= entries.length) return;
		if (seen.has(id) || depth > 64) throw new CfbError('directory loops');
		seen.add(id);
		const e = entries[id];
		walk(e.left, prefix, depth + 1, seen);
		const path = prefix + e.name;
		if (e.type === 2) paths.set(path, e);
		else if (e.type === 1) walk(e.child, `${path}/`, depth + 1, seen);
		walk(e.right, prefix, depth + 1, seen);
	};
	walk(root.child, '', 0, new Set());

	return {
		names: () => [...paths.keys()],
		get(path) {
			const e = paths.get(path);
			if (e === undefined) return undefined;
			if (e.size > buf.length) throw new CfbError('stream larger than the file');
			if (e.size < cutoff) {
				const m = miniOf();
				const ids = chain(e.start, m.fat, m.fat.length);
				const out = new Uint8Array(e.size);
				let o = 0;
				for (const id of ids) {
					if (o >= out.length) break;
					const from = id * 64;
					if (from + 64 > m.stream.length + 64) throw new CfbError('mini sector out of range');
					const piece = m.stream.subarray(from, Math.min(from + 64, m.stream.length));
					const take = Math.min(piece.length, out.length - o);
					out.set(piece.subarray(0, take), o);
					o += take;
				}
				if (o < e.size) throw new CfbError('stream shorter than it says');
				return out;
			}
			return readChain(e.start, e.size);
		}
	};
}

/** Writes streams at the top level of a version 3 compound file. For tests. */
export function writeCfb(streams: { name: string; data: Uint8Array }[]): Uint8Array {
	const size = 512;
	const cutoff = 4096;
	const sorted = [...streams].sort((a, b) =>
		a.name.length !== b.name.length
			? a.name.length - b.name.length
			: a.name.toUpperCase() < b.name.toUpperCase()
				? -1
				: 1
	);
	// Small streams go in the mini stream, 64 bytes a sector.
	const miniParts: Uint8Array[] = [];
	const miniFat: number[] = [];
	const starts = new Map<string, number>();
	for (const s of sorted) {
		if (s.data.length >= cutoff || s.data.length === 0) continue;
		const first = miniFat.length;
		const count = Math.ceil(s.data.length / 64);
		for (let k = 0; k < count; k++) miniFat.push(k === count - 1 ? ENDOFCHAIN : first + k + 1);
		const padded = new Uint8Array(count * 64);
		padded.set(s.data);
		miniParts.push(padded);
		starts.set(s.name, first);
	}
	const miniStream = concat(miniParts);
	const big = sorted.filter((s) => s.data.length >= cutoff);
	// Layout: directory, mini FAT, mini stream, big streams, then the FAT itself.
	const blobs: { key: string; data: Uint8Array }[] = [];
	const entryCount = sorted.length + 1;
	blobs.push({ key: 'dir', data: new Uint8Array(Math.ceil(entryCount / 4) * size) });
	const miniFatBytes = new Uint8Array(Math.ceil((miniFat.length * 4) / size) * size).fill(0xff);
	new Uint32Array(miniFatBytes.buffer).set(miniFat);
	if (miniFat.length > 0) blobs.push({ key: 'minifat', data: miniFatBytes });
	if (miniStream.length > 0) blobs.push({ key: 'ministream', data: miniStream });
	for (const s of big) blobs.push({ key: `s:${s.name}`, data: s.data });
	const sectorsOf = (n: number) => Math.ceil(n / size);
	let next = 0;
	const placed = new Map<string, { start: number; count: number }>();
	for (const b of blobs) {
		const count = sectorsOf(b.data.length);
		placed.set(b.key, { start: next, count });
		next += count;
	}
	let fatCount = 1;
	while ((next + fatCount) * 4 > fatCount * size) fatCount++;
	if (fatCount > 109) throw new CfbError('too large for the test writer');
	const total = next + fatCount;
	const fat = new Uint32Array(fatCount * (size / 4)).fill(FREESECT);
	for (const { start, count } of placed.values()) {
		for (let k = 0; k < count; k++) fat[start + k] = k === count - 1 ? ENDOFCHAIN : start + k + 1;
	}
	for (let k = 0; k < fatCount; k++) fat[next + k] = FATSECT;

	const dir = blobs[0].data;
	const dv = new DataView(dir.buffer);
	const writeEntry = (
		i: number,
		name: string,
		type: number,
		start: number,
		length: number,
		right: number,
		child: number
	) => {
		const o = i * 128;
		for (let k = 0; k < name.length; k++) dv.setUint16(o + k * 2, name.charCodeAt(k), true);
		dv.setUint16(o + 64, (name.length + 1) * 2, true);
		dir[o + 66] = type;
		dir[o + 67] = 1;
		dv.setUint32(o + 68, NOSTREAM, true);
		dv.setUint32(o + 72, right, true);
		dv.setUint32(o + 76, child, true);
		dv.setUint32(o + 116, start, true);
		dv.setUint32(o + 120, length, true);
	};
	const ms = placed.get('ministream');
	writeEntry(
		0,
		'Root Entry',
		5,
		ms ? ms.start : ENDOFCHAIN,
		miniStream.length,
		NOSTREAM,
		sorted.length > 0 ? 1 : NOSTREAM
	);
	sorted.forEach((s, i) => {
		const start =
			s.data.length === 0
				? ENDOFCHAIN
				: s.data.length < cutoff
					? (starts.get(s.name) as number)
					: placed.get(`s:${s.name}`)!.start;
		writeEntry(
			i + 1,
			s.name,
			2,
			start,
			s.data.length,
			i + 2 <= sorted.length ? i + 2 : NOSTREAM,
			NOSTREAM
		);
	});
	for (let i = entryCount; i < dir.length / 128; i++) {
		const o = i * 128;
		dv.setUint32(o + 68, NOSTREAM, true);
		dv.setUint32(o + 72, NOSTREAM, true);
		dv.setUint32(o + 76, NOSTREAM, true);
	}

	const header = new Uint8Array(size);
	const hv = new DataView(header.buffer);
	header.set(SIGNATURE);
	hv.setUint16(0x18, 0x3e, true);
	hv.setUint16(0x1a, 3, true);
	hv.setUint16(0x1c, 0xfffe, true);
	hv.setUint16(0x1e, 9, true);
	hv.setUint16(0x20, 6, true);
	hv.setUint32(0x2c, fatCount, true);
	hv.setUint32(0x30, placed.get('dir')!.start, true);
	hv.setUint32(0x38, cutoff, true);
	const mf = placed.get('minifat');
	hv.setUint32(0x3c, mf ? mf.start : ENDOFCHAIN, true);
	hv.setUint32(0x40, mf ? mf.count : 0, true);
	hv.setUint32(0x44, ENDOFCHAIN, true);
	for (let i = 0; i < 109; i++)
		hv.setUint32(0x4c + i * 4, i < fatCount ? next + i : FREESECT, true);

	const out = new Uint8Array(size * (total + 1));
	out.set(header);
	for (const b of blobs) out.set(b.data, (placed.get(b.key)!.start + 1) * size);
	const fatBytes = new Uint8Array(fat.buffer);
	out.set(fatBytes, (next + 1) * size);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
