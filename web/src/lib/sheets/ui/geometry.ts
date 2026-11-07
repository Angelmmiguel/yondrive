/**
 * Where rows and columns are on screen. Each axis has a default size and a few
 * that differ (set in the file, resized, hidden or filtered out), so positions
 * come from a sorted list of the differences and their running sums: finding
 * the offset of row 900,000 or the row at a pixel is a binary search, never a
 * walk over every row.
 */

/** Excel's column width in characters of the default font, as pixels at 100%. */
export const colPx = (chars: number) => Math.max(0, Math.round(chars * 7 + 5));
/** Pixels back to characters, to two places, as a file stores them. */
export const pxToChars = (px: number) => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
/** Row height in points as pixels at 100%. */
export const rowPx = (pt: number) => Math.max(0, Math.round((pt * 4) / 3));
export const pxToPt = (px: number) => Math.max(0, Math.round(px * 0.75 * 4) / 4);

export class Axis {
	readonly size: number;
	readonly count: number;
	/** Indices whose size differs, ascending. */
	#at: number[];
	#sizes: number[];
	/** Sum of (size - default) for the overrides before each one. */
	#before: number[];
	/** One index at another size, laid over the rest, as while it is dragged. */
	#over: { index: number; size: number; delta: number } | null = null;

	/** `sizes` maps an index to its size where it is not `size`; 0 hides it. */
	constructor(size: number, count: number, sizes: Map<number, number>) {
		this.size = size;
		this.count = count;
		this.#at = [...sizes.keys()].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
		this.#sizes = this.#at.map((i) => sizes.get(i) as number);
		this.#before = [];
		let sum = 0;
		for (let k = 0; k < this.#at.length; k++) {
			this.#before.push(sum);
			sum += this.#sizes[k] - size;
		}
		this.#before.push(sum);
	}

	/** How many overrides lie before index `i`. */
	#rank(i: number): number {
		let lo = 0;
		let hi = this.#at.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#at[mid] < i) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/**
	 * This axis with index `i` at `size`: what a drag shows on every move, so it
	 * shares the sorted sizes rather than sorting them again.
	 */
	withSize(i: number, size: number): Axis {
		const a = new Axis(this.size, this.count, new Map());
		a.#at = this.#at;
		a.#sizes = this.#sizes;
		a.#before = this.#before;
		a.#over = { index: i, size, delta: size - this.#baseSize(i) };
		return a;
	}

	#baseSize(i: number): number {
		const k = this.#rank(i);
		return this.#at[k] === i ? this.#sizes[k] : this.size;
	}

	sizeOf(i: number): number {
		return this.#over?.index === i ? this.#over.size : this.#baseSize(i);
	}

	/** Where index `i` starts. */
	offsetOf(i: number): number {
		const n = Math.max(0, Math.min(i, this.count));
		const over = this.#over !== null && n > this.#over.index ? this.#over.delta : 0;
		return n * this.size + this.#before[this.#rank(n)] + over;
	}

	get total(): number {
		return this.offsetOf(this.count);
	}

	/** The index at a pixel: the last one starting at or before it, skipping hidden ones. */
	indexAt(px: number): number {
		if (px <= 0) return this.#visibleFrom(0);
		let lo = 0;
		let hi = this.count - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.offsetOf(mid) <= px) lo = mid;
			else hi = mid - 1;
		}
		while (lo > 0 && this.sizeOf(lo) === 0) lo--;
		return lo;
	}

	#visibleFrom(i: number): number {
		let j = i;
		while (j < this.count - 1 && this.sizeOf(j) === 0) j++;
		return j;
	}

	hidden(i: number): boolean {
		return this.sizeOf(i) === 0;
	}

	/** The next index from `i` in direction `step` that is shown, or `i` if there is none. */
	nextShown(i: number, step: 1 | -1): number {
		let j = i + step;
		while (j >= 0 && j < this.count && this.hidden(j)) j += step;
		return j >= 0 && j < this.count ? j : i;
	}
}

/** Sizes that differ from the default along an axis, in pixels at a zoom. */
export function rowSizes(
	info: readonly [number, { height?: number; hidden?: true }][],
	zoom: number,
	hidden: Iterable<number>
): Map<number, number> {
	const sizes = new Map<number, number>();
	for (const [r, i] of info) {
		if (i.hidden) sizes.set(r, 0);
		else if (i.height !== undefined) sizes.set(r, Math.round(rowPx(i.height) * zoom));
	}
	for (const r of hidden) sizes.set(r, 0);
	return sizes;
}

export function colSizes(
	info: readonly { min: number; max: number; width?: number; hidden?: true }[],
	zoom: number,
	count: number
): Map<number, number> {
	const sizes = new Map<number, number>();
	for (const c of info) {
		for (let i = c.min; i <= Math.min(c.max, count - 1); i++) {
			if (c.hidden) sizes.set(i, 0);
			else if (c.width !== undefined) sizes.set(i, Math.round(colPx(c.width) * zoom));
		}
	}
	return sizes;
}
