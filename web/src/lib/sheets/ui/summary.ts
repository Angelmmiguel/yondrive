/**
 * What the status bar says about a selection, and the view's filter: the rows
 * a column's chosen values hide. A filter only changes what is shown here; the
 * file is saved without it.
 */
import type { Scalar } from '$lib/formula/values';

export interface Stats {
	/** Cells with anything in them. */
	count: number;
	/** Cells with numbers. */
	numbers: number;
	sum: number;
	average: number | null;
}

export function statsOf(values: Iterable<Scalar>): Stats {
	let count = 0;
	let numbers = 0;
	let sum = 0;
	for (const v of values) {
		if (v === null || v === '') continue;
		count++;
		if (typeof v === 'number') {
			numbers++;
			sum += v;
		}
	}
	return { count, numbers, sum, average: numbers > 0 ? sum / numbers : null };
}

/** How a number reads in the status bar: up to 10 significant digits, grouped. */
export function statNumber(n: number): string {
	if (!Number.isFinite(n)) return '—';
	return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 10 }).format(n);
}

export const BLANK = '';

/** A column filter: the values to hide, by the text each cell shows. */
export interface ColumnFilter {
	col: number;
	hidden: Set<string>;
}

export interface Filter {
	/** The header row: the filter applies to the rows below it. */
	header: number;
	columns: ColumnFilter[];
}

/** The values of a column over rows `first`..`last`, each once, in order, blanks last. */
export function distinctValues(
	texts: ReadonlyMap<number, string>,
	first: number,
	last: number
): string[] {
	const set = new Set<string>();
	let shown = 0;
	let blank = false;
	for (const [r, t] of texts) {
		if (r < first || r > last) continue;
		shown++;
		if (t === BLANK) blank = true;
		else set.add(t);
	}
	if (shown < last - first + 1) blank = true;
	const list = [...set].sort((a, b) => {
		const na = Number(a.replace(/[,$%\s]/g, ''));
		const nb = Number(b.replace(/[,$%\s]/g, ''));
		if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
		return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
	});
	if (blank) list.push(BLANK);
	return list;
}

/**
 * The rows a filter hides, among `first`..`last`. `texts(col)` gives what each
 * row of a column shows; rows it leaves out are blank.
 */
export function hiddenRows(
	filter: Filter,
	last: number,
	texts: (col: number) => ReadonlyMap<number, string>
): Set<number> {
	const out = new Set<number>();
	for (const cf of filter.columns) {
		if (cf.hidden.size === 0) continue;
		const t = texts(cf.col);
		for (let r = filter.header + 1; r <= last; r++) {
			if (cf.hidden.has(t.get(r) ?? BLANK)) out.add(r);
		}
	}
	return out;
}

/** What each row of a column shows, from the cells a window gave. */
export function textsByRow(cells: readonly { row: number; text: string }[]): Map<number, string> {
	return new Map(cells.map((c) => [c.row, c.text]));
}

/** A set with one value in or out. */
export function toggled<T>(set: ReadonlySet<T>, value: T, inside: boolean): Set<T> {
	const next = new Set(set);
	if (inside) next.add(value);
	else next.delete(value);
	return next;
}

/** A new set of these values. */
export const setOf = <T>(values: Iterable<T>): Set<T> => new Set(values);
