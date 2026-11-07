/**
 * Writing a sequence of blocks back into the source they came from. Each block
 * that still carries the `ref` of a source item, in order, is kept in that item's
 * place: copied verbatim when it did not change, regenerated when it did. Anything
 * between items is copied as it was. Blocks with no usable `ref` are new, and go
 * after the item before them. A `ref` seen twice (a split paragraph) or out of
 * order (a moved one) counts as new from the second time on.
 */

export interface SourceItem {
	ref: number;
	start: number;
	end: number;
}

export interface Region {
	start: number;
	end: number;
	/** Where new blocks before the first item go: after any prelude the format needs first. */
	preludeEnd?: number;
}

export type Atom<B> =
	| { kind: 'gap'; text: string }
	/** A block in an item's place; `item` is that item. */
	| { kind: 'kept'; block: B; item: SourceItem }
	| { kind: 'new'; block: B };

/**
 * Plans the output as atoms in order: the source between items, kept blocks and
 * new ones. A deleted item leaves only the source before it.
 */
export function plan<B>(
	src: string,
	region: Region,
	items: readonly SourceItem[],
	blocks: readonly B[],
	refOf: (b: B) => number | undefined
): Atom<B>[] {
	const index = new Map(items.map((it, i) => [it.ref, i]));
	const kept = new Map<number, B>();
	const after = new Map<number, B[]>();
	let last = -1;
	for (const b of blocks) {
		const ref = refOf(b);
		const i = ref === undefined ? undefined : index.get(ref);
		if (i !== undefined && i > last) {
			kept.set(i, b);
			last = i;
		} else {
			const list = after.get(last) ?? [];
			list.push(b);
			after.set(last, list);
		}
	}
	const out: Atom<B>[] = [];
	const gap = (from: number, to: number) => {
		if (to > from) out.push({ kind: 'gap', text: src.slice(from, to) });
	};
	const preludeEnd = Math.min(region.preludeEnd ?? region.start, items[0]?.start ?? region.end);
	gap(region.start, preludeEnd);
	for (const b of after.get(-1) ?? []) out.push({ kind: 'new', block: b });
	let cursor = preludeEnd;
	items.forEach((item, i) => {
		gap(cursor, item.start);
		const b = kept.get(i);
		if (b !== undefined) out.push({ kind: 'kept', block: b, item });
		cursor = item.end;
		for (const n of after.get(i) ?? []) out.push({ kind: 'new', block: n });
	});
	gap(cursor, region.end);
	return out;
}

/** Copies what is unchanged and regenerates the rest. */
export function emit<B>(
	src: string,
	atoms: readonly Atom<B>[],
	same: (b: B, item: SourceItem) => boolean,
	generate: (b: B, item?: SourceItem) => string
): string {
	let out = '';
	for (const a of atoms) {
		if (a.kind === 'gap') out += a.text;
		else if (a.kind === 'new') out += generate(a.block);
		else
			out += same(a.block, a.item)
				? src.slice(a.item.start, a.item.end)
				: generate(a.block, a.item);
	}
	return out;
}
