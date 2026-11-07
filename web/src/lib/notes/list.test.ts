import { describe, expect, it } from 'vitest';
import type { DriveNode } from '$lib/drive/tree';
import { arrange, inSection, matchesChip, sectionCounts, type NoteItem } from './list';
import { analyze } from './parse';

const NOW = new Date(2026, 10, 7, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;

function item(
	id: string,
	over: Partial<NoteItem> = {},
	text = '',
	updatedAt = NOW - 10 * DAY
): NoteItem {
	return {
		id,
		node: { id, updatedAt, created: updatedAt } as DriveNode,
		title: id,
		notebook: null,
		meta: { pinned: false, archived: false, reminder: null, tags: [], daily: null },
		entry: { ...analyze(text), version: 'v' },
		tags: [],
		attachments: 0,
		shared: false,
		...over
	};
}

describe('the notes list', () => {
	const items = [
		item('a', {}, '- [ ] one\n- [x] two\n- [ ] three @2026-11-06\n'),
		item('b', {
			meta: { pinned: true, archived: false, reminder: NOW + 1000, tags: [], daily: null }
		}),
		item('c', { meta: { pinned: false, archived: true, reminder: null, tags: [], daily: null } }),
		item('d', { shared: true }),
		item('e', {}, '', NOW - 1000)
	];

	it('puts each note in its sections', () => {
		expect(items.filter((i) => inSection(i, 'all', NOW)).map((i) => i.id)).toEqual(['a', 'b', 'e']);
		expect(items.filter((i) => inSection(i, 'today', NOW)).map((i) => i.id)).toEqual([
			'a',
			'b',
			'e'
		]);
		expect(items.filter((i) => inSection(i, 'archive', NOW)).map((i) => i.id)).toEqual(['c']);
		expect(items.filter((i) => inSection(i, 'shared', NOW)).map((i) => i.id)).toEqual(['d']);
	});

	it('counts open tasks, and notes elsewhere', () => {
		expect(sectionCounts(items, 4, NOW)).toEqual({
			all: 3,
			today: 3,
			pinned: 1,
			tasks: 2,
			shared: 1,
			archive: 1,
			trash: 4
		});
	});

	it('filters by chips, tag and words, pinned first', () => {
		expect(matchesChip(items[0], 'tasks')).toBe(true);
		expect(matchesChip(items[1], 'reminders')).toBe(true);
		const q = {
			section: 'all' as const,
			notebook: null,
			tag: null,
			chips: [],
			matched: null,
			sort: 'edited' as const,
			now: NOW
		};
		expect(arrange(items, q).map((i) => i.id)).toEqual(['b', 'e', 'a']);
		expect(arrange(items, { ...q, matched: new Set(['a']) }).map((i) => i.id)).toEqual(['a']);
		expect(arrange(items, { ...q, sort: 'title' }).map((i) => i.id)).toEqual(['b', 'a', 'e']);
	});
});
