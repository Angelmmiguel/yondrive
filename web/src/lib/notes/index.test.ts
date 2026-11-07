import { describe, expect, it } from 'vitest';
import { backlinks, NotesIndex, resolveLink, tagCounts, tagsOf, unlinkedMentions } from './index';
import { analyze, nodeHref } from './parse';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const notes = [
	{ id: A, title: 'Sync engine' },
	{ id: B, title: 'Q1 planning' },
	{ id: C, title: 'Mon, Nov 2' }
];

function build() {
	const index = new NotesIndex();
	index.set(A, 'v1', analyze('The design.\n'));
	index.set(B, 'v1', analyze(`Three bets, starting with the [sync](${nodeHref(A)}) rewrite.\n`));
	index.set(C, 'v1', analyze('The sync engine beta is stable. See [[Q1 planning]]. #journal\n'));
	return index;
}

describe('the notes index', () => {
	it('answers backlinks by id and by title, with context', () => {
		const index = build();
		expect(backlinks(index, A, notes)).toEqual([
			{ from: B, context: 'Three bets, starting with the sync rewrite.' }
		]);
		expect(backlinks(index, B, notes).map((b) => b.from)).toEqual([C]);
		expect(resolveLink({ kind: 'title', target: 'q1 PLANNING', context: '' }, notes)).toBe(B);
		// A note no longer there links nothing.
		expect(
			backlinks(
				index,
				A,
				notes.filter((n) => n.id !== B)
			)
		).toEqual([]);
	});

	it('finds unlinked mentions, and not where a link is', () => {
		const index = build();
		expect(unlinkedMentions(index, notes[0], notes)).toEqual([
			{ from: C, context: 'The sync engine beta is stable. See [[Q1 planning]]. #journal' }
		]);
		expect(unlinkedMentions(index, notes[1], notes)).toEqual([]);
	});

	it('counts tags given and written', () => {
		const index = build();
		expect(tagsOf(index.get(C), ['work'])).toEqual(['work', 'journal']);
		expect(tagCounts([['a', 'b'], ['b'], ['b', 'b']])).toEqual([
			{ tag: 'b', count: 3 },
			{ tag: 'a', count: 1 }
		]);
	});

	it('knows what to read again, and forgets what has gone', () => {
		const index = build();
		expect(index.needs(A, 'v1')).toBe(false);
		expect(index.needs(A, 'v2')).toBe(true);
		expect(index.needs(A, null)).toBe(false);
		expect(index.retain(new Set([A]))).toBe(true);
		expect([...index.entries.keys()]).toEqual([A]);
	});

	it('round-trips through bytes, and reads nothing from bytes that are not an index', () => {
		const index = build();
		const back = NotesIndex.decode(index.encode());
		expect([...back.entries]).toEqual([...index.entries]);
		expect(
			NotesIndex.decode(new TextEncoder().encode('{"v":1,"entries":[["x",{"version":1}]]}')).entries
				.size
		).toBe(0);
		expect(NotesIndex.decode(new Uint8Array([1, 2, 3])).entries.size).toBe(0);
	});
});
