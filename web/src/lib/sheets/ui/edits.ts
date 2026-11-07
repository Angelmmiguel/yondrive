/**
 * Every change the grid makes goes through here: each is one queued step of calls
 * to the worker, recorded with the calls that take it back. Saving joins the same
 * queue, so a save never lands between the calls of one step and the file never
 * holds half of an edit.
 */
import type { Area } from '$lib/formula/address';
import type { CellRef } from '$lib/formula/engine';
import type { CellStyle } from '$lib/formats/workbook';
import type { SheetSaveFormat } from '$lib/formats/spreadsheet';
import type { Remote } from '../rpc';
import type {
	CellView,
	EditResult,
	SheetMeta,
	SheetService,
	SortKey,
	StylePatch
} from '../service';
import { cellCount, overlaps } from './selection';
import { History, restoreOps, textOf, type Op, type Step } from './history';

/** The most cells a step reads back to be undone; a larger edit clears the history. */
export const SNAPSHOT_LIMIT = 50_000;
/** The most cells read to put back the formulas a delete of rows or columns broke. */
const FORMULA_SCAN_LIMIT = 200_000;
/** Typed text that may give a General cell a number format: anything with a digit that is not a plain number. */
const PLAIN_NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;
const suggestsFormat = (t: string) => /\d/.test(t) && !PLAIN_NUMBER.test(t);

export interface Outcome {
	/** Cells whose value or formula changed. */
	changed: CellRef[];
	/** The style table, when it grew. */
	styles?: CellStyle[];
	/** Rows, columns, merges, sizes or panes changed: the sheet's layout is read again. */
	layout: boolean;
	/** Formatting reached only the cells with content, the area being too large for every empty one. */
	partial?: boolean;
	/** The step could not be recorded, and the history was cleared. */
	notUndoable?: boolean;
	/** For undo and redo: the step taken, to show where it was. */
	step?: Step;
}

const LAYOUT = new Set<Op['t']>(['rows', 'cols', 'merge', 'unmerge', 'width', 'height', 'frozen']);

/**
 * Runs of equal size over a span of a sheet's rows or columns, as the sheet
 * sets them. One pass over the sizes, however many rows the file lists.
 */
export function sizeRuns(
	meta: Pick<SheetMeta, 'rowInfo' | 'colInfo'>,
	axis: 'width' | 'height',
	from: number,
	to: number
): { from: number; to: number; size: number | undefined }[] {
	const set = new Map<number, number | undefined>();
	if (axis === 'height') {
		for (const [r, i] of meta.rowInfo)
			if (r >= from && r <= to && !set.has(r)) set.set(r, i.height);
	} else {
		for (const c of meta.colInfo)
			for (let i = Math.max(c.min, from); i <= Math.min(c.max, to); i++)
				if (!set.has(i)) set.set(i, c.width);
	}
	const out: { from: number; to: number; size: number | undefined }[] = [];
	for (let i = from; i <= to; i++) {
		const s = set.get(i);
		const last = out[out.length - 1];
		if (last && last.size === s && last.to === i - 1) last.to = i;
		else out.push({ from: i, to: i, size: s });
	}
	return out;
}

export class SheetEditor {
	readonly #api: Remote<SheetService>;
	readonly history: History;
	#chain: Promise<unknown> = Promise.resolve();
	#styles: CellStyle[];

	constructor(api: Remote<SheetService>, styles: CellStyle[], limit = 100) {
		this.#api = api;
		this.#styles = styles;
		this.history = new History(limit);
	}

	get styles(): CellStyle[] {
		return this.#styles;
	}

	/** One after another, in the order asked, whatever each one awaits. */
	queue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.#chain.then(fn, fn);
		this.#chain = next.catch(() => {});
		return next;
	}

	/** The file's bytes, after every edit asked for before. */
	save(format?: SheetSaveFormat, sheet?: number) {
		return this.queue(() => this.#api.save(format, sheet));
	}

	async #exec(op: Op): Promise<EditResult | void> {
		const a = this.#api;
		switch (op.t) {
			case 'cells':
				return a.setCells(op.edits.map((e) => ({ sheet: op.sheet, ...e })));
			case 'clear':
				return a.clear(op.sheet, op.area);
			case 'style':
				return a.setStyle(op.sheet, op.area, op.patch);
			case 'rows':
				return op.count > 0
					? a.insertRows(op.sheet, op.at, op.count)
					: a.deleteRows(op.sheet, op.at, -op.count);
			case 'cols':
				return op.count > 0
					? a.insertCols(op.sheet, op.at, op.count)
					: a.deleteCols(op.sheet, op.at, -op.count);
			case 'merge':
				return a.merge(op.sheet, op.area);
			case 'unmerge':
				return a.unmerge(op.sheet, op.area);
			case 'width':
				return a.setColWidth(op.sheet, op.from, op.to, op.size);
			case 'height':
				return a.setRowHeight(op.sheet, op.from, op.to, op.size);
			case 'frozen':
				return a.setFrozen(op.sheet, op.rows, op.cols);
			case 'sort':
				return a.sort(op.sheet, op.area, op.keys, op.header);
		}
	}

	async #run(ops: Op[]): Promise<Outcome> {
		const out: Outcome = { changed: [], layout: false };
		let grew = false;
		for (const op of ops) {
			const r = await this.#exec(op);
			out.layout ||= LAYOUT.has(op.t);
			if (r) {
				out.changed.push(...r.changed);
				if (r.partial) out.partial = true;
				if (r.newStyles) grew = true;
			}
		}
		if (grew) {
			this.#styles = await this.#api.styles();
			out.styles = this.#styles;
		}
		return out;
	}

	async #snapshot(
		sheet: number,
		area: Area
	): Promise<{ sheet: number; area: Area; cells: CellView[] }> {
		return {
			sheet,
			area,
			cells: await this.#api.window(sheet, area.top, area.left, area.bottom, area.right)
		};
	}

	async #meta(sheet: number): Promise<SheetMeta> {
		const m = (await this.#api.sheets()).find((s) => s.id === sheet);
		if (!m) throw new Error('no such sheet');
		return m;
	}

	/** The used part of an area, where whole rows or columns reach past the content. */
	async #used(sheet: number, area: Area): Promise<Area | null> {
		const m = await this.#meta(sheet);
		const a = {
			top: area.top,
			left: area.left,
			bottom: Math.min(area.bottom, Math.max(m.rows - 1, area.top)),
			right: Math.min(area.right, Math.max(m.cols - 1, area.left))
		};
		return a;
	}

	/** Runs a step and records it, its way back worked out by `inverse` before it runs. */
	#step(
		label: string,
		sheet: number,
		area: Area,
		redo: Op[],
		inverse: () => Promise<Op[] | null>
	): Promise<Outcome> {
		return this.queue(async () => {
			const undo = await inverse();
			const out = await this.#run(redo);
			if (undo) this.history.push({ label, sheet, area, redo, undo });
			else {
				this.history.clear();
				out.notUndoable = true;
			}
			return out;
		});
	}

	/** What was typed or pasted, cell by cell. */
	setCells(
		sheet: number,
		edits: { row: number; col: number; text: string }[],
		label = 'Typing'
	): Promise<Outcome> {
		if (edits.length === 0) return Promise.resolve({ changed: [], layout: false });
		const area = {
			top: Math.min(...edits.map((e) => e.row)),
			left: Math.min(...edits.map((e) => e.col)),
			bottom: Math.max(...edits.map((e) => e.row)),
			right: Math.max(...edits.map((e) => e.col))
		};
		return this.#step(label, sheet, area, [{ t: 'cells', sheet, edits }], async () => {
			if (edits.length > SNAPSHOT_LIMIT) return null;
			const before = await Promise.all(edits.map((e) => this.#api.cell(sheet, e.row, e.col)));
			// What a General cell's style becomes on typing a percentage, money or a date is put back too.
			const undo: Op[] = [
				{
					t: 'cells',
					sheet,
					edits: edits.map((e, i) => ({ row: e.row, col: e.col, text: textOf(before[i]) }))
				}
			];
			for (let i = 0; i < edits.length; i++) {
				const { row, col, text } = edits[i];
				if (!suggestsFormat(text) || text.startsWith('=') || text.startsWith("'")) continue;
				const s = this.#styles[before[i]?.style ?? 0];
				const at = { top: row, left: col, bottom: row, right: col };
				if (s?.numFmt === 'General')
					undo.push({ t: 'style', sheet, area: at, patch: { numFmt: 'General' } });
			}
			return undo;
		});
	}

	clear(sheet: number, area: Area): Promise<Outcome> {
		return this.#step('Clear', sheet, area, [{ t: 'clear', sheet, area }], async () => {
			const used = await this.#used(sheet, area);
			if (!used || cellCount(used) > SNAPSHOT_LIMIT) return null;
			return restoreOps(await this.#snapshot(sheet, used), this.#styles, {
				text: true,
				style: false
			});
		});
	}

	/** Formatting, as one patch or a patch per part of the area (outer borders). */
	style(
		sheet: number,
		area: Area,
		parts: { area: Area; patch: StylePatch }[],
		label = 'Formatting'
	): Promise<Outcome> {
		const redo: Op[] = parts.map((p) => ({ t: 'style', sheet, area: p.area, patch: p.patch }));
		return this.#step(label, sheet, area, redo, async () => {
			if (cellCount(area) > SNAPSHOT_LIMIT) return null;
			return restoreOps(await this.#snapshot(sheet, area), this.#styles, {
				text: false,
				style: true
			});
		});
	}

	insert(sheet: number, axis: 'rows' | 'cols', at: number, count: number): Promise<Outcome> {
		const area =
			axis === 'rows'
				? { top: at, left: 0, bottom: at + count - 1, right: 0 }
				: { top: 0, left: at, bottom: 0, right: at + count - 1 };
		return this.#step('Insert', sheet, area, [{ t: axis, sheet, at, count }], async () => [
			{ t: axis, sheet, at, count: -count }
		]);
	}

	/**
	 * Deletes rows or columns. Taking it back inserts them again with what they
	 * held, their sizes and merges, and the formulas elsewhere that pointed into
	 * them as they were.
	 */
	remove(sheet: number, axis: 'rows' | 'cols', at: number, count: number): Promise<Outcome> {
		const rows = axis === 'rows';
		return this.queue(async () => {
			const meta = await this.#meta(sheet);
			const area = rows
				? { top: at, left: 0, bottom: at + count - 1, right: Math.max(0, meta.cols - 1) }
				: { top: 0, left: at, bottom: Math.max(0, meta.rows - 1), right: at + count - 1 };
			let undo: Op[] | null = null;
			let formulas: Map<string, CellView> | null = null;
			const all = await this.#api.sheets();
			const total = all.reduce((n, s) => n + s.rows * s.cols, 0);
			if (cellCount(area) <= SNAPSHOT_LIMIT && total <= FORMULA_SCAN_LIMIT) {
				const snap = await this.#snapshot(sheet, area);
				undo = [
					{ t: axis, sheet, at, count },
					...restoreOps(snap, this.#styles, { text: true, style: true })
				];
				for (const m of meta.merges) {
					const inside = rows
						? m.top >= at && m.bottom < at + count
						: m.left >= at && m.right < at + count;
					if (inside) undo.push({ t: 'merge', sheet, area: m });
				}
				const sizes = sizeRuns(meta, rows ? 'height' : 'width', at, at + count - 1);
				for (const s of sizes)
					if (s.size !== undefined) undo.push({ t: rows ? 'height' : 'width', sheet, ...s });
				formulas = new Map();
				for (const s of all) {
					if (s.rows === 0 || s.cols === 0) continue;
					for (const c of await this.#api.window(s.id, 0, 0, s.rows - 1, s.cols - 1))
						if (c.formula && !c.readOnly) formulas.set(`${s.id}:${c.row}:${c.col}`, c);
				}
			}
			const redo: Op[] = [{ t: axis, sheet, at, count: -count }];
			const out = await this.#run(redo);
			if (undo && formulas) {
				// Formulas the delete changed, found where they were before it.
				const back: Map<number, { row: number; col: number; text: string }[]> = new Map();
				for (const ref of out.changed) {
					let row = ref.row;
					let col = ref.col;
					if (ref.sheet === sheet) {
						if (rows && row >= at) row += count;
						if (!rows && col >= at) col += count;
					}
					const was = formulas.get(`${ref.sheet}:${row}:${col}`);
					if (!was) continue;
					const list = back.get(ref.sheet) ?? [];
					list.push({ row, col, text: textOf(was) });
					back.set(ref.sheet, list);
				}
				for (const [s, edits] of back) undo.push({ t: 'cells', sheet: s, edits });
				this.history.push({ label: 'Delete', sheet, area, redo, undo });
			} else {
				this.history.clear();
				out.notUndoable = true;
			}
			return out;
		});
	}

	/** Merges an area; what it had besides its top left cell goes, and comes back on undo. */
	merge(sheet: number, area: Area): Promise<Outcome> {
		return this.#step('Merge', sheet, area, [{ t: 'merge', sheet, area }], async () => {
			if (cellCount(area) > SNAPSHOT_LIMIT) return null;
			const meta = await this.#meta(sheet);
			return [
				{ t: 'unmerge', sheet, area },
				...meta.merges
					.filter((m) => overlaps(m, area))
					.map((m): Op => ({ t: 'merge', sheet, area: m })),
				...restoreOps(await this.#snapshot(sheet, area), this.#styles, {
					text: true,
					style: false
				})
			];
		});
	}

	unmerge(sheet: number, area: Area): Promise<Outcome> {
		return this.#step('Unmerge', sheet, area, [{ t: 'unmerge', sheet, area }], async () => {
			const meta = await this.#meta(sheet);
			return meta.merges
				.filter((m) => overlaps(m, area))
				.map((m) => ({ t: 'merge', sheet, area: m }));
		});
	}

	/** Column widths in characters, or row heights in points; undefined for the default. */
	resize(
		sheet: number,
		axis: 'width' | 'height',
		from: number,
		to: number,
		size: number | undefined
	): Promise<Outcome> {
		const area =
			axis === 'width'
				? { top: 0, left: from, bottom: 0, right: to }
				: { top: from, left: 0, bottom: to, right: 0 };
		return this.#step('Resize', sheet, area, [{ t: axis, sheet, from, to, size }], async () => {
			if (to - from > 10_000) return null;
			const meta = await this.#meta(sheet);
			return sizeRuns(meta, axis, from, to).map((r) => ({ t: axis, sheet, ...r }));
		});
	}

	freeze(sheet: number, rows: number, cols: number): Promise<Outcome> {
		const area = { top: 0, left: 0, bottom: 0, right: 0 };
		return this.#step('Freeze', sheet, area, [{ t: 'frozen', sheet, rows, cols }], async () => {
			const f = (await this.#meta(sheet)).frozen;
			return [{ t: 'frozen', sheet, rows: f?.rows ?? 0, cols: f?.cols ?? 0 }];
		});
	}

	sort(sheet: number, area: Area, keys: SortKey[], header: boolean): Promise<Outcome> {
		return this.#step('Sort', sheet, area, [{ t: 'sort', sheet, area, keys, header }], async () => {
			if (cellCount(area) > SNAPSHOT_LIMIT) return null;
			return restoreOps(await this.#snapshot(sheet, area), this.#styles, {
				text: true,
				style: true
			});
		});
	}

	/** A change that is not recorded, such as to the sheets themselves: the history goes. */
	untracked<T>(fn: (api: Remote<SheetService>) => Promise<T>): Promise<T> {
		return this.queue(async () => {
			const r = await fn(this.#api);
			this.history.clear();
			return r;
		});
	}

	undo(): Promise<Outcome | null> {
		return this.#replay(() => this.history.undo(), 'undo');
	}

	redo(): Promise<Outcome | null> {
		return this.#replay(() => this.history.redo(), 'redo');
	}

	#replay(take: () => Step | undefined, way: 'undo' | 'redo'): Promise<Outcome | null> {
		return this.queue(async () => {
			const step = take();
			if (!step) return null;
			try {
				return { ...(await this.#run(step[way])), step };
			} catch (e) {
				// Half taken back: what is left of the history no longer fits the sheet.
				this.history.clear();
				throw e;
			}
		});
	}
}
