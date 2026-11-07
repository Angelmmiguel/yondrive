import { describe, expect, it } from 'vitest';
import { sealerFor } from '$lib/crypto/sealer';
import { SUITES } from '$lib/testing/drive';
import { createEngine } from './engine';
import { MAX_TEXT_WORDS, SearchIndex } from './index';
import { BadSegmentError, decodeSegment, encodeSegment, planCompaction } from './segment';
import { tokenize, uniqueTokens } from './tokenize';
import type { IndexDoc } from './types';

const doc = (id: string, name: string, extra: Partial<IndexDoc> = {}): IndexDoc => ({
	id,
	parent: null,
	name,
	kind: 'file',
	type: 'text/plain',
	modified: 1000,
	size: 10,
	shared: false,
	tagIds: [],
	tagNames: [],
	version: 'v1',
	text: true,
	...extra
});

const names = (index: SearchIndex, text: string, extra = {}) =>
	index.search({ text, ...extra }).hits.map((hit) => hit.name);

describe('tokenize', () => {
	it('splits on anything but letters and digits, in lower case', () => {
		expect(tokenize('Annual_Report-2026 (final).PDF')).toEqual([
			'annual',
			'report',
			'2026',
			'final',
			'pdf'
		]);
	});

	it('folds accents and works in any script', () => {
		expect(tokenize('Canción ÉTÉ')).toEqual(['cancion', 'ete']);
		expect(tokenize('Привет МИР')).toEqual(['привет', 'мир']);
	});

	it('takes each character of a script without spaces as a word', () => {
		expect(tokenize('文件abc')).toEqual(['文', '件', 'abc']);
	});

	it('cuts a word that goes on for ever, and keeps repeats out of the unique list', () => {
		expect(tokenize('a'.repeat(100))[0]).toHaveLength(64);
		expect(uniqueTokens('one two one')).toEqual(['one', 'two']);
		expect(uniqueTokens('one two three', 2)).toEqual(['one', 'two']);
	});
});

describe('SearchIndex', () => {
	it('matches words as prefixes, and needs all of them', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'Budget 2026.xlsx'));
		index.upsert(doc('b', 'Budget notes.md'));
		expect(names(index, 'bud').sort()).toEqual(['Budget 2026.xlsx', 'Budget notes.md']);
		expect(names(index, 'BUDGET not')).toEqual(['Budget notes.md']);
		expect(names(index, 'udget')).toEqual([]);
		expect(names(index, '')).toEqual([]);
	});

	it('ranks a name over a tag over text, and an exact word over a prefix', () => {
		const index = new SearchIndex();
		index.upsert(doc('text', 'one'));
		index.setText('text', 'v1', 'plans');
		index.upsert(doc('tag', 'two', { tagIds: ['t'], tagNames: ['plans'] }));
		index.upsert(doc('name', 'plans'));
		index.upsert(doc('prefix', 'plansfor'));
		const { hits } = index.search({ text: 'plans' });
		expect(hits.map((hit) => hit.id)).toEqual(['name', 'prefix', 'tag', 'text']);
		expect(hits.map((hit) => hit.matched)).toEqual(['name', 'name', 'tag', 'text']);
	});

	it('finds text, and what replaced it, and not what it replaced', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'note.txt'));
		index.setText('a', 'v1', 'the walrus sang');
		expect(names(index, 'walrus')).toEqual(['note.txt']);
		index.setText('a', 'v2', 'the heron sang');
		expect(names(index, 'walrus')).toEqual([]);
		expect(names(index, 'heron')).toEqual(['note.txt']);
	});

	it('keeps text through a rename, and finds the new name only', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'old.txt'));
		index.setText('a', 'v1', 'walrus');
		index.upsert(doc('a', 'new.txt'));
		expect(names(index, 'old')).toEqual([]);
		expect(names(index, 'new')).toEqual(['new.txt']);
		expect(names(index, 'walrus')).toEqual(['new.txt']);
	});

	it('forgets text of a file no longer worth reading', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'a.txt'));
		index.setText('a', 'v1', 'walrus');
		index.upsert(doc('a', 'a.txt', { text: false }));
		expect(names(index, 'walrus')).toEqual([]);
	});

	it('says which text is stale', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'a.txt'));
		expect(index.staleText('a')).toBe(true);
		index.setText('a', 'v1', 'x');
		expect(index.staleText('a')).toBe(false);
		index.upsert(doc('a', 'a.txt', { version: 'v2' }));
		expect(index.staleText('a')).toBe(true);
	});

	it('caps the words of one file', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'big'));
		const words = Array.from({ length: MAX_TEXT_WORDS + 5 }, (_, i) => `w${i}`).join(' ');
		index.setText('a', 'v1', words);
		expect(names(index, 'w0')).toEqual(['big']);
		expect(names(index, `w${MAX_TEXT_WORDS + 1}`)).toEqual([]);
	});

	it('drops what is removed', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'gone.txt'));
		index.setText('a', 'v1', 'walrus');
		index.remove('a');
		expect(names(index, 'gone')).toEqual([]);
		expect(names(index, 'walrus')).toEqual([]);
		expect(index.size).toBe(0);
	});

	it('filters by type, tag, date and sharing, with or without words', () => {
		const index = new SearchIndex();
		const now = 400 * 24 * 3600 * 1000;
		index.upsert(doc('d', 'plan.md', { modified: now - 1000 }));
		index.upsert(
			doc('p', 'plan.png', { type: 'image/png', modified: now - 40 * 24 * 3600 * 1000 })
		);
		index.upsert(doc('f', 'plan', { kind: 'folder', version: null, text: false }));
		index.upsert(doc('t', 'plan.txt', { tagIds: ['t1'], tagNames: ['work'] }));
		index.upsert(doc('s', 'plan.mov', { type: 'video/quicktime', shared: true }));

		expect(names(index, 'plan', { type: 'images' })).toEqual(['plan.png']);
		expect(names(index, 'plan', { type: 'folders' })).toEqual(['plan']);
		expect(names(index, 'plan', { type: 'video' })).toEqual(['plan.mov']);
		expect(names(index, 'plan', { tag: 't1' })).toEqual(['plan.txt']);
		expect(names(index, 'plan', { date: 'week', now })).toEqual(['plan.md']);
		expect(names(index, 'plan', { date: 'year', now }).sort()).toEqual(['plan.md', 'plan.png']);
		expect(names(index, 'plan', { shared: 'with-me' })).toEqual(['plan.mov']);
		expect(names(index, 'plan', { shared: 'mine' })).not.toContain('plan.mov');
		expect(names(index, '', { tag: 't1' })).toEqual(['plan.txt']);
	});

	it('gives the path through what it holds, up to what it does not', () => {
		const index = new SearchIndex();
		index.upsert(doc('f1', 'Work', { kind: 'folder', parent: 'root' }));
		index.upsert(doc('f2', 'Q3', { kind: 'folder', parent: 'f1' }));
		index.upsert(doc('a', 'sheet.csv', { parent: 'f2' }));
		expect(index.search({ text: 'sheet' }).hits[0].path).toEqual(['Work', 'Q3']);
		index.upsert(doc('f1', 'Job', { kind: 'folder', parent: 'root' }));
		expect(index.search({ text: 'sheet' }).hits[0].path).toEqual(['Job', 'Q3']);
	});

	it('survives a parent loop in what it was told', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'a', { parent: 'b' }));
		index.upsert(doc('b', 'b', { parent: 'a' }));
		expect(index.search({ text: 'a' }).hits[0].path).toEqual(['b']);
	});

	it('has nothing to flush when nothing is new', () => {
		const index = new SearchIndex();
		expect(index.flush()).toBeNull();
		index.upsert(doc('a', 'a'));
		expect(index.dirty).toBe(true);
		expect(index.flush()).not.toBeNull();
		expect(index.dirty).toBe(false);
		expect(index.flush()).toBeNull();
	});
});

/** What a fresh device would make of these segments. */
function reload(written: { body: ReturnType<typeof decodeSegment> }[]): SearchIndex {
	const fresh = new SearchIndex();
	const ordered = [...written].sort((a, b) => a.body.seq - b.body.seq);
	ordered.forEach(({ body }, i) => fresh.load(`s${i}`, body, 100));
	return fresh;
}

describe('segments', () => {
	it('round trips names, tags, text and paths through a fresh index', () => {
		const index = new SearchIndex();
		index.upsert(doc('f', 'Folder', { kind: 'folder', version: null, text: false }));
		index.upsert(doc('a', 'a.txt', { parent: 'f', tagIds: ['t'], tagNames: ['urgent'] }));
		index.setText('a', 'v1', 'walrus');
		const written = index.flush()!.add;
		const fresh = reload(written);
		expect(names(fresh, 'walrus')).toEqual(['a.txt']);
		expect(names(fresh, 'urgent')).toEqual(['a.txt']);
		expect(fresh.search({ text: 'a' }).hits[0].path).toEqual(['Folder']);
		expect(fresh.staleText('a')).toBe(false);
		expect(fresh.dirty).toBe(false);
	});

	it('lets a later segment win, and removals hide what is older', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'first.txt'));
		index.setText('a', 'v1', 'walrus');
		index.upsert(doc('b', 'b.txt'));
		const one = index.flush()!.add;
		index.upsert(doc('a', 'second.txt'));
		index.remove('b');
		const two = index.flush()!.add;
		const fresh = reload([...two, ...one]);
		expect(names(fresh, 'first')).toEqual([]);
		expect(names(fresh, 'second')).toEqual(['second.txt']);
		expect(names(fresh, 'walrus')).toEqual(['second.txt']);
		expect(names(fresh, 'b')).toEqual([]);
	});

	it('merges the newest segments into one, without losing or reviving anything', () => {
		const index = new SearchIndex();
		const stored: { id: string; body: ReturnType<typeof decodeSegment> }[] = [];
		for (let i = 0; i < 6; i++) {
			index.upsert(doc(`d${i}`, `file${i}.txt`));
			index.setText(`d${i}`, 'v1', `word${i}`);
			if (i === 3) index.remove('d1');
			stored.push(...index.flush()!.add);
		}
		const write = index.compact(3)!;
		expect(write.remove.length).toBeGreaterThanOrEqual(2);
		expect(index.segmentCount).toBeLessThan(6);
		const kept = stored.filter((one) => !write.remove.includes(one.id));
		const fresh = reload([...kept, ...write.add]);
		expect(names(fresh, 'file0')).toEqual(['file0.txt']);
		expect(names(fresh, 'file1')).toEqual([]);
		expect(names(fresh, 'word5')).toEqual(['file5.txt']);
		expect(fresh.size).toBe(5);
	});

	it('never merges past a big segment, so that nothing overtakes a newer copy', () => {
		const meta = (id: string, seq: number, size: number) => ({ id, seq, size, gone: [] });
		const big = 5 * 1024 * 1024;
		expect(planCompaction([meta('a', 1, 1), meta('b', 2, 1)], 2)).toEqual([]);
		const run = planCompaction(
			[meta('a', 1, 10), meta('b', 2, big), meta('c', 3, 10), meta('d', 4, 10)],
			3
		);
		expect(run.map((one) => one.id)).toEqual(['c', 'd']);
		expect(planCompaction([meta('a', 1, big), meta('b', 2, big), meta('c', 3, 1)], 2)).toEqual([]);
	});

	it('marks a write as still in memory when it could not be stored', () => {
		const index = new SearchIndex();
		index.upsert(doc('a', 'a'));
		index.remove('a');
		index.upsert(doc('b', 'b'));
		const write = index.flush()!;
		expect(index.dirty).toBe(false);
		index.abort(write.token);
		expect(index.dirty).toBe(true);
		expect(index.segmentCount).toBe(0);
		expect(index.flush()!.add[0].body.gone).toEqual(['a']);
	});

	it('refuses bytes of the wrong shape', () => {
		const good = encodeSegment({ v: 1, seq: 1, docs: [], gone: [], terms: {} });
		expect(decodeSegment(good).seq).toBe(1);
		for (const bad of [
			'nope',
			'[]',
			'{"v":2}',
			'{"v":1,"seq":1,"docs":[[1]],"gone":[],"terms":{}}'
		]) {
			expect(() => decodeSegment(new TextEncoder().encode(bad))).toThrow(BadSegmentError);
		}
	});
});

describe.each(SUITES)('the engine in mode %s', (_, suite) => {
	const key = () => sealerFor(suite).indexKey(new Uint8Array(32).fill(7));

	it('seals what it stores and opens it again', async () => {
		const engine = createEngine(suite, key());
		await engine.upsert([doc('a', 'walrus.txt')]);
		const write = (await engine.flush())!;
		const fresh = createEngine(suite, key());
		const { bad } = await fresh.load(write.add);
		expect(bad).toEqual([]);
		expect((await fresh.search({ text: 'walrus' })).total).toBe(1);
		const plain = new TextDecoder().decode(write.add[0].bytes);
		expect(plain.includes('walrus')).toBe(!sealerFor(suite).encrypted);
	});

	it('reports what does not open, and leaves the rest', async () => {
		const engine = createEngine(suite, key());
		await engine.upsert([doc('a', 'walrus.txt')]);
		const write = (await engine.flush())!;
		const fresh = createEngine(suite, key());
		const { bad } = await fresh.load([
			...write.add,
			{ id: 'b'.repeat(32), bytes: new Uint8Array(40).fill(1) }
		]);
		expect(bad).toEqual(['b'.repeat(32)]);
		expect((await fresh.search({ text: 'walrus' })).total).toBe(1);
	});

	it('reconciles: what the tree no longer has goes, and stale text is named', async () => {
		const engine = createEngine(suite, key());
		await engine.upsert([doc('a', 'a.txt'), doc('b', 'b.txt')]);
		await engine.setText('a', 'v1', 'walrus');
		await engine.beginReconcile();
		const { stale } = await engine.reconcile([doc('a', 'a.txt'), doc('c', 'c.txt')]);
		const { removed, size } = await engine.endReconcile();
		expect(stale).toEqual(['c']);
		expect(removed).toBe(1);
		expect(size).toBe(2);
	});
});

describe('at 100,000 entries', () => {
	it('stays quick to build, ask, store and load', () => {
		const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'mango', 'march', 'maple'];
		const index = new SearchIndex();
		const built = performance.now();
		for (let i = 0; i < 100_000; i++) {
			index.upsert(
				doc(i.toString(16).padStart(32, '0'), `${words[i % words.length]} report ${i}.txt`, {
					parent: i % 500 === 0 ? null : (i - (i % 500)).toString(16).padStart(32, '0'),
					tagIds: i % 10 === 0 ? ['t'] : [],
					tagNames: i % 10 === 0 ? ['urgent'] : []
				})
			);
		}
		const buildMs = performance.now() - built;

		const time = (query: Parameters<SearchIndex['search']>[0]) => {
			const started = performance.now();
			const { total } = index.search(query);
			return { ms: performance.now() - started, total };
		};
		// The first asks for the sorted vocabulary, and what comes after does not.
		time({ text: 'alpha' });
		const narrow = time({ text: 'charlie 1234' });
		const wide = time({ text: 'report' });
		const prefix = time({ text: 'm' });
		const filtered = time({ text: '', tag: 't' });

		expect(narrow.total).toBeGreaterThan(0);
		expect(wide.total).toBe(100_000);
		expect(prefix.total).toBeGreaterThan(30_000);
		expect(filtered.total).toBe(10_000);

		const stored = performance.now();
		const write = index.flush()!;
		const bytes = write.add.map(({ body }) => encodeSegment(body));
		const storeMs = performance.now() - stored;
		const loaded = performance.now();
		const fresh = new SearchIndex();
		write.add.forEach(({ id }, i) => fresh.load(id, decodeSegment(bytes[i]), bytes[i].length));
		const loadMs = performance.now() - loaded;

		expect(fresh.size).toBe(100_000);
		expect(fresh.search({ text: 'charlie 1234' }).total).toBe(narrow.total);
		for (const part of bytes) expect(part.length).toBeLessThan(16 * 1024 * 1024);

		// Guards against something going quadratic, loose enough for a busy machine.
		expect(buildMs).toBeLessThan(10_000);
		expect(narrow.ms).toBeLessThan(250);
		expect(wide.ms).toBeLessThan(1_000);
		expect(prefix.ms).toBeLessThan(1_000);
		expect(filtered.ms).toBeLessThan(250);
		expect(storeMs).toBeLessThan(10_000);
		expect(loadMs).toBeLessThan(10_000);
	}, 60_000);
});
