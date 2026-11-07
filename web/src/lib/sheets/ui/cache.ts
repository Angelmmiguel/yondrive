/**
 * The cells the grid has fetched from the worker, in blocks of rows and columns.
 * Scrolling asks for the blocks a view needs that are not here yet. An edit marks
 * what it touched as stale: those cells are still shown until the fresh ones
 * arrive, so nothing flickers. Old blocks go once there are too many, so a long
 * scroll through a large sheet keeps memory flat.
 */
import type { Area } from '$lib/formula/address';
import type { CellView } from '../service';

export const BLOCK_ROWS = 64;
export const BLOCK_COLS = 16;

const blockKey = (br: number, bc: number) => `${br}:${bc}`;
const cellKey = (row: number, col: number) => `${row}:${col}`;

export interface BlockRequest {
	key: string;
	area: Area;
	epoch: number;
}

const touches = (a: Area, b: Area) =>
	!(b.bottom < a.top || b.top > a.bottom || b.right < a.left || b.left > a.right);

export class WindowCache {
	readonly maxBlocks: number;
	/** Blocks here, oldest use first; `fresh` is false once an edit may have changed them. */
	#blocks = new Map<string, { area: Area; fresh: boolean }>();
	/** Blocks asked for and not yet answered. */
	#pending = new Set<string>();
	#cells = new Map<string, CellView>();
	/** Bumped when anything goes stale, so an answer to an older request is not taken as fresh. */
	#epoch = 0;
	/** The epoch of the last clear: answers from before it describe other positions. */
	#cleared = 0;

	constructor(maxBlocks = 600) {
		this.maxBlocks = maxBlocks;
	}

	get(row: number, col: number): CellView | undefined {
		return this.#cells.get(cellKey(row, col));
	}

	/** Whether the block holding a cell has been fetched, fresh or not. */
	loaded(row: number, col: number): boolean {
		return this.#blocks.has(blockKey(Math.floor(row / BLOCK_ROWS), Math.floor(col / BLOCK_COLS)));
	}

	/** The blocks over an area to fetch: not here, or stale, and not already asked for. */
	missing(area: Area): BlockRequest[] {
		const out: BlockRequest[] = [];
		const top = Math.floor(Math.max(0, area.top) / BLOCK_ROWS);
		const bottom = Math.floor(Math.max(0, area.bottom) / BLOCK_ROWS);
		const left = Math.floor(Math.max(0, area.left) / BLOCK_COLS);
		const right = Math.floor(Math.max(0, area.right) / BLOCK_COLS);
		for (let br = top; br <= bottom; br++) {
			for (let bc = left; bc <= right; bc++) {
				const key = blockKey(br, bc);
				const seen = this.#blocks.get(key);
				if (seen) {
					// Used again: to the young end.
					this.#blocks.delete(key);
					this.#blocks.set(key, seen);
					if (seen.fresh) continue;
				}
				if (this.#pending.has(key)) continue;
				this.#pending.add(key);
				out.push({
					key,
					epoch: this.#epoch,
					area: {
						top: br * BLOCK_ROWS,
						left: bc * BLOCK_COLS,
						bottom: br * BLOCK_ROWS + BLOCK_ROWS - 1,
						right: bc * BLOCK_COLS + BLOCK_COLS - 1
					}
				});
			}
		}
		return out;
	}

	/**
	 * A fetched block arrives. One asked for before something went stale is shown
	 * but stays stale, to be asked for again. False if it was not kept at all.
	 */
	fill(block: BlockRequest, cells: readonly CellView[]): boolean {
		this.#pending.delete(block.key);
		const current = block.epoch === this.#epoch;
		const here = this.#blocks.get(block.key);
		if (block.epoch < this.#cleared || (!current && here)) return false;
		this.#forget(block.area);
		for (const c of cells) this.#cells.set(cellKey(c.row, c.col), c);
		this.#blocks.delete(block.key);
		this.#blocks.set(block.key, { area: block.area, fresh: current });
		while (this.#blocks.size > this.maxBlocks) {
			const [oldest, b] = this.#blocks.entries().next().value as [
				string,
				{ area: Area; fresh: boolean }
			];
			this.#blocks.delete(oldest);
			this.#forget(b.area);
		}
		return true;
	}

	/** A request failed: it may be asked for again. */
	failed(block: { key: string }): void {
		this.#pending.delete(block.key);
	}

	#forget(a: Area): void {
		for (let r = a.top; r <= a.bottom; r++)
			for (let c = a.left; c <= a.right; c++) this.#cells.delete(cellKey(r, c));
	}

	/** Marks cells as stale, to be fetched again while still shown: all of them, or those in areas. */
	stale(areas?: readonly Area[]): void {
		this.#epoch++;
		this.#pending.clear();
		for (const b of this.#blocks.values()) {
			if (!areas || areas.some((a) => touches(a, b.area))) b.fresh = false;
		}
	}

	/** Forgets everything, as when rows move under the cells. */
	clear(): void {
		this.#cleared = ++this.#epoch;
		this.#pending.clear();
		this.#blocks.clear();
		this.#cells.clear();
	}

	get size(): { blocks: number; cells: number } {
		return { blocks: this.#blocks.size, cells: this.#cells.size };
	}
}

/** One cache per sheet of the open file. */
export class SheetCaches {
	#all = new Map<number, WindowCache>();

	of(sheet: number): WindowCache {
		let c = this.#all.get(sheet);
		if (!c) {
			c = new WindowCache();
			this.#all.set(sheet, c);
		}
		return c;
	}

	/** Marks the cells an edit changed as stale, sheet by sheet; many at once mark the whole sheet. */
	changed(refs: readonly { sheet: number; row: number; col: number }[]): void {
		const by = new Map<number, Area[]>();
		for (const r of refs) {
			const list = by.get(r.sheet) ?? [];
			list.push({ top: r.row, left: r.col, bottom: r.row, right: r.col });
			by.set(r.sheet, list);
		}
		for (const [id, areas] of by) this.#all.get(id)?.stale(areas.length > 2000 ? undefined : areas);
	}

	stale(): void {
		for (const c of this.#all.values()) c.stale();
	}

	clear(): void {
		for (const c of this.#all.values()) c.clear();
	}

	reset(): void {
		this.#all.clear();
	}
}
