/**
 * Undo and redo as calls to the worker. Every edit is recorded as the calls that
 * made it and the calls that take it back, worked out from what the cells held
 * before; undoing runs the second list, redoing the first. The history is
 * bounded, and an edit too large to take back clears it rather than leave
 * earlier steps to run against a sheet they no longer describe.
 */
import type { Area } from '$lib/formula/address';
import { isError } from '$lib/formula/values';
import type { CellStyle } from '$lib/formats/workbook';
import type { CellView, SortKey, StylePatch } from '../service';

export type Op =
	| { t: 'cells'; sheet: number; edits: { row: number; col: number; text: string }[] }
	| { t: 'clear'; sheet: number; area: Area }
	| { t: 'style'; sheet: number; area: Area; patch: StylePatch }
	| { t: 'rows' | 'cols'; sheet: number; at: number; count: number }
	| { t: 'merge' | 'unmerge'; sheet: number; area: Area }
	| { t: 'width'; sheet: number; from: number; to: number; size: number | undefined }
	| { t: 'height'; sheet: number; from: number; to: number; size: number | undefined }
	| { t: 'frozen'; sheet: number; rows: number; cols: number }
	| { t: 'sort'; sheet: number; area: Area; keys: SortKey[]; header: boolean };

export interface Step {
	label: string;
	sheet: number;
	/** Where the selection was, to put it back. */
	area: Area;
	redo: Op[];
	undo: Op[];
}

/** What to type into a cell to have it hold what it holds now. */
export function textOf(v: CellView | null | undefined): string {
	if (!v) return '';
	if (v.formula) return v.formula.startsWith('=') ? v.formula : `=${v.formula}`;
	const x = v.value;
	if (x === null) return '';
	if (typeof x === 'number') return String(x);
	if (typeof x === 'boolean') return x ? 'TRUE' : 'FALSE';
	if (isError(x)) return x.error;
	return `'${x}`;
}

/** A patch that turns any style into this one exactly. */
export function fullPatch(s: CellStyle): StylePatch {
	const f = s.font;
	const b = s.border;
	const a = s.align;
	return {
		numFmt: s.numFmt,
		font: {
			name: f.name ?? null,
			size: f.size ?? null,
			bold: f.bold ?? null,
			italic: f.italic ?? null,
			underline: f.underline ?? null,
			strike: f.strike ?? null,
			color: f.color ?? null
		},
		fill: s.fill ?? null,
		border: {
			top: b.top ?? null,
			right: b.right ?? null,
			bottom: b.bottom ?? null,
			left: b.left ?? null
		},
		align: {
			h: a.h ?? null,
			v: a.v ?? null,
			wrap: a.wrap ?? null,
			indent: a.indent ?? null,
			rotate: a.rotate ?? null
		}
	};
}

/** Cells as they were: their text where `text` is asked for, and their style. */
export interface Snapshot {
	sheet: number;
	area: Area;
	/** The cells with content or a style, from `window`. */
	cells: CellView[];
}

/**
 * The calls that put an area back as the snapshot has it: what was typed in
 * each cell (empty where nothing was), and each style. Cells that cannot be
 * changed here are left alone, since no edit could have changed them.
 */
export function restoreOps(
	snap: Snapshot,
	styles: readonly CellStyle[],
	what: { text: boolean; style: boolean }
): Op[] {
	const { sheet, area } = snap;
	const at = new Map<string, CellView>();
	for (const c of snap.cells) at.set(`${c.row}:${c.col}`, c);
	const ops: Op[] = [];
	if (what.text) {
		const edits: { row: number; col: number; text: string }[] = [];
		for (let r = area.top; r <= area.bottom; r++) {
			for (let c = area.left; c <= area.right; c++) {
				const v = at.get(`${r}:${c}`);
				if (v?.readOnly) continue;
				edits.push({ row: r, col: c, text: textOf(v) });
			}
		}
		if (edits.length > 0) ops.push({ t: 'cells', sheet, edits });
	}
	if (what.style) {
		// Runs along each row of one style, joined into rectangles where rows repeat.
		const runs: { area: Area; style: number }[] = [];
		const open = new Map<string, { area: Area; style: number }>();
		for (let r = area.top; r <= area.bottom; r++) {
			let start = area.left;
			let style = at.get(`${r}:${area.left}`)?.style ?? 0;
			const rowRuns: { left: number; right: number; style: number }[] = [];
			for (let c = area.left + 1; c <= area.right + 1; c++) {
				const s = c <= area.right ? (at.get(`${r}:${c}`)?.style ?? 0) : -1;
				if (s !== style) {
					rowRuns.push({ left: start, right: c - 1, style });
					start = c;
					style = s;
				}
			}
			const seen = new Set<string>();
			for (const run of rowRuns) {
				const key = `${run.left}:${run.right}:${run.style}`;
				seen.add(key);
				const prev = open.get(key);
				if (prev && prev.area.bottom === r - 1) prev.area.bottom = r;
				else {
					const next = {
						area: { top: r, left: run.left, bottom: r, right: run.right },
						style: run.style
					};
					open.set(key, next);
					runs.push(next);
				}
			}
			for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
		}
		for (const run of runs) {
			const s = styles[run.style] ?? styles[0];
			if (s) ops.push({ t: 'style', sheet, area: run.area, patch: fullPatch(s) });
		}
	}
	return ops;
}

export class History {
	readonly limit: number;
	#done: Step[] = [];
	#undone: Step[] = [];

	constructor(limit = 100) {
		this.limit = limit;
	}

	push(step: Step): void {
		this.#done.push(step);
		if (this.#done.length > this.limit) this.#done.shift();
		this.#undone = [];
	}

	/** The step to take back, moved to the redo side. */
	undo(): Step | undefined {
		const s = this.#done.pop();
		if (s) this.#undone.push(s);
		return s;
	}

	redo(): Step | undefined {
		const s = this.#undone.pop();
		if (s) this.#done.push(s);
		return s;
	}

	clear(): void {
		this.#done = [];
		this.#undone = [];
	}

	get canUndo(): boolean {
		return this.#done.length > 0;
	}

	get canRedo(): boolean {
		return this.#undone.length > 0;
	}
}
