/** What search knows about a node, and what it is asked. Plain data, for a worker. */
import type { KindFilter } from '$lib/drive/sort';

/** One node as the index holds it: enough to find it and to draw it with no tree at hand. */
export interface IndexDoc {
	id: string;
	/** Null at the top of what this user can reach. A parent that is no doc ends a path. */
	parent: string | null;
	name: string;
	kind: 'file' | 'folder';
	type: string;
	modified: number;
	size: number;
	/** Someone else owns it. */
	shared: boolean;
	tagIds: string[];
	tagNames: string[];
	version: string | null;
	/** Whether its contents are worth extracting text from. */
	text: boolean;
}

export type DateFilter = 'any' | 'day' | 'week' | 'month' | 'year';
export type SharedFilter = 'any' | 'with-me' | 'mine';

export interface SearchQuery {
	text: string;
	type?: KindFilter;
	tag?: string | null;
	date?: DateFilter;
	shared?: SharedFilter;
	limit?: number;
	/** The clock of the date filter. */
	now?: number;
}

export interface SearchHit {
	id: string;
	parent: string | null;
	name: string;
	kind: 'file' | 'folder';
	type: string;
	modified: number;
	size: number;
	shared: boolean;
	tagIds: string[];
	/** The names of the folders above it, from the top down. */
	path: string[];
	/** What the words matched: the best of the fields. */
	matched: 'name' | 'tag' | 'text' | 'none';
}

export interface SearchResults {
	hits: SearchHit[];
	/** How many matched, of which `hits` are the best. */
	total: number;
}

/** What is known to be behind: a segment that did not open, a file with no text yet. */
export interface ReconcileReport {
	/** Files whose text is missing or of an older version. */
	stale: string[];
}
