/**
 * What the notes list shows: sections, filters, counts and order, over items the
 * state builds from the tree and the index. Pure, so the rules are tested alone.
 */
import type { DriveNode } from '$lib/drive/tree';
import type { IndexEntry } from './index';
import { dayKey, sameDay, type NoteMeta } from './model';

export type Section = 'all' | 'today' | 'pinned' | 'tasks' | 'shared' | 'archive' | 'trash';
export type Chip = 'tasks' | 'reminders' | 'linked' | 'attachments';
export type NoteSort = 'edited' | 'created' | 'title';

export interface NoteItem {
	id: string;
	node: DriveNode;
	title: string;
	/** The notebook it is in; null at the top, or for a note shared on its own. */
	notebook: DriveNode | null;
	meta: NoteMeta;
	entry: IndexEntry | undefined;
	/** Given and written tags together. */
	tags: string[];
	/** Pictures and files kept for it. */
	attachments: number;
	shared: boolean;
}

export const openTasks = (item: NoteItem) => item.entry?.tasks.filter((t) => !t.done).length ?? 0;

/** Whether a note belongs to a section; the trash and shares are lists of their own. */
export function inSection(item: NoteItem, section: Section, now: number): boolean {
	switch (section) {
		case 'all':
			return !item.meta.archived && !item.shared;
		case 'archive':
			return item.meta.archived && !item.shared;
		case 'pinned':
			return item.meta.pinned && !item.meta.archived && !item.shared;
		case 'tasks':
			return openTasks(item) > 0 && !item.meta.archived;
		case 'today': {
			if (item.meta.archived || item.shared) return false;
			const key = dayKey(new Date(now));
			return (
				sameDay(item.node.updatedAt, now) ||
				(item.meta.reminder !== null && sameDay(item.meta.reminder, now)) ||
				item.meta.daily === key ||
				(item.entry?.tasks.some((t) => !t.done && t.due !== null && t.due <= key) ?? false)
			);
		}
		case 'shared':
			return item.shared;
		case 'trash':
			return false;
	}
}

export function matchesChip(item: NoteItem, chip: Chip): boolean {
	switch (chip) {
		case 'tasks':
			return (item.entry?.tasks.length ?? 0) > 0;
		case 'reminders':
			return item.meta.reminder !== null;
		case 'linked':
			return (item.entry?.links.length ?? 0) > 0;
		case 'attachments':
			return item.attachments > 0 || (item.entry?.images.length ?? 0) > 0;
	}
}

export function sortItems(items: readonly NoteItem[], sort: NoteSort): NoteItem[] {
	const out = [...items];
	if (sort === 'title') out.sort((a, b) => a.title.localeCompare(b.title));
	else if (sort === 'created') out.sort((a, b) => b.node.created - a.node.created);
	else out.sort((a, b) => b.node.updatedAt - a.node.updatedAt);
	return out;
}

export interface ListQuery {
	section: Section;
	notebook: string | null;
	tag: string | null;
	chips: readonly Chip[];
	/** Notes the words matched, or null when nothing is typed. */
	matched: ReadonlySet<string> | null;
	sort: NoteSort;
	now: number;
}

/** The notes on screen, pinned first. */
export function arrange(items: readonly NoteItem[], q: ListQuery): NoteItem[] {
	const shown = items.filter(
		(item) =>
			(q.notebook === null
				? inSection(item, q.section, q.now)
				: item.notebook?.id === q.notebook && !item.meta.archived) &&
			(q.tag === null || item.tags.includes(q.tag)) &&
			q.chips.every((chip) => matchesChip(item, chip)) &&
			(q.matched === null || q.matched.has(item.id))
	);
	const sorted = sortItems(shown, q.sort);
	return [...sorted.filter((i) => i.meta.pinned), ...sorted.filter((i) => !i.meta.pinned)];
}

/** The number beside each section. Tasks counts open tasks, the others notes. */
export function sectionCounts(
	items: readonly NoteItem[],
	trashed: number,
	now: number
): Record<Section, number> {
	const count = (s: Section) => items.filter((i) => inSection(i, s, now)).length;
	return {
		all: count('all'),
		today: count('today'),
		pinned: count('pinned'),
		tasks: items.filter((i) => !i.meta.archived).reduce((n, i) => n + openTasks(i), 0),
		shared: count('shared'),
		archive: count('archive'),
		trash: trashed
	};
}
