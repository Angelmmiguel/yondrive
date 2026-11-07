import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readMarkdown, writeMarkdown } from './markdown';
import { plainText, type Block, type DocModel, type Paragraph } from './model';

const sample = readFileSync(
	new URL('../../../tests/fixtures/docs/sample.md', import.meta.url),
	'utf8'
);
const paras = (m: DocModel) => m.blocks.filter((b): b is Paragraph => b.type === 'paragraph');
const textOf = (b: Block) => plainText({ blocks: [b] });

describe('markdown', () => {
	it('reads blocks and inline marks', () => {
		const { model } = readMarkdown(sample);
		const ps = paras(model);
		expect(ps[0]).toMatchObject({ style: 'h1' });
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'trust', marks: { bold: true } });
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'speed', marks: { italic: true } });
		expect(ps[1].content).toContainEqual({ type: 'text', text: 'noise', marks: { strike: true } });
		expect(ps[1].content).toContainEqual({
			type: 'text',
			text: 'project page',
			marks: { link: 'https://example.org/plan' }
		});
		expect(ps.filter((p) => p.list?.kind === 'bullet').map((p) => p.list?.level)).toEqual([
			0, 0, 1, 0
		]);
		expect(ps.filter((p) => p.list?.kind === 'check').map((p) => p.list?.checked)).toEqual([
			false,
			true
		]);
		expect(
			ps.find((p) => p.style === 'code')?.content.filter((i) => i.type === 'break').length
		).toBe(1);
		expect(ps.some((p) => p.style === 'quote')).toBe(true);
		const table = model.blocks.find((b) => b.type === 'table');
		expect(
			table?.type === 'table' &&
				table.rows.map((r) =>
					r.cells.map((c) =>
						textOf({ type: 'paragraph', style: 'normal', content: c.content[0].content })
					)
				)
		).toEqual([
			['Initiative', 'Quarter'],
			['Sync rewrite', 'Q1'],
			['Conflict view', 'Q2']
		]);
		expect(ps.flatMap((p) => p.content).find((i) => i.type === 'image')).toMatchObject({
			image: 'pixel.png',
			alt: 'A small gradient'
		});
	});

	it('writes an unedited file back byte for byte', () => {
		const { model } = readMarkdown(sample);
		expect(writeMarkdown(model, sample)).toBe(sample);
	});

	it('changes only the edited block, and the rest stays as written', () => {
		const src = 'Intro *with* __odd__ markers\n\n* star item\n* second\n\nOutro\n';
		const { model } = readMarkdown(src);
		(model.blocks[2] as Paragraph).content = [{ type: 'text', text: 'second, edited', marks: {} }];
		model.blocks.splice(3, 0, {
			type: 'paragraph',
			style: 'normal',
			list: { kind: 'bullet', level: 0 },
			content: [{ type: 'text', text: 'third', marks: {} }]
		});
		expect(writeMarkdown(model, src)).toBe(
			'Intro *with* __odd__ markers\n\n* star item\n* second, edited\n- third\n\nOutro\n'
		);
	});

	it('round-trips what it writes for every supported mark and block', () => {
		const model: DocModel = {
			blocks: [
				{ type: 'paragraph', style: 'h2', content: [{ type: 'text', text: 'Heading', marks: {} }] },
				{
					type: 'paragraph',
					style: 'normal',
					content: [
						{ type: 'text', text: 'a ', marks: {} },
						{ type: 'text', text: 'bold', marks: { bold: true } },
						{ type: 'text', text: ' b ', marks: {} },
						{ type: 'text', text: 'it', marks: { italic: true } },
						{ type: 'text', text: ' c ', marks: {} },
						{ type: 'text', text: 'gone', marks: { strike: true } },
						{ type: 'text', text: ' d ', marks: {} },
						{ type: 'text', text: 'x`y', marks: { code: true } },
						{ type: 'text', text: ' e ', marks: {} },
						{ type: 'text', text: 'link', marks: { link: 'https://example.org/a b' } },
						{ type: 'text', text: ' *not emphasis* [nor link] #1 <b>', marks: {} },
						{ type: 'break' },
						{ type: 'text', text: '# not a heading', marks: {} }
					]
				},
				{
					type: 'paragraph',
					style: 'quote',
					content: [{ type: 'text', text: 'quoted', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'code',
					content: [
						{ type: 'text', text: 'line 1', marks: {} },
						{ type: 'break' },
						{ type: 'text', text: '```', marks: {} }
					]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'number', level: 0 },
					content: [{ type: 'text', text: 'one', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'number', level: 1 },
					content: [{ type: 'text', text: 'nested', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					list: { kind: 'check', level: 0, checked: true },
					content: [{ type: 'text', text: 'done', marks: {} }]
				},
				{
					type: 'paragraph',
					style: 'normal',
					content: [{ type: 'text', text: '1. not a list', marks: {} }]
				},
				{
					type: 'table',
					rows: [
						{
							cells: [
								{
									header: true,
									content: [
										{
											type: 'paragraph',
											style: 'normal',
											content: [{ type: 'text', text: 'H|1', marks: {} }]
										}
									]
								}
							]
						},
						{
							cells: [
								{
									content: [
										{
											type: 'paragraph',
											style: 'normal',
											content: [{ type: 'text', text: 'v', marks: { bold: true } }]
										}
									]
								}
							]
						}
					]
				}
			],
			images: {}
		};
		const out = writeMarkdown(model);
		const back = readMarkdown(out).model;
		const strip = (v: unknown) =>
			JSON.parse(JSON.stringify(v, (k, x) => (k === 'ref' ? undefined : x)));
		expect(strip(back.blocks)).toEqual(strip(model.blocks));
		expect(writeMarkdown(back, out)).toBe(out);
	});

	it('locks what it cannot represent and keeps it verbatim', () => {
		const src =
			'---\ntitle: x\n---\n\n<div class="x">raw</div>\n\n***\n\nText[^1]\n\n[^1]: note\n\n[ref]: https://example.org\n';
		const { model, census } = readMarkdown(src);
		expect(model.blocks.map((b) => (b.type === 'locked' ? b.label : b.type))).toEqual([
			'Front matter',
			'HTML',
			'Divider',
			'Footnote',
			'Footnote',
			'Link definitions'
		]);
		expect(census.items.some((i) => i.handling === 'locked')).toBe(true);
		expect(writeMarkdown(model, src)).toBe(src);
	});

	it('keeps raw HTML as text', () => {
		const { model } = readMarkdown('a <script>alert(1)</script> b');
		expect(textOf(model.blocks[0])).toBe('a <script>alert(1)</script> b');
	});

	it('stays bounded on hostile input', () => {
		const deep =
			'>'.repeat(5000) + ' x\n' + '- '.repeat(5000) + 'y\n' + '['.repeat(20000) + '*'.repeat(20000);
		expect(() => readMarkdown(deep)).not.toThrow();
		expect(() => readMarkdown('x'.repeat(9 * 1024 * 1024))).toThrow();
	});

	it('pairs emphasis in time that grows with the text, not its cube', () => {
		const started = performance.now();
		for (const src of [
			'*a'.repeat(40000),
			'_a '.repeat(30000),
			'a* '.repeat(30000),
			'*a '.repeat(15000) + 'b* '.repeat(15000)
		])
			readMarkdown(src);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(textOf(readMarkdown('*a *b* c*').model.blocks[0])).toBe('a b c');
		expect((readMarkdown('**a * b**').model.blocks[0] as Paragraph).content).toEqual([
			{ type: 'text', text: 'a * b', marks: { bold: true } }
		]);
	});
});
