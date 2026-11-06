import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crc32, entryData, readZip, writeZip, ZipError } from './zip';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));
const enc = new TextEncoder();
const dec = new TextDecoder();

describe('zip', () => {
	it('computes a standard crc32', () => {
		expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
	});

	it('round-trips entries written from scratch', async () => {
		const big = enc.encode('abc'.repeat(5000));
		const buf = await writeZip(null, [
			{ name: 'a.txt', data: enc.encode('hello') },
			{ name: 'dir/é.bin', data: big }
		]);
		const z = readZip(buf);
		expect(z.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/é.bin']);
		expect(dec.decode(await entryData(z.get('a.txt')!))).toBe('hello');
		expect(await entryData(z.get('dir/é.bin')!)).toEqual(big);
		expect(z.get('dir/é.bin')!.compressedSize).toBeLessThan(big.length);
	});

	it('writes back an unchanged archive identically', async () => {
		for (const f of ['report.docx', 'book.xlsx']) {
			const buf = fixture(f);
			const z = readZip(buf);
			expect(z.entries.length).toBeGreaterThan(3);
			const out = await writeZip(z);
			const z2 = readZip(out);
			expect(z2.entries.map((e) => e.name)).toEqual(z.entries.map((e) => e.name));
			for (const e of z.entries) expect(z2.get(e.name)!.compressed).toEqual(e.compressed);
			// Directory and offsets are recomputed, so only the records are compared.
			expect(out.length).toBeLessThanOrEqual(buf.length + 1);
		}
	});

	it('replaces one entry in place and keeps the rest verbatim', async () => {
		const z = readZip(fixture('report.docx'));
		const name = 'word/document.xml';
		const text = dec
			.decode(await entryData(z.get(name)!))
			.replace('First paragraph', 'Edited paragraph');
		const out = readZip(await writeZip(z, [{ name, data: enc.encode(text) }]));
		expect(out.entries.map((e) => e.name)).toEqual(z.entries.map((e) => e.name));
		for (const e of z.entries) {
			const o = out.get(e.name)!;
			if (e.name === name) expect(dec.decode(await entryData(o))).toContain('Edited paragraph');
			else {
				expect(o.local).toEqual(e.local);
				expect(o.compressed).toEqual(e.compressed);
			}
		}
	});

	it('appends new entries after existing ones', async () => {
		const z = readZip(fixture('book.xlsx'));
		const out = readZip(await writeZip(z, [{ name: 'xl/new.xml', data: enc.encode('<x/>') }]));
		expect(out.entries.at(-1)!.name).toBe('xl/new.xml');
		expect(out.entries.length).toBe(z.entries.length + 1);
	});

	it('rejects garbage and corrupted data', async () => {
		expect(() => readZip(enc.encode('not a zip file at all, really not'))).toThrow(ZipError);
		const buf = await writeZip(null, [{ name: 'a', data: enc.encode('hello world') }]);
		const z = readZip(buf);
		const e = z.get('a')!;
		e.compressed[0] ^= 0xff;
		await expect(entryData(e)).rejects.toThrow();
	});
});
