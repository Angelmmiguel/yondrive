/**
 * A QR code encoder, as ISO/IEC 18004 has it, for the few short links the app
 * shows: byte mode, error correction level M, versions 1 to 10. It returns the
 * matrix of modules without the quiet zone, true for dark, row by row.
 */

/** Data codewords per block of each version at level M: [blocks, length] groups. */
const BLOCKS: readonly (readonly [number, number][])[] = [
	[[1, 16]],
	[[1, 28]],
	[[1, 44]],
	[[2, 32]],
	[[2, 43]],
	[[4, 27]],
	[[4, 31]],
	[
		[2, 38],
		[2, 39]
	],
	[
		[3, 36],
		[2, 37]
	],
	[
		[4, 43],
		[1, 44]
	]
];

/** Error correction codewords per block of each version at level M. */
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];

/** Centres of the alignment patterns of each version, in both directions. */
const ALIGNMENT: readonly number[][] = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50]
];

export const MAX_VERSION = 10;

/** Level M in the two bits of the format information. */
const LEVEL_M = 0b00;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** Multiplication in GF(256) under the polynomial 0x11d. */
export function gfMultiply(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** The `degree` Reed-Solomon codewords of `data`, under the generator with roots α^0 to α^(degree-1). */
export function reedSolomon(data: readonly number[], degree: number): number[] {
	let generator = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array<number>(generator.length + 1).fill(0);
		generator.forEach((c, j) => {
			next[j] ^= c;
			next[j + 1] ^= gfMultiply(c, EXP[i]);
		});
		generator = next;
	}
	const remainder = new Array<number>(degree).fill(0);
	for (const byte of data) {
		const factor = byte ^ remainder[0];
		remainder.shift();
		remainder.push(0);
		for (let j = 0; j < degree; j++) remainder[j] ^= gfMultiply(generator[j + 1], factor);
	}
	return remainder;
}

/** The 15 format bits for level M and a mask, BCH-coded and masked with 0x5412. */
export function formatBits(mask: number): number {
	const data = (LEVEL_M << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function versionBits(version: number): number {
	let rem = version;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (version << 12) | (rem & 0xfff);
}

const dataCodewords = (version: number) =>
	BLOCKS[version - 1].reduce((total, [count, length]) => total + count * length, 0);

const countBits = (version: number) => (version < 10 ? 8 : 16);

/** The most bytes a version holds at level M. */
export function capacity(version: number): number {
	return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

/** Thrown for text longer than the largest version holds. */
export class QrTooLongError extends Error {
	constructor() {
		super(`text does not fit a version ${MAX_VERSION} QR code`);
		this.name = 'QrTooLongError';
	}
}

function dataStream(bytes: Uint8Array, version: number): number[] {
	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, countBits(version));
	for (const byte of bytes) push(byte, 8);
	const total = dataCodewords(version) * 8;
	push(0, Math.min(4, total - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	const out: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		out.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
	}
	for (let pad = 0xec; out.length < total / 8; pad ^= 0xec ^ 0x11) out.push(pad);
	return out;
}

function interleave(data: number[], version: number): number[] {
	const blocks: number[][] = [];
	let at = 0;
	for (const [count, length] of BLOCKS[version - 1]) {
		for (let i = 0; i < count; i++) {
			blocks.push(data.slice(at, at + length));
			at += length;
		}
	}
	const ec = blocks.map((block) => reedSolomon(block, EC_PER_BLOCK[version - 1]));
	const out: number[] = [];
	const longest = Math.max(...blocks.map((block) => block.length));
	for (let i = 0; i < longest; i++) {
		for (const block of blocks) if (i < block.length) out.push(block[i]);
	}
	for (let i = 0; i < EC_PER_BLOCK[version - 1]; i++) {
		for (const block of ec) out.push(block[i]);
	}
	return out;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0,
	(_, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

class Matrix {
	readonly size: number;
	readonly modules: boolean[][];
	readonly reserved: boolean[][];

	constructor(readonly version: number) {
		this.size = 17 + 4 * version;
		this.modules = Array.from({ length: this.size }, () =>
			new Array<boolean>(this.size).fill(false)
		);
		this.reserved = Array.from({ length: this.size }, () =>
			new Array<boolean>(this.size).fill(false)
		);
	}

	set(x: number, y: number, dark: boolean): void {
		this.modules[y][x] = dark;
		this.reserved[y][x] = true;
	}

	drawFunctionPatterns(): void {
		const { size } = this;
		for (let i = 0; i < size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		for (const [cx, cy] of [
			[3, 3],
			[size - 4, 3],
			[3, size - 4]
		]) {
			for (let dy = -4; dy <= 4; dy++) {
				for (let dx = -4; dx <= 4; dx++) {
					const x = cx + dx;
					const y = cy + dy;
					if (x < 0 || y < 0 || x >= size || y >= size) continue;
					const ring = Math.max(Math.abs(dx), Math.abs(dy));
					this.set(x, y, ring !== 2 && ring !== 4);
				}
			}
		}
		const centres = ALIGNMENT[this.version - 1];
		const last = centres.length - 1;
		centres.forEach((cx, i) =>
			centres.forEach((cy, j) => {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					}
				}
			})
		);
		this.drawFormat(0);
		if (this.version >= 7) {
			const bits = versionBits(this.version);
			for (let i = 0; i < 18; i++) {
				const dark = ((bits >>> i) & 1) === 1;
				const a = size - 11 + (i % 3);
				const b = Math.floor(i / 3);
				this.set(a, b, dark);
				this.set(b, a, dark);
			}
		}
	}

	drawFormat(mask: number): void {
		const { size } = this;
		const bits = formatBits(mask);
		const bit = (i: number) => ((bits >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
		this.set(8, 7, bit(6));
		this.set(8, 8, bit(7));
		this.set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
		this.set(8, size - 8, true);
	}

	drawCodewords(codewords: number[]): void {
		const { size } = this;
		let i = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			const upward = ((right + 1) & 2) === 0;
			for (let vert = 0; vert < size; vert++) {
				const y = upward ? size - 1 - vert : vert;
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					if (this.reserved[y][x] || i >= codewords.length * 8) continue;
					this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
					i++;
				}
			}
		}
	}

	applyMask(mask: number): void {
		const test = MASKS[mask];
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.reserved[y][x] && test(x, y)) this.modules[y][x] = !this.modules[y][x];
			}
		}
	}

	penalty(): number {
		const { size, modules } = this;
		let score = 0;
		const finderLike = [true, false, true, true, true, false, true];
		const lines: boolean[][] = [];
		for (let i = 0; i < size; i++) {
			lines.push(modules[i]);
			lines.push(modules.map((row) => row[i]));
		}
		for (const line of lines) {
			let run = 1;
			for (let i = 1; i <= size; i++) {
				if (i < size && line[i] === line[i - 1]) {
					run++;
					continue;
				}
				if (run >= 5) score += 3 + run - 5;
				run = 1;
			}
			for (let i = 0; i + 7 <= size; i++) {
				if (!finderLike.every((dark, k) => line[i + k] === dark)) continue;
				const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
				const lightAfter = i + 11 <= size && [7, 8, 9, 10].every((k) => !line[i + k]);
				if (lightBefore || lightAfter) score += 40;
			}
		}
		let dark = 0;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (modules[y][x]) dark++;
				if (x + 1 < size && y + 1 < size) {
					const c = modules[y][x];
					if (modules[y][x + 1] === c && modules[y + 1][x] === c && modules[y + 1][x + 1] === c) {
						score += 3;
					}
				}
			}
		}
		const total = size * size;
		score += 10 * Math.floor(Math.abs((dark * 100) / total - 50) / 5);
		return score;
	}
}

/**
 * The modules of `text` as a QR code, in the smallest version that holds it. The
 * mask is the one with the lowest penalty, unless `mask` (0 to 7) forces one.
 */
export function encodeQr(text: string, mask?: number): boolean[][] {
	const bytes = new TextEncoder().encode(text);
	let version = 1;
	while (version <= MAX_VERSION && capacity(version) < bytes.length) version++;
	if (version > MAX_VERSION) throw new QrTooLongError();
	const codewords = interleave(dataStream(bytes, version), version);

	const build = (m: number) => {
		const matrix = new Matrix(version);
		matrix.drawFunctionPatterns();
		matrix.drawCodewords(codewords);
		matrix.applyMask(m);
		matrix.drawFormat(m);
		return matrix;
	};
	if (mask !== undefined) return build(mask).modules;
	let best = build(0);
	let bestScore = best.penalty();
	for (let m = 1; m < MASKS.length; m++) {
		const matrix = build(m);
		const score = matrix.penalty();
		if (score < bestScore) {
			best = matrix;
			bestScore = score;
		}
	}
	return best.modules;
}
