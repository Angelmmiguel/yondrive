import { describe, expect, it } from 'vitest';
import { analyze, linkMention, mentionAt, nodeHref, splitDue, tagsIn } from './parse';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('reading a note', () => {
	it('finds links by id, and [[Title]] links by title', () => {
		const facts = analyze(
			`See [the plan](${nodeHref(A)}) and [[Groceries]].\n\n![sketch](${nodeHref(B)})\n\n\`[[not a link]]\`\n`
		);
		expect(facts.links).toEqual([
			{ kind: 'node', target: A, context: 'See the plan and [[Groceries]].' },
			{ kind: 'title', target: 'Groceries', context: 'See the plan and [[Groceries]].' }
		]);
		expect(facts.images).toEqual([B]);
	});

	it('reads #tags from text, not from code, headings or numbers', () => {
		expect(tagsIn('Trip #travel and #Ideas/2027, issue #42')).toEqual(['travel', 'ideas/2027']);
		const facts = analyze('# Title\n\nAbout #sync.\n\n```\n#notatag\n```\n\nCode `#nope` here\n');
		expect(facts.tags).toEqual(['sync']);
	});

	it('reads checklists, with an optional due date', () => {
		const facts = analyze('- [x] Oat milk\n- [ ] Batteries @2026-11-20\n- plain item\n');
		expect(facts.tasks).toEqual([
			{ text: 'Oat milk', done: true, due: null },
			{ text: 'Batteries', done: false, due: '2026-11-20' }
		]);
		expect(splitDue('Call @2026-01-02 ')).toEqual({ text: 'Call', due: '2026-01-02' });
	});

	it('gives a preview without headings, the text, and the words', () => {
		const facts = analyze('## Plan\n\nFirst line.\n\nSecond line.\n');
		expect(facts.preview).toBe('First line.\nSecond line.');
		expect(facts.text).toContain('Plan');
		expect(facts.words).toBe(5);
	});

	it('finds a mention only as a whole phrase', () => {
		expect(mentionAt('the sync engine beta', 'Sync engine')).toBe(4);
		expect(mentionAt('async engines', 'sync engine')).toBe(-1);
		expect(mentionAt('x', 'x')).toBe(-1);
	});

	it('links the first plain mention, writing back only its paragraph', () => {
		const src = '# Log\n\nFirst   spacing kept.\n\nThe sync engine is stable.\n';
		const out = linkMention(src, 'Sync engine', A);
		expect(out).toBe(
			`# Log\n\nFirst   spacing kept.\n\nThe [sync engine](${nodeHref(A)}) is stable.\n`
		);
		expect(analyze(out as string).links[0]).toMatchObject({ kind: 'node', target: A });
		expect(linkMention(src, 'Nowhere', A)).toBeNull();
	});
});
