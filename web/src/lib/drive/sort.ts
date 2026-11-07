/** Sorting happens here in both modes, since the server cannot read a name. */
export type SortKey = 'name' | 'modified' | 'size';
export type SortDirection = 'asc' | 'desc';

export interface Sortable {
	kind: 'file' | 'folder';
	name: string;
	modified: number;
	size: number;
	id: string;
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * A sorted copy: folders first, then by the key, then by name, and by id last so
 * that the order is the same on every device and every render.
 */
export function sortNodes<T extends Sortable>(
	nodes: readonly T[],
	key: SortKey,
	direction: SortDirection = key === 'name' ? 'asc' : 'desc'
): T[] {
	const sign = direction === 'asc' ? 1 : -1;
	return [...nodes].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		const by =
			key === 'name'
				? names.compare(a.name, b.name)
				: key === 'size'
					? a.size - b.size
					: a.modified - b.modified;
		return sign * by || names.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	});
}

export type KindFilter = 'all' | 'folders' | 'documents' | 'images' | 'video' | 'other';
