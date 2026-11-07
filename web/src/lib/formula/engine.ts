/**
 * The workbook as the formula engine holds it: cells by sheet, a dependency graph
 * and incremental recalculation.
 *
 * Dependencies are kept two ways so ranges cost no more than their description:
 * a reference to one cell is indexed by that cell, and a range by the columns it
 * spans (or, when it spans many, in a short list scanned per change). A change
 * marks its dependents and theirs; those are ordered with Tarjan's algorithm, so
 * each is calculated once after everything it reads, and a group that reads
 * itself is a cycle: its cells show #REF! and are flagged.
 *
 * A formula with a function or feature this engine does not calculate keeps its
 * text and the value the file had. Its cell is read-only and cells reading it use
 * that value. Nothing here ever replaces such a formula.
 */
import { cellKey, contains, keyCol, MAX_COLS, MAX_ROWS, type Area } from './address';
import { print, walk, type Node } from './ast';
import { evaluateFormula, evaluate } from './eval';
import { FUNCTIONS, isSupported } from './functions';
import type { Ctx } from './operand';
import { FormulaSyntaxError, parseFormula } from './parse';
import { dropSheetIn, renameSheetIn, shiftArea, shiftFormula, type AxisEdit } from './shift';
import { sameValue, err, type Scalar } from './values';

export type FormulaStatus =
	/** Calculated here. */
	| 'ok'
	/** Parsed, but uses something not calculated here; keeps the file's value. */
	| 'unsupported'
	/** Not understood at all; kept as text with the file's value. */
	| 'invalid';

export interface Formula {
	/** As files store it, without `=`. */
	text: string;
	ast: Node | null;
	status: FormulaStatus;
	/** For an unsupported formula: what is not calculated (`XLOOKUP`, `named range`). */
	missing: string[];
	volatile: boolean;
	/** An array formula: the cells it fills. Read-only. */
	array?: Area;
}

export interface Cell {
	sheet: number;
	row: number;
	col: number;
	value: Scalar;
	formula?: Formula;
	/** An index into the workbook's style table, carried along as the cell moves. */
	style: number;
	/** Part of a dependency cycle at the last calculation. */
	cycle?: true;
	/** An unsupported formula whose inputs changed: its value is out of date. */
	stale?: true;
	/** Registered precedents, to take them out again. */
	deps?: Deps;
}

interface RangeDep {
	cell: Cell;
	sheet: number;
	area: Area;
}

interface Deps {
	cells: [number, number][];
	ranges: RangeDep[];
}

export interface CellRef {
	sheet: number;
	row: number;
	col: number;
}

export type CellInput = { formula: string } | { value: Scalar };

export interface DefinedName {
	name: string;
	/** As the file has it, without `=`. */
	text: string;
	/** Local to a sheet, by id. */
	sheet?: number;
	/** Which name of the file this is, for a writer that keeps the rest of it. */
	key?: number;
}

export type InputProblem = 'syntax' | 'unsupported' | 'arity' | 'sheet' | 'readonly';

/** Why a cell cannot take what was typed, for the UI to say. */
export class FormulaInputError extends Error {
	constructor(
		readonly problem: InputProblem,
		readonly detail = ''
	) {
		super(`${problem}${detail ? `: ${detail}` : ''}`);
		this.name = 'FormulaInputError';
	}
}

/** Ranges spanning more columns than this are scanned rather than indexed. */
const WIDE = 64;

class SheetStore {
	cells = new Map<number, Cell>();
	#sorted: number[] | null = null;
	#extent: { rows: number; cols: number } | null = { rows: 0, cols: 0 };

	constructor(
		readonly id: number,
		public name: string
	) {}

	set(cell: Cell) {
		const key = cellKey(cell.row, cell.col);
		if (!this.cells.has(key)) {
			this.#sorted = null;
			if (this.#extent) {
				this.#extent.rows = Math.max(this.#extent.rows, cell.row + 1);
				this.#extent.cols = Math.max(this.#extent.cols, cell.col + 1);
			}
		}
		this.cells.set(key, cell);
	}

	delete(row: number, col: number) {
		if (this.cells.delete(cellKey(row, col))) {
			this.#sorted = null;
			this.#extent = null;
		}
	}

	rebuild(cells: Cell[]) {
		this.cells = new Map(cells.map((c) => [cellKey(c.row, c.col), c]));
		this.#sorted = null;
		this.#extent = null;
	}

	sorted(): number[] {
		if (!this.#sorted) this.#sorted = [...this.cells.keys()].sort((a, b) => a - b);
		return this.#sorted;
	}

	extent() {
		if (!this.#extent) {
			let rows = 0;
			let cols = 0;
			for (const c of this.cells.values()) {
				if (c.row + 1 > rows) rows = c.row + 1;
				if (c.col + 1 > cols) cols = c.col + 1;
			}
			this.#extent = { rows, cols };
		}
		return this.#extent;
	}

	/** Cells with content in an area, by rows. */
	each(area: Area, fn: (c: Cell) => void) {
		const size = (area.bottom - area.top + 1) * (area.right - area.left + 1);
		if (size <= 4096 || size <= this.cells.size) {
			const ext = this.extent();
			const bottom = Math.min(area.bottom, ext.rows - 1);
			const right = Math.min(area.right, ext.cols - 1);
			for (let r = area.top; r <= bottom; r++) {
				for (let c = area.left; c <= right; c++) {
					const cell = this.cells.get(cellKey(r, c));
					if (cell) fn(cell);
				}
			}
			return;
		}
		const keys = this.sorted();
		let lo = 0;
		let hi = keys.length;
		const first = cellKey(area.top, 0);
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (keys[mid] < first) lo = mid + 1;
			else hi = mid;
		}
		const last = cellKey(area.bottom, MAX_COLS - 1);
		for (let i = lo; i < keys.length && keys[i] <= last; i++) {
			const col = keyCol(keys[i]);
			if (col < area.left || col > area.right) continue;
			const cell = this.cells.get(keys[i]);
			if (cell) fn(cell);
		}
	}
}

export interface EngineOptions {
	now?: () => Date;
	date1904?: boolean;
}

/** What a change did: the cells whose value or formula is not what it was. */
export interface Changes {
	cells: CellRef[];
}

export class Engine {
	readonly date1904: boolean;
	readonly now: () => Date;
	names: DefinedName[] = [];
	#sheets: SheetStore[] = [];
	#byId = new Map<number, SheetStore>();
	#nextId = 1;
	#cellDeps = new Map<number, Map<number, Set<Cell>>>();
	#colDeps = new Map<number, Map<number, Set<RangeDep>>>();
	#wideDeps = new Map<number, Set<RangeDep>>();
	#volatile = new Set<Cell>();
	#arrays = new Set<Cell>();
	#ctx: Ctx;

	constructor(opts: EngineOptions = {}) {
		this.date1904 = opts.date1904 ?? false;
		this.now = opts.now ?? (() => new Date());
		this.#ctx = {
			sheet: 0,
			row: 0,
			col: 0,
			date1904: this.date1904,
			sheetId: (name) => this.sheetByName(name)?.id,
			value: (s, r, c) => this.#byId.get(s)?.cells.get(cellKey(r, c))?.value ?? null,
			each: (s, area, fn) =>
				this.#byId.get(s)?.each(area, (cell) => fn(cell.value, cell.row, cell.col)),
			extent: (s) => this.#byId.get(s)?.extent() ?? { rows: 0, cols: 0 },
			now: () => this.now(),
			ev: (node) => evaluate(node, this.#ctx)
		};
	}

	// Sheets.

	get sheets(): { id: number; name: string }[] {
		return this.#sheets.map((s) => ({ id: s.id, name: s.name }));
	}

	sheetByName(name: string): { id: number; name: string } | undefined {
		const n = name.toLowerCase();
		return this.#sheets.find((s) => s.name.toLowerCase() === n);
	}

	sheetName(id: number): string {
		const s = this.#byId.get(id);
		if (!s) throw new Error('no such sheet');
		return s.name;
	}

	addSheet(name: string, at = this.#sheets.length): number {
		if (this.sheetByName(name)) throw new FormulaInputError('sheet', 'name in use');
		const s = new SheetStore(this.#nextId++, name);
		this.#sheets.splice(at, 0, s);
		this.#byId.set(s.id, s);
		return s.id;
	}

	moveSheet(id: number, to: number): void {
		const at = this.#sheets.findIndex((s) => s.id === id);
		if (at < 0) return;
		const [s] = this.#sheets.splice(at, 1);
		this.#sheets.splice(to, 0, s);
	}

	renameSheet(id: number, name: string): Changes {
		const s = this.#store(id);
		const other = this.sheetByName(name);
		if (other && other.id !== id) throw new FormulaInputError('sheet', 'name in use');
		const from = s.name;
		s.name = name;
		const changed: Cell[] = [];
		this.#rewrite((ast) => renameSheetIn(ast, from, name), changed);
		for (const n of this.names) {
			const ast = tryParse(n.text);
			if (ast) n.text = print(renameSheetIn(ast, from, name));
		}
		this.#reindex();
		return { cells: changed.map(refOf) };
	}

	removeSheet(id: number): Changes {
		const s = this.#store(id);
		for (const c of s.cells.values()) this.#unregister(c);
		this.#sheets = this.#sheets.filter((x) => x !== s);
		this.#byId.delete(id);
		const changed: Cell[] = [];
		this.#rewrite((ast) => dropSheetIn(ast, s.name), changed);
		this.names = this.names.filter((n) => n.sheet !== id);
		for (const n of this.names) {
			const ast = tryParse(n.text);
			if (ast) n.text = print(dropSheetIn(ast, s.name));
		}
		this.#reindex();
		const recalc = this.#recalc(changed, changed);
		return { cells: uniq([...changed, ...recalc]).map(refOf) };
	}

	// Cells.

	cell(sheet: number, row: number, col: number): Cell | undefined {
		return this.#byId.get(sheet)?.cells.get(cellKey(row, col));
	}

	/** Every cell of a sheet with content or a style, in no particular order. */
	cells(sheet: number): IterableIterator<Cell> {
		return this.#store(sheet).cells.values();
	}

	extent(sheet: number): { rows: number; cols: number } {
		return this.#store(sheet).extent();
	}

	/**
	 * Puts a cell as a file has it, with no calculation: the formula as stored and
	 * its cached value. Call `loaded` when every cell is in.
	 */
	load(
		sheet: number,
		row: number,
		col: number,
		content: { value: Scalar; formula?: string; style?: number; array?: Area }
	): Cell {
		const cell: Cell = { sheet, row, col, value: content.value, style: content.style ?? 0 };
		if (content.formula !== undefined) {
			cell.formula = this.#formula(content.formula, false);
			if (content.array) {
				cell.formula.array = content.array;
				this.#arrays.add(cell);
			}
		}
		this.#store(sheet).set(cell);
		return cell;
	}

	/**
	 * Builds the dependency graph once everything is loaded, and calculates the
	 * formulas whose file gave no value.
	 */
	loaded(uncached: Cell[] = []): void {
		for (const s of this.#sheets) {
			for (const c of s.cells.values()) {
				if (c.formula) {
					this.#classify(c.formula);
					this.#register(c);
				}
			}
		}
		const todo = uncached.filter((c) => c.formula?.status === 'ok');
		if (todo.length > 0) this.#recalc(todo, todo);
	}

	/** Changes one cell: a formula (without `=`), a value, or nothing (`null`) to clear it. */
	set(sheet: number, row: number, col: number, input: CellInput | null): Changes {
		return this.setMany([{ sheet, row, col, input }]);
	}

	setMany(edits: (CellRef & { input: CellInput | null })[]): Changes {
		const prepared = edits.map((e) => {
			this.#checkWritable(e.sheet, e.row, e.col);
			const formula =
				e.input && 'formula' in e.input ? this.#formula(e.input.formula, true) : undefined;
			return { ...e, formula };
		});
		const seeds: Cell[] = [];
		const formulas: Cell[] = [];
		for (const e of prepared) {
			const s = this.#store(e.sheet);
			let cell = s.cells.get(cellKey(e.row, e.col));
			if (cell) this.#unregister(cell);
			if (!cell) {
				cell = { sheet: e.sheet, row: e.row, col: e.col, value: null, style: 0 };
			}
			delete cell.cycle;
			delete cell.stale;
			if (e.formula) {
				cell.formula = e.formula;
				this.#register(cell);
				formulas.push(cell);
			} else {
				delete cell.formula;
				cell.value = e.input && 'value' in e.input ? e.input.value : null;
			}
			if (cell.value === null && !cell.formula && cell.style === 0) s.delete(e.row, e.col);
			else s.set(cell);
			seeds.push(cell);
		}
		const recalc = this.#recalc(seeds, formulas);
		return { cells: uniq([...seeds, ...recalc]).map(refOf) };
	}

	/** Sets the style a cell carries; a cell with neither content nor style is dropped. */
	setStyle(sheet: number, row: number, col: number, style: number): void {
		const s = this.#store(sheet);
		const cell = s.cells.get(cellKey(row, col));
		if (cell) {
			cell.style = style;
			if (cell.value === null && !cell.formula && style === 0) s.delete(row, col);
		} else if (style !== 0) {
			s.set({ sheet, row, col, value: null, style });
		}
	}

	/** Whether a cell may not be changed: an unsupported formula or part of an array formula. */
	readOnly(sheet: number, row: number, col: number): boolean {
		try {
			this.#checkWritable(sheet, row, col);
			return false;
		} catch {
			return true;
		}
	}

	/** The formula as a person reads it, with `=`; null for a value. */
	formulaText(cell: Cell): string | null {
		const f = cell.formula;
		if (!f) return null;
		return `=${f.ast ? print(f.ast, { mode: 'display' }) : f.text}`;
	}

	/** Calculates every formula this engine can, as Excel's full recalculation does. */
	recalc(): Changes {
		const all: Cell[] = [];
		for (const s of this.#sheets) for (const c of s.cells.values()) if (c.formula) all.push(c);
		return { cells: this.#recalc(all, all).map(refOf) };
	}

	/** How many cells are in a cycle, and how many unsupported formulas are out of date. */
	get health(): { cycles: number; stale: number } {
		let cycles = 0;
		let stale = 0;
		for (const s of this.#sheets) {
			for (const c of s.cells.values()) {
				if (c.cycle) cycles++;
				if (c.stale) stale++;
			}
		}
		return { cycles, stale };
	}

	// Rows and columns.

	insertRows(sheet: number, at: number, count: number): Changes {
		return this.#axis(sheet, 'row', at, count);
	}

	deleteRows(sheet: number, at: number, count: number): Changes {
		return this.#axis(sheet, 'row', at, -count);
	}

	insertCols(sheet: number, at: number, count: number): Changes {
		return this.#axis(sheet, 'col', at, count);
	}

	deleteCols(sheet: number, at: number, count: number): Changes {
		return this.#axis(sheet, 'col', at, -count);
	}

	#axis(sheet: number, axis: 'row' | 'col', at: number, count: number): Changes {
		const s = this.#store(sheet);
		const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
		if (count === 0 || at < 0 || at >= max) return { cells: [] };
		if (count < 0) count = -Math.min(-count, max - at);
		for (const c of this.#arrays) {
			const a = c.formula?.array;
			if (!a || c.sheet !== sheet) continue;
			const [lo, hi] = axis === 'row' ? [a.top, a.bottom] : [a.left, a.right];
			const end = at - count - 1;
			const splits =
				count > 0 ? at > lo && at <= hi : at <= hi && end >= lo && !(at <= lo && end >= hi);
			if (splits) throw new FormulaInputError('readonly', 'array formula');
		}
		if (count > 0) {
			const lastAt = axis === 'row' ? s.extent().rows : s.extent().cols;
			if (lastAt + count > max && lastAt > at) {
				throw new FormulaInputError('readonly', 'content would move off the sheet');
			}
		}
		const edit: AxisEdit = { sheet: s.name, axis, at, count };
		const kept: Cell[] = [];
		for (const c of s.cells.values()) {
			const pos = axis === 'row' ? c.row : c.col;
			if (count < 0 && pos >= at && pos < at - count) {
				this.#volatile.delete(c);
				this.#arrays.delete(c);
				continue;
			}
			if (pos >= at) {
				if (axis === 'row') c.row += count;
				else c.col += count;
			}
			kept.push(c);
		}
		s.rebuild(kept);
		const changed: Cell[] = [];
		this.#rewrite((ast, home) => shiftFormula(ast, edit, home), changed);
		for (const c of this.#arrays) {
			if (c.sheet !== sheet || !c.formula?.array) continue;
			const a = shiftArea(c.formula.array, axis, at, count);
			if (a) c.formula.array = a;
		}
		for (const n of this.names) {
			const ast = tryParse(n.text);
			const home = n.sheet === undefined ? '' : (this.#byId.get(n.sheet)?.name ?? '');
			if (!ast) continue;
			const next = shiftFormula(ast, edit, home);
			if (next !== ast) n.text = print(next);
		}
		this.#reindex();
		// Formulas reading the edited sheet may read other cells now, even when their
		// text did not change (a whole column after a row is deleted).
		const reading: Cell[] = [];
		for (const st of this.#sheets) {
			for (const c of st.cells.values()) {
				const ast = c.formula?.ast;
				if (!ast) continue;
				for (const n of walk(ast)) {
					if (
						(n.type === 'cell' || n.type === 'range') &&
						(n.sheet ?? this.#byId.get(c.sheet)?.name)?.toLowerCase() === s.name.toLowerCase()
					) {
						reading.push(c);
						break;
					}
				}
			}
		}
		const todo = uniq([...reading, ...changed]);
		const recalc = this.#recalc(todo, todo);
		return { cells: uniq([...changed, ...recalc]).map(refOf) };
	}

	// Internals.

	#store(id: number): SheetStore {
		const s = this.#byId.get(id);
		if (!s) throw new Error('no such sheet');
		return s;
	}

	#checkWritable(sheet: number, row: number, col: number) {
		const cell = this.cell(sheet, row, col);
		if (cell?.formula && cell.formula.status !== 'ok') {
			throw new FormulaInputError('readonly', cell.formula.missing.join(', '));
		}
		for (const a of this.#arrays) {
			if (a.sheet === sheet && a.formula?.array && contains(a.formula.array, row, col)) {
				throw new FormulaInputError('readonly', 'array formula');
			}
		}
	}

	/** A formula from a file (`strict` false) or typed in (`strict`, which refuses what cannot be calculated). */
	#formula(text: string, strict: boolean): Formula {
		let ast: Node | null = null;
		try {
			ast = parseFormula(text);
		} catch (e) {
			if (strict)
				throw new FormulaInputError('syntax', e instanceof FormulaSyntaxError ? e.message : '');
		}
		const f: Formula = {
			text: strict && ast ? print(ast) : text,
			ast,
			status: ast ? 'ok' : 'invalid',
			missing: [],
			volatile: false
		};
		if (strict && ast) {
			for (const n of walk(ast)) {
				if (n.type === 'call' && isSupported(n.name)) {
					const spec = FUNCTIONS[n.name];
					if (n.args.length < spec.min || n.args.length > spec.max) {
						throw new FormulaInputError('arity', n.name);
					}
				}
			}
			this.#classify(f);
			if (f.status !== 'ok') throw new FormulaInputError('unsupported', f.missing.join(', '));
		}
		return f;
	}

	#classify(f: Formula) {
		if (!f.ast) {
			f.status = 'invalid';
			return;
		}
		const missing = new Set<string>();
		let volatile = false;
		for (const n of walk(f.ast)) {
			if (n.type === 'call') {
				if (!isSupported(n.name)) missing.add(n.name);
				else if (FUNCTIONS[n.name].volatile) volatile = true;
			} else if (n.type === 'name') missing.add('named range');
			else if (n.type === 'array') missing.add('array constant');
			else if (
				(n.type === 'cell' || n.type === 'range') &&
				n.sheet !== undefined &&
				!this.sheetByName(n.sheet)
			) {
				missing.add('reference to another file or a missing sheet');
			}
		}
		if (f.array) missing.add('array formula');
		f.missing = [...missing];
		f.status = missing.size > 0 ? 'unsupported' : 'ok';
		f.volatile = volatile;
	}

	/** Applies a change to every formula's tree, keeping the text of those it leaves alone. */
	#rewrite(f: (ast: Node, home: string) => Node, changed: Cell[]) {
		for (const s of this.#sheets) {
			for (const c of s.cells.values()) {
				const fm = c.formula;
				if (!fm?.ast) continue;
				const next = f(fm.ast, s.name);
				if (next === fm.ast) continue;
				fm.ast = next;
				fm.text = print(next);
				changed.push(c);
			}
		}
	}

	#register(cell: Cell) {
		const f = cell.formula;
		if (!f) return;
		if (f.volatile) this.#volatile.add(cell);
		if (f.array) this.#arrays.add(cell);
		if (!f.ast) return;
		const home = this.#byId.get(cell.sheet)?.name ?? '';
		const deps: Deps = { cells: [], ranges: [] };
		for (const n of walk(f.ast)) {
			if (n.type !== 'cell' && n.type !== 'range') continue;
			const sheet = this.sheetByName(n.sheet ?? home)?.id;
			if (sheet === undefined) continue;
			if (n.type === 'cell') {
				const key = cellKey(n.row, n.col);
				let m = this.#cellDeps.get(sheet);
				if (!m) this.#cellDeps.set(sheet, (m = new Map()));
				let set = m.get(key);
				if (!set) m.set(key, (set = new Set()));
				set.add(cell);
				deps.cells.push([sheet, key]);
			} else {
				const dep: RangeDep = {
					cell,
					sheet,
					area: { top: n.top, left: n.left, bottom: n.bottom, right: n.right }
				};
				if (n.right - n.left + 1 > WIDE) {
					let set = this.#wideDeps.get(sheet);
					if (!set) this.#wideDeps.set(sheet, (set = new Set()));
					set.add(dep);
				} else {
					let m = this.#colDeps.get(sheet);
					if (!m) this.#colDeps.set(sheet, (m = new Map()));
					for (let col = n.left; col <= n.right; col++) {
						let set = m.get(col);
						if (!set) m.set(col, (set = new Set()));
						set.add(dep);
					}
				}
				deps.ranges.push(dep);
			}
		}
		cell.deps = deps;
	}

	#unregister(cell: Cell) {
		this.#volatile.delete(cell);
		this.#arrays.delete(cell);
		const d = cell.deps;
		if (!d) return;
		for (const [sheet, key] of d.cells) this.#cellDeps.get(sheet)?.get(key)?.delete(cell);
		for (const r of d.ranges) {
			this.#wideDeps.get(r.sheet)?.delete(r);
			const m = this.#colDeps.get(r.sheet);
			if (m && r.area.right - r.area.left + 1 <= WIDE) {
				for (let col = r.area.left; col <= r.area.right; col++) m.get(col)?.delete(r);
			}
		}
		delete cell.deps;
	}

	#reindex() {
		this.#cellDeps.clear();
		this.#colDeps.clear();
		this.#wideDeps.clear();
		this.#volatile.clear();
		this.#arrays.clear();
		for (const s of this.#sheets) {
			for (const c of s.cells.values()) {
				delete c.deps;
				if (c.formula) {
					this.#classify(c.formula);
					this.#register(c);
				}
			}
		}
	}

	#dependents(sheet: number, row: number, col: number): Cell[] {
		const out: Cell[] = [];
		const direct = this.#cellDeps.get(sheet)?.get(cellKey(row, col));
		if (direct) for (const c of direct) out.push(c);
		const bucket = this.#colDeps.get(sheet)?.get(col);
		if (bucket) for (const r of bucket) if (contains(r.area, row, col)) out.push(r.cell);
		const wide = this.#wideDeps.get(sheet);
		if (wide) for (const r of wide) if (contains(r.area, row, col)) out.push(r.cell);
		return out;
	}

	/**
	 * Recalculates what depends on `seeds`, and the formulas in `formulas`, in
	 * dependency order. Returns the cells whose value changed.
	 */
	#recalc(seeds: Cell[], formulas: Cell[]): Cell[] {
		const dirty = new Set<Cell>();
		const queue: Cell[] = [];
		const mark = (c: Cell) => {
			if (!dirty.has(c)) {
				dirty.add(c);
				queue.push(c);
			}
		};
		for (const c of formulas) if (c.formula) mark(c);
		for (const c of this.#volatile) mark(c);
		const seen = new Set<Cell>();
		const spread = (c: Cell) => {
			if (seen.has(c)) return;
			seen.add(c);
			for (const d of this.#dependents(c.sheet, c.row, c.col)) mark(d);
		};
		for (const c of seeds) spread(c);
		while (queue.length > 0) spread(queue.pop() as Cell);

		const succ = new Map<Cell, Cell[]>();
		const next = (c: Cell) => {
			let s = succ.get(c);
			if (!s) {
				s = this.#dependents(c.sheet, c.row, c.col).filter((d) => dirty.has(d));
				succ.set(c, s);
			}
			return s;
		};
		const order = tarjan(dirty, next);
		const changed: Cell[] = [];
		const ctx = this.#ctx;
		for (let k = order.length - 1; k >= 0; k--) {
			const group = order[k];
			const cyclic = group.length > 1 || next(group[0]).includes(group[0]);
			for (const c of group) {
				const f = c.formula;
				if (!f) continue;
				const before = c.value;
				if (f.status !== 'ok') {
					c.stale = true;
					continue;
				}
				if (cyclic) {
					c.value = err('#REF!');
					c.cycle = true;
				} else {
					delete c.cycle;
					ctx.sheet = c.sheet;
					ctx.row = c.row;
					ctx.col = c.col;
					c.value = evaluateFormula(f.ast as Node, ctx);
				}
				if (!sameValue(before, c.value)) changed.push(c);
			}
		}
		return changed;
	}
}

/** Strongly connected components, iteratively; the list is in reverse topological order. */
function tarjan(nodes: Set<Cell>, next: (c: Cell) => Cell[]): Cell[][] {
	const index = new Map<Cell, number>();
	const low = new Map<Cell, number>();
	const onStack = new Set<Cell>();
	const stack: Cell[] = [];
	const out: Cell[][] = [];
	let counter = 0;
	for (const root of nodes) {
		if (index.has(root)) continue;
		const work: { v: Cell; i: number }[] = [{ v: root, i: 0 }];
		index.set(root, counter);
		low.set(root, counter++);
		stack.push(root);
		onStack.add(root);
		while (work.length > 0) {
			const frame = work[work.length - 1];
			const succ = next(frame.v);
			if (frame.i < succ.length) {
				const w = succ[frame.i++];
				if (!index.has(w)) {
					index.set(w, counter);
					low.set(w, counter++);
					stack.push(w);
					onStack.add(w);
					work.push({ v: w, i: 0 });
				} else if (onStack.has(w)) {
					low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
				}
				continue;
			}
			work.pop();
			if (work.length > 0) {
				const parent = work[work.length - 1].v;
				low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
			}
			if (low.get(frame.v) === index.get(frame.v)) {
				const group: Cell[] = [];
				let w: Cell;
				do {
					w = stack.pop() as Cell;
					onStack.delete(w);
					group.push(w);
				} while (w !== frame.v);
				out.push(group);
			}
		}
	}
	return out;
}

function tryParse(text: string): Node | null {
	try {
		return parseFormula(text);
	} catch {
		return null;
	}
}

const refOf = (c: Cell): CellRef => ({ sheet: c.sheet, row: c.row, col: c.col });

function uniq(cells: Cell[]): Cell[] {
	return [...new Set(cells)];
}
