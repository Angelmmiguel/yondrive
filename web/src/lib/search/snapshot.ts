/**
 * What the index should hold, from the tree: every node this user can reach now.
 * The tree is the authority, so anything out of the trash, under a top that is not a
 * verified share, or under a parent that has gone falls out here.
 */
import type { TagDefinition } from '$lib/drive/metadata';
import type { DriveNode } from '$lib/drive/tree';
import { extractorFor } from './extract';
import type { IndexDoc } from './types';

export interface TreeView {
	nodes: ReadonlyMap<string, DriveNode>;
	rootId: string | null;
	tags: readonly TagDefinition[];
}

/**
 * A node as the index holds it. Tags are the owner's alone, so a share's are nobody's here.
 * Its comments are words of its text, so a change to them is a new version of that text.
 */
export function docOf(node: DriveNode, tags: readonly TagDefinition[], ownerId: string): IndexDoc {
	const shared = node.ownerId !== ownerId;
	const kept = shared ? [] : tags.filter((tag) => node.tags.includes(tag.id));
	return {
		id: node.id,
		parent: node.parentId,
		name: node.name,
		kind: node.kind,
		type: node.type,
		modified: node.modified,
		size: node.size,
		shared,
		tagIds: kept.map((tag) => tag.id),
		tagNames: kept.map((tag) => tag.name),
		version:
			node.currentVersion === null || node.commentSeq === 0
				? node.currentVersion
				: `${node.currentVersion}+c${node.commentSeq}`,
		text: node.kind === 'file' && (extractorFor(node) !== null || node.commentSeq > 0)
	};
}

/** Each node reachable from the root or a trusted share, without those tops' own root. */
export function reachableDocs(
	tree: TreeView,
	trustedTops: readonly string[],
	ownerId: string
): IndexDoc[] {
	const tops = new Set(trustedTops);
	const reachable = new Map<string, boolean>();

	const live = (node: DriveNode | undefined): boolean => {
		if (node === undefined) return false;
		const known = reachable.get(node.id);
		if (known !== undefined) return known;
		reachable.set(node.id, false);
		let ok: boolean;
		if (node.trashedAt !== null || node.purgedAt !== null) ok = false;
		else if (node.parentId === null) ok = node.id === tree.rootId || tops.has(node.id);
		else ok = live(tree.nodes.get(node.parentId));
		reachable.set(node.id, ok);
		return ok;
	};

	const docs: IndexDoc[] = [];
	for (const node of tree.nodes.values()) {
		if (node.id === tree.rootId || !node.readable) continue;
		if (node.kind === 'file' && node.currentVersion === null) continue;
		if (live(node)) docs.push(docOf(node, tree.tags, ownerId));
	}
	return docs;
}
