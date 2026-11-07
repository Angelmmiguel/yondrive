/**
 * What a sealed metadata blob holds, in the same shape in both modes. The bytes
 * come from a device, maybe an older or newer one, so nothing here trusts them:
 * what is missing or of the wrong type reads as empty, and what is not known is
 * kept, so that rewriting metadata does not lose it.
 */
export interface NodeMetadata {
	name: string;
	/** A media type, as the browser reported it or as the extension suggests. */
	type: string;
	/** Unix milliseconds. */
	created: number;
	modified: number;
	/** Plaintext bytes. */
	size: number;
	/** Ids of tags, from the list on the root. */
	tags: string[];
	favorite: boolean;
}

export const TAG_TONES = ['blue', 'green', 'orange', 'rose', 'grey'] as const;
export type TagTone = (typeof TAG_TONES)[number];

export interface TagDefinition {
	id: string;
	name: string;
	tone: TagTone;
}

/** What the root holds: the list of the user's tags. */
export interface RootMetadata {
	tags: TagDefinition[];
}

export type RawMetadata = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** The object inside a value, or an empty one. */
export function rawMetadata(value: unknown): RawMetadata {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? { ...(value as RawMetadata) }
		: {};
}

export function parseMetadata(value: unknown): NodeMetadata {
	const raw = rawMetadata(value);
	return {
		name: text(raw.name),
		type: text(raw.type),
		created: count(raw.created),
		modified: count(raw.modified),
		size: count(raw.size),
		tags: Array.isArray(raw.tags)
			? raw.tags.filter((tag): tag is string => typeof tag === 'string')
			: [],
		favorite: raw.favorite === true
	};
}

export function parseRootMetadata(value: unknown): RootMetadata {
	const raw = rawMetadata(value);
	const tags: TagDefinition[] = [];
	for (const item of Array.isArray(raw.tags) ? raw.tags : []) {
		const tag = rawMetadata(item);
		if (typeof tag.id !== 'string' || typeof tag.name !== 'string' || tag.name === '') continue;
		const tone = TAG_TONES.find((t) => t === tag.tone) ?? 'grey';
		tags.push({ id: tag.id, name: tag.name, tone });
	}
	return { tags };
}

/** A tone for the next tag, going round the palette. */
export function nextTone(existing: readonly TagDefinition[]): TagTone {
	return TAG_TONES[existing.length % TAG_TONES.length];
}
