/**
 * The notes as the list draws them, built from the tree and the index; and the
 * part of the tree that Drive's own lists leave to Notes. Plain functions, so
 * the state module stays thin.
 */
import { rawMetadata } from '$lib/drive/metadata';
import type { DriveNode, DriveTree } from '$lib/drive/tree';
import { tagsOf, type NotesIndex } from './index';
import type { NoteItem } from './list';
import { dayKey, isNotesRoot, parseNoteMeta, titleOf } from './model';

export interface Placed {
	node: DriveNode;
	notebook: DriveNode | null;
}

/** Items for this user's notes and those shared with them, with their attachments counted. */
export function buildItems(
	tree: Pick<DriveTree, 'childrenOf'>,
	folders: readonly string[],
	own: readonly Placed[],
	shared: readonly Placed[],
	index: NotesIndex | null
): NoteItem[] {
	const attachments = new Map<string, number>();
	for (const folder of folders) {
		for (const n of tree.childrenOf(folder)) {
			const owner = rawMetadata(n.raw.attachment).note;
			if (typeof owner === 'string') attachments.set(owner, (attachments.get(owner) ?? 0) + 1);
		}
	}
	const make = ({ node, notebook }: Placed, isShared: boolean): NoteItem => {
		const meta = parseNoteMeta(node.raw);
		const entry = index?.get(node.id);
		return {
			id: node.id,
			node,
			title: titleOf(node.name),
			notebook,
			meta,
			entry,
			tags: tagsOf(entry, meta.tags),
			attachments: attachments.get(node.id) ?? 0,
			shared: isShared
		};
	};
	return [...own.map((p) => make(p, false)), ...shared.map((p) => make(p, true))];
}

/** The notes the words found: titles that hold them, and what the search index answered. */
export function matchedIds(
	items: readonly NoteItem[],
	text: string,
	hits: readonly string[]
): Set<string> {
	const words = text.trim().toLowerCase();
	const out = new Set(items.filter((i) => i.title.toLowerCase().includes(words)).map((i) => i.id));
	const ids = new Set(items.map((i) => i.id));
	for (const id of hits) if (ids.has(id)) out.add(id);
	return out;
}

/** The folder of notes and everything under it, which Drive's own lists leave out. */
export function notesSubtree(tree: Pick<DriveTree, 'rootId' | 'childrenOf'>): Set<string> {
	const hidden = new Set<string>();
	const walk = (id: string) => {
		hidden.add(id);
		for (const child of tree.childrenOf(id)) walk(child.id);
	};
	if (tree.rootId !== null)
		for (const n of tree.childrenOf(tree.rootId)) if (isNotesRoot(n)) walk(n.id);
	return hidden;
}

/** The name of an export of every note, by the day it was made. */
export const exportName = (now: number) => `Notes ${dayKey(new Date(now))}.zip`;
