/**
 * Ranges on the clipboard as other spreadsheets put them there: tab-separated
 * text, a field quoted when it holds a tab, a newline or a quote. A pasted HTML
 * table is read for its text only; nothing of it is ever drawn.
 */

import type { Area } from '$lib/formula/address';
import { print } from '$lib/formula/ast';
import { parseFormula } from '$lib/formula/parse';
import { translateFormula } from '$lib/formula/shift';

const NEEDS_QUOTES = /[\t\n\r"]/;

/** What was last copied or cut in a grid, to paste its formulas rather than their values. */
export interface Copied {
	tsv: string;
	raw: string[][];
	origin: { row: number; col: number };
	area: Area;
	/** The file and sheet it came from: sheet ids repeat from one workbook to the next. */
	file: string;
	sheet: number;
	cut: boolean;
}

/**
 * Whether a paste is of what was copied here: into the same sheet of the same
 * file, with the system clipboard still holding it (or nothing readable).
 */
export function isOwnCopy(
	c: Copied | null,
	into: { file: string; sheet: number },
	text: string,
	html: string
): c is Copied {
	return (
		c !== null &&
		c.file === into.file &&
		c.sheet === into.sheet &&
		(text === c.tsv || (text === '' && html === ''))
	);
}

export function toTsv(rows: readonly (readonly string[])[]): string {
	return rows
		.map((r) => r.map((f) => (NEEDS_QUOTES.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join('\t'))
		.join('\n');
}

/** Tab-separated text as rows of fields; a trailing newline adds no row. */
export function parseTsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let i = 0;
	let quoted = false;
	let atStart = true;
	const s = text.replace(/\r\n?/g, '\n');
	while (i < s.length) {
		const ch = s[i];
		if (quoted) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && atStart) {
			// Quoted only when the closing quote ends the field.
			const close = closingQuote(s, i + 1);
			if (close !== -1) {
				quoted = true;
				atStart = false;
				i++;
				continue;
			}
		}
		atStart = false;
		if (ch === '\t') {
			row.push(field);
			field = '';
			atStart = true;
		} else if (ch === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			atStart = true;
		} else field += ch;
		i++;
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** Where a quoted field starting at `from` closes, if the quote is followed by a tab, a newline or the end. */
function closingQuote(s: string, from: number): number {
	for (let i = from; i < s.length; i++) {
		if (s[i] !== '"') continue;
		if (s[i + 1] === '"') {
			i++;
			continue;
		}
		const after = s[i + 1];
		return after === undefined || after === '\t' || after === '\n' ? i : -1;
	}
	return -1;
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/** The text of the first table in some HTML, as rows of cells; null if it has none. */
export function htmlTableRows(html: string): string[][] | null {
	const start = html.search(/<table[\s>]/i);
	if (start < 0) return null;
	const end = html.search(/<\/table\s*>/i);
	const body = html.slice(start, end > start ? end : undefined);
	const clean = body.replace(/<!--[^]*?-->/g, '').replace(/<(style|script)[^]*?<\/\1\s*>/gi, '');
	const rows: string[][] = [];
	for (const tr of clean.matchAll(/<tr\b[^>]*>([^]*?)(?=<\/tr\s*>|<tr\b|$)/gi)) {
		const cells: string[] = [];
		for (const td of tr[1].matchAll(/<t[dh]\b[^>]*>([^]*?)(?=<\/t[dh]\s*>|<t[dh]\b|$)/gi)) {
			const text = td[1]
				.replace(/\s+/g, ' ')
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/<[^>]*>/g, '');
			cells.push(
				decodeEntities(text)
					.split('\n')
					.map((l) => l.trim())
					.join('\n')
			);
		}
		if (cells.length > 0) rows.push(cells);
	}
	return rows.length > 0 ? rows : null;
}

/** A formula copied from one cell to another, its relative references moved as far; as it was if it does not parse. */
export function shiftFormulaText(text: string, rows: number, cols: number): string {
	if (!text.startsWith('=') || (rows === 0 && cols === 0)) return text;
	try {
		return `=${print(translateFormula(parseFormula(text.slice(1)), rows, cols))}`;
	} catch {
		return text;
	}
}
