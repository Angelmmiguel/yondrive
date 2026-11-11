import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import {
	capacity,
	encodeQr,
	formatBits,
	gfMultiply,
	MAX_VERSION,
	QrTooLongError,
	reedSolomon
} from './encode';

const hexBytes = (text: string) => text.split(' ').map((byte) => parseInt(byte, 16));

/** The matrix drawn with a four-module quiet zone, `scale` pixels a module, as RGBA. */
function render(modules: boolean[][], scale = 4) {
	const quiet = 4;
	const width = (modules.length + 2 * quiet) * scale;
	const data = new Uint8ClampedArray(width * width * 4).fill(255);
	modules.forEach((row, y) =>
		row.forEach((dark, x) => {
			if (!dark) return;
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const at = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4;
					data.fill(0, at, at + 3);
				}
			}
		})
	);
	return { data, width };
}

function decode(modules: boolean[][]): string | undefined {
	const { data, width } = render(modules);
	return jsQR(data, width, width)?.data;
}

const versionOf = (modules: boolean[][]) => (modules.length - 17) / 4;

describe('Reed-Solomon over GF(256)', () => {
	it('multiplies in the field', () => {
		expect(gfMultiply(0, 0x53)).toBe(0);
		expect(gfMultiply(1, 0x53)).toBe(0x53);
		expect(gfMultiply(2, 0x80)).toBe(0x1d);
		expect(gfMultiply(0x53, 0xca)).toBe(gfMultiply(0xca, 0x53));
	});

	it('matches the worked example of version 1-M ("01234567")', () => {
		const data = hexBytes('10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11');
		expect(reedSolomon(data, 10)).toEqual(hexBytes('A5 24 D4 C1 ED 36 C7 87 2C 55'));
	});
});

describe('format information', () => {
	const levelM = [
		'101010000010010',
		'101000100100101',
		'101111001111100',
		'101101101001011',
		'100010111111001',
		'100000011001110',
		'100111110010111',
		'100101010100000'
	];

	it('is the BCH code of level M and each mask', () => {
		levelM.forEach((bits, mask) => expect(formatBits(mask)).toBe(parseInt(bits, 2)));
	});

	it('is drawn in both copies for each mask', () => {
		levelM.forEach((bits, mask) => {
			const m = encodeQr('yondrive', mask);
			const size = m.length;
			const bit = (i: number) => bits[14 - i] === '1';
			const first = [
				...[0, 1, 2, 3, 4, 5].map((i) => m[i][8]),
				m[7][8],
				m[8][8],
				m[8][7],
				...[9, 10, 11, 12, 13, 14].map((i) => m[8][14 - i])
			];
			const second = [
				...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => m[8][size - 1 - i]),
				...[8, 9, 10, 11, 12, 13, 14].map((i) => m[size - 15 + i][8])
			];
			const want = Array.from({ length: 15 }, (_, i) => bit(i));
			expect(first).toEqual(want);
			expect(second).toEqual(want);
			expect(m[size - 8][8]).toBe(true);
			expect(decode(m)).toBe('yondrive');
		});
	});
});

describe('encodeQr', () => {
	it('is 17 + 4v modules a side with three finder patterns', () => {
		const m = encodeQr('hello');
		expect(m.length).toBe(21);
		m.forEach((row) => expect(row.length).toBe(21));
		const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
		for (const [x0, y0] of [
			[0, 0],
			[14, 0],
			[0, 14]
		]) {
			const drawn = finder.map((_, y) =>
				finder.map((__, x) => (m[y0 + y][x0 + x] ? '1' : '0')).join('')
			);
			expect(drawn).toEqual(finder);
		}
		// The separators around them are light.
		for (let i = 0; i < 8; i++) {
			expect(m[7][i]).toBe(false);
			expect(m[i][7]).toBe(false);
		}
	});

	it('picks the smallest version and decodes at every one from 1 to 10', () => {
		for (let version = 1; version <= MAX_VERSION; version++) {
			const text = 'x'.repeat(capacity(version) - 3) + 'end';
			const m = encodeQr(text);
			expect(versionOf(m)).toBe(version);
			expect(m.length).toBe(17 + 4 * version);
			expect(decode(m)).toBe(text);
			if (version < MAX_VERSION) expect(versionOf(encodeQr(text + 'y'))).toBe(version + 1);
		}
	});

	it('round-trips pairing links of several lengths', () => {
		const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
		const key = 'Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
		for (const host of [
			'localhost:5173',
			'drive.example.com',
			'files.a-rather-long-household-name.example.org:8443'
		]) {
			const link = `https://${host}/pair#1.${id}.${key}`;
			expect(decode(encodeQr(link))).toBe(link);
		}
	});

	it('encodes text as UTF-8', () => {
		expect(decode(encodeQr('café ✓'))).toBe('café ✓');
	});

	it('refuses text larger than version 10 holds', () => {
		expect(() => encodeQr('x'.repeat(capacity(MAX_VERSION) + 1))).toThrow(QrTooLongError);
	});
});
