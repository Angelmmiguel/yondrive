import { describe, expect, it } from 'vitest';
import { entryData, readZip } from '$lib/formats/zip';
import { assignPaths, buildExport, relativePath, rewriteLinks } from './export';
import { nodeHref } from './parse';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const IMG = 'c'.repeat(32);
const FILE = 'd'.repeat(32);

describe('exporting notes', () => {
	it('makes paths relative to the note', () => {
		expect(relativePath('Work/A.md', 'Work/B.md')).toBe('B.md');
		expect(relativePath('Work/A.md', 'Home/My note.md')).toBe('../Home/My%20note.md');
		expect(relativePath('A.md', 'Work/B.md')).toBe('Work/B.md');
		expect(relativePath('Work/A.md', 'B.md')).toBe('../B.md');
	});

	it('numbers clashing names', () => {
		const paths = assignPaths([
			{ id: '1', folder: 'Work', name: 'Plan.md' },
			{ id: '2', folder: 'Work', name: 'plan.md' },
			{ id: '3', folder: '', name: 'Plan.md' }
		]);
		expect([...paths.values()]).toEqual(['Work/Plan.md', 'Work/plan (2).md', 'Plan.md']);
	});

	it('keeps every path inside the archive, whatever the names say', () => {
		const paths = assignPaths([
			{ id: '1', folder: '..', name: '../../etc/passwd' },
			{ id: '2', folder: 'a/b', name: '..\\x.md' },
			{ id: '3', folder: '', name: '..' },
			{ id: '4', folder: ' . ', name: 'bell\u0007\u0000.md' },
			{ id: '5', folder: 'Work', name: 'CON.md' },
			{ id: '6', folder: 'lpt1', name: 'nul' },
			{ id: '7', folder: '', name: 'trailing. . ' },
			{ id: '8', folder: '', name: 'Console.md' }
		]);
		expect([...paths.values()]).toEqual([
			'_/..-..-etc-passwd',
			'a-b/..-x.md',
			'_',
			'_/bell--.md',
			'Work/_CON.md',
			'_lpt1/_nul',
			'trailing',
			'Console.md'
		]);
		for (const path of paths.values()) {
			expect(path.split('/').every((p) => p !== '..' && p !== '.' && p !== '')).toBe(true);
		}
	});

	it('rewrites links between notes and to pictures, and drops what is not exported', () => {
		const paths = new Map([
			[A, 'Work/A.md'],
			[B, 'Home/B note.md'],
			[IMG, 'Work/sketch.png']
		]);
		const src = `# A\n\nKept   as is.\n\nSee [B](${nodeHref(B)}), [doc](${nodeHref(FILE)}) and\n![sketch](${nodeHref(IMG)})\n`;
		expect(rewriteLinks(src, 'Work/A.md', paths)).toBe(
			'# A\n\nKept   as is.\n\nSee [B](../Home/B%20note.md), doc and ![sketch](sketch.png)\n'
		);
		expect(rewriteLinks('No links.\n', 'A.md', paths)).toBe('No links.\n');
	});

	it('builds a zip of plain Markdown files with links intact', async () => {
		const zip = await buildExport(
			[
				{ id: A, folder: 'Work', name: 'A.md', markdown: `Go to [B](${nodeHref(B)})\n` },
				{ id: B, folder: '', name: 'B.md', markdown: `Back to [A](${nodeHref(A)})\n` }
			],
			[{ id: IMG, folder: 'Work', name: 'sketch.png', bytes: new Uint8Array([1, 2, 3]) }]
		);
		const archive = readZip(zip);
		expect(archive.entries.map((e) => e.name)).toEqual(['Work/A.md', 'B.md', 'Work/sketch.png']);
		const text = async (name: string) =>
			new TextDecoder().decode(await entryData(archive.get(name)!));
		expect(await text('Work/A.md')).toBe('Go to [B](../B.md)\n');
		expect(await text('B.md')).toBe('Back to [A](Work/A.md)\n');
		expect([...(await entryData(archive.get('Work/sketch.png')!))]).toEqual([1, 2, 3]);
	});
});
