import { describe, expect, it } from 'vitest';
import { backlinks, NoteRefs, NotesIndex, tagCounts, tagsOf, unlinkedMentions } from './index';
import { analyze, MAX_FACTS, nodeHref } from './parse';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const notes = [
	{ id: A, title: 'Sync engine' },
	{ id: B, title: 'Q1 planning' },
	{ id: C, title: 'Mon, Nov 2' }
];
const refs = new NoteRefs(notes);

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
		expect(backlinks(index, A, refs)).toEqual([
			{ from: B, context: 'Three bets, starting with the sync rewrite.' }
		]);
		expect(backlinks(index, B, refs).map((b) => b.from)).toEqual([C]);
		expect(refs.resolve({ kind: 'title', target: 'q1 PLANNING', context: '' })).toBe(B);
		// A note no longer there links nothing.
		expect(backlinks(index, A, new NoteRefs(notes.filter((n) => n.id !== B)))).toEqual([]);
	});

	it('finds unlinked mentions, and not where a link is', () => {
		const index = build();
		expect(unlinkedMentions(index, notes[0], refs)).toEqual([
			{ from: C, context: 'The sync engine beta is stable. See [[Q1 planning]]. #journal' }
		]);
		expect(unlinkedMentions(index, notes[1], refs)).toEqual([]);
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

	it('round-trips an entry through bytes, and reads nothing from bytes that are not one', () => {
		const index = build();
		const entry = index.get(B)!;
		expect(NotesIndex.decodeEntry(NotesIndex.encodeEntry(entry))).toEqual(entry);
		const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
		expect(NotesIndex.decodeEntry(bytes({ v: 2, entry: { version: 1 } }))).toBeNull();
		expect(NotesIndex.decodeEntry(bytes({ v: 1, entry }))).toBeNull();
		expect(NotesIndex.decodeEntry(new Uint8Array([1, 2, 3]))).toBeNull();
	});

	it('hands over only what changed since it was last stored', () => {
		const index = build();
		expect(index.takeChanges().put.map(([id]) => id)).toEqual([A, B, C]);
		expect(index.takeChanges()).toEqual({ put: [], drop: [] });
		index.set(B, 'v2', analyze('Moved on.\n'));
		index.retain(new Set([A, B]));
		const { put, drop } = index.takeChanges();
		expect(put.map(([id, e]) => [id, e.version])).toEqual([[B, 'v2']]);
		expect(drop).toEqual([C]);
	});
});

describe('a note made to slow the index down', () => {
	const hostile = [
		`[[Note 5]] ${Array.from({ length: 100_000 }, (_, i) => `[[t${i}]]`).join(' ')}`,
		'[[x]] '.repeat(100_000),
		Array.from({ length: 5000 }, (_, i) => `#tag${i}x`).join(' '),
		Array.from({ length: 3000 }, (_, i) => `- [ ] task ${i}`).join('\n')
	].join('\n\n');
	const others = Array.from({ length: 2000 }, (_, i) => ({
		id: i.toString(16).padStart(32, '0'),
		title: `Note ${i}`
	}));
	const H = 'f'.repeat(32);

	it('is read with its facts capped, and answered quickly', () => {
		const started = performance.now();
		const facts = analyze(hostile);
		expect(facts.links).toHaveLength(MAX_FACTS);
		expect(facts.links[1]).toMatchObject({ kind: 'title', target: 't0' });
		expect(facts.tags).toHaveLength(MAX_FACTS);
		expect(facts.tasks).toHaveLength(MAX_FACTS);
		const index = new NotesIndex();
		index.set(H, 'v1', facts);
		for (const n of others)
			index.set(n.id, 'v1', analyze(`About [[Note ${Number.parseInt(n.id, 16) + 1}]].\n`));
		const refs = new NoteRefs([...others, { id: H, title: 'Hostile' }]);
		// The links panel asks again on each change of the tree or the index.
		for (let i = 0; i < 20; i++) {
			backlinks(index, others[i].id, refs);
			unlinkedMentions(index, others[i], refs);
		}
		expect(backlinks(index, others[5].id, refs).map((b) => b.from)).toEqual([H, others[4].id]);
		expect(performance.now() - started).toBeLessThan(4000);
	}, 30_000);

	it('works the links out once per change of the index', () => {
		const index = build();
		const first = backlinks(index, A, refs);
		expect(backlinks(index, A, refs)).toBe(first);
		index.set(C, 'v2', analyze(`Now [[Sync engine]] too.\n`));
		expect(backlinks(index, A, refs).map((b) => b.from)).toEqual([B, C]);
	});

	it('caps what an index stored before the caps holds', () => {
		const entry = { ...analyze('x\n'), version: 'v1' };
		const links = Array.from({ length: 5000 }, (_, i) => ({
			kind: 'title',
			target: `t${i}`,
			context: ''
		}));
		const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, entry: { ...entry, links } }));
		expect(NotesIndex.decodeEntry(bytes)?.links).toHaveLength(MAX_FACTS);
	});
});
