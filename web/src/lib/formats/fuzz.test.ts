/**
 * Malformed input, at random and on purpose: every reader either returns a model
 * or throws an Error, and never hangs or runs away with memory. The generator is
 * seeded, so a failure reproduces.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleDoc } from '../../../tests/fixtures/doc-sample';
import { readDocument, type DocFormat } from './document';
import { deflateRaw, entryData, readZip, writeZip, ZipError } from './zip';

const fixture = (n: string) =>
	new Uint8Array(readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url)));

function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function mutate(src: Uint8Array, r: () => number): Uint8Array {
	const out = src.slice();
	const kind = Math.floor(r() * 4);
	if (kind === 0) {
		for (let i = 0; i < 1 + r() * 20; i++)
			out[Math.floor(r() * out.length)] = Math.floor(r() * 256);
		return out;
	}
	if (kind === 1) return out.subarray(0, Math.floor(r() * out.length));
	if (kind === 2) {
		const at = Math.floor(r() * out.length);
		const len = Math.floor(r() * 64);
		out.copyWithin(at, Math.floor(r() * out.length), Math.floor(r() * out.length) + len);
		return out;
	}
	const extra = new Uint8Array(Math.floor(r() * 256)).map(() => Math.floor(r() * 256));
	const at = Math.floor(r() * out.length);
	const joined = new Uint8Array(out.length + extra.length);
	joined.set(out.subarray(0, at));
	joined.set(extra, at);
	joined.set(out.subarray(at), at + extra.length);
	return joined;
}

/** A zip's entries with their bytes flipped after decompression, recompressed honestly. */
async function mutateInside(src: Uint8Array, r: () => number): Promise<Uint8Array> {
	const zip = readZip(src);
	const changes = [];
	for (const e of zip.entries) {
		if (!e.name.endsWith('.xml') || r() > 0.5) continue;
		changes.push({ name: e.name, data: mutate(await entryData(e), r) });
	}
	return writeZip(zip, changes);
}

const cases: [DocFormat, () => Uint8Array][] = [
	['docx', () => fixture('docs/sample.docx')],
	['docx', () => fixture('report.docx')],
	['odt', () => fixture('docs/sample.odt')],
	['rtf', () => fixture('docs/sample.rtf')],
	['md', () => fixture('docs/sample.md')],
	['txt', () => fixture('docs/sample.md')],
	['doc', () => sampleDoc()]
];

describe('malformed input', () => {
	for (const [format, load] of cases) {
		it(`${format}: random damage gives a model or an error`, async () => {
			const r = rng(format.length * 7919 + load().length);
			const base = load();
			for (let i = 0; i < 150; i++) {
				let input = mutate(base, r);
				if ((format === 'docx' || format === 'odt') && i % 2 === 0) {
					input = await mutateInside(base, r).catch(() => input);
				}
				try {
					const out = await readDocument(input, format);
					expect(Array.isArray(out.model.blocks)).toBe(true);
				} catch (e) {
					expect(e).toBeInstanceOf(Error);
				}
			}
		}, 60_000);
	}
});

describe('zip bombs', () => {
	const zeros = new Uint8Array(32 * 1024 * 1024);

	it('refuses an entry that says it inflates past the ratio', async () => {
		const bomb = await writeZip(null, [{ name: 'word/document.xml', data: zeros }]);
		expect(() => readZip(bomb)).toThrow(ZipError);
		await expect(readDocument(bomb, 'docx')).rejects.toThrow();
	});

	it('stops inflating an entry that lies about its size', async () => {
		const honest = await writeZip(null, [{ name: 'word/document.xml', data: new Uint8Array(100) }]);
		const z = readZip(honest);
		const e = z.get('word/document.xml')!;
		const compressed = await deflateRaw(zeros);
		await expect(
			entryData({ ...e, compressed, compressedSize: compressed.length })
		).rejects.toThrow(ZipError);
	});

	it('refuses too many entries, duplicate names and too much in all', async () => {
		const many = await writeZip(
			null,
			Array.from({ length: 5000 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(1) }))
		);
		expect(() => readZip(many)).toThrow(/too many/);
		const two = await writeZip(null, [
			{ name: 'a', data: new Uint8Array(1) },
			{ name: 'b', data: new Uint8Array(1) }
		]);
		// Rename "b" to "a" wherever the name is written.
		const dup = two.map((x, i) => (x === 0x62 && two[i - 1] !== 0x62 ? 0x61 : x));
		expect(() => readZip(dup)).toThrow(/duplicate/);
		expect(() => readZip(two, { entries: 10, entrySize: 1, totalSize: 1, ratio: 1 })).toThrow(
			/too large/
		);
	});

	it('refuses deep XML before building it', async () => {
		const deep =
			'<w:document><w:body>' +
			'<w:p>'.repeat(300) +
			'</w:p>'.repeat(300) +
			'</w:body></w:document>';
		const z = await writeZip(null, [
			{ name: 'word/document.xml', data: new TextEncoder().encode(deep) }
		]);
		await expect(readDocument(z, 'docx')).rejects.toThrow(/deep/);
	});
});
