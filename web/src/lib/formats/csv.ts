/**
 * `.csv` and `.tsv` (RFC 4180): one sheet of values. Quoted fields may hold the
 * delimiter, quotes and line breaks. A comma file whose lines split more evenly
 * on semicolons is read with semicolons, as spreadsheets in many locales write
 * them. A field is a number only when it reads back exactly as written, so
 * `007` and `1,5` stay text; a field starting with `=` is text too, never a
 * formula. Saving writes the current sheet: records that did not change are
 * copied as they were, in the original's line ending and byte order mark.
 */
import { Engine } from '$lib/formula/engine';
import { numberToText, isError, sameValue, type Scalar } from '$lib/formula/values';
import { Tally } from './model';
import { decodeText } from './txt';
import { Book, type OpenedSheets } from './workbook';

export const CSV_LIMITS = { size: 64 * 1024 * 1024, cells: 2_000_000, field: 32767 };

export class CsvError extends Error {}

interface CsvRecord {
	fields: string[];
	/** Offsets of the record in the text, its line break included. */
	start: number;
	end: number;
}

/** Splits text into records of fields, keeping each record's source span. */
export function parseCsv(text: string, delimiter: string): CsvRecord[] {
	const out: CsvRecord[] = [];
	let i = 0;
	let cells = 0;
	while (i < text.length) {
		const start = i;
		const fields: string[] = [];
		for (;;) {
			let field = '';
			if (text[i] === '"') {
				i++;
				for (;;) {
					const j = text.indexOf('"', i);
					if (j < 0) {
						field += text.slice(i);
						i = text.length;
						break;
					}
					field += text.slice(i, j);
					i = j + 1;
					if (text[i] === '"') {
						field += '"';
						i++;
					} else break;
				}
				// Anything between the closing quote and the delimiter is kept, as readers do.
				while (i < text.length && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r')
					field += text[i++];
			} else {
				while (i < text.length && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r')
					field += text[i++];
			}
			if (field.length > CSV_LIMITS.field) throw new CsvError('field too long');
			fields.push(field);
			if (++cells > CSV_LIMITS.cells) throw new CsvError('too many cells');
			if (text[i] === delimiter) {
				i++;
				continue;
			}
			break;
		}
		if (text[i] === '\r') i++;
		if (text[i] === '\n') i++;
		out.push({ fields, start, end: i });
	}
	return out;
}

/** The delimiter a comma file uses: the one that splits its first lines most evenly. */
export function sniffDelimiter(text: string): string {
	const lines = text.split(/\r?\n/, 20).filter((l) => l !== '');
	let best = ',';
	let bestScore = 0;
	for (const d of [',', ';', '\t']) {
		const counts = lines.map((l) => l.split(d).length - 1);
		if (counts.length === 0 || counts[0] === 0) continue;
		const same = counts.filter((c) => c === counts[0]).length;
		const score = same * 1000 + counts[0];
		if (score > bestScore) {
			best = d;
			bestScore = score;
		}
	}
	return best;
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** A field as a value: a number when it reads back exactly as written, else text. */
export function fieldValue(f: string): Scalar {
	if (f === '') return null;
	if (NUMBER.test(f)) {
		const n = Number(f);
		if (Number.isFinite(n) && (numberToText(n) === f || String(n) === f)) return n;
	}
	return f;
}

export function readCsv(bytes: Uint8Array, delimiter?: string): OpenedSheets {
	if (bytes.length > CSV_LIMITS.size) throw new CsvError('too large');
	const { text, encoding } = decodeText(bytes);
	const d = delimiter ?? sniffDelimiter(text);
	const engine = new Engine();
	const book = new Book(engine, [], { format: d === '\t' ? 'tsv' : 'csv', styles: 1, sheets: 1 });
	const info = book.addSheet('Sheet1', undefined, 0);
	parseCsv(text, d).forEach((r, row) => {
		r.fields.forEach((f, col) => {
			const value = fieldValue(f);
			if (value !== null) engine.load(info.id, row, col, { value });
		});
	});
	engine.loaded();
	const tally = new Tally();
	if (encoding !== 'utf-8')
		tally.add(`Saved as UTF-8 rather than ${encoding.toUpperCase()}`, 'changed');
	return { book, census: tally.census(), fixedRanges: [] };
}

function quote(s: string, d: string): string {
	return s.includes(d) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The text a cell is saved as: full precision for plain numbers, the shown text for formatted ones. */
function fieldOf(book: Book, sheet: number, row: number, col: number): string {
	const c = book.engine.cell(sheet, row, col);
	if (!c || c.value === null) return '';
	const fmt = book.styles[c.style]?.numFmt ?? 'General';
	if (typeof c.value === 'number' && fmt === 'General') return numberToText(c.value);
	if (isError(c.value)) return c.value.error;
	return book.display(c);
}

/**
 * Writes one sheet. Given the file it came from, records that did not change are
 * copied as they were.
 */
export function writeCsv(
	book: Book,
	sheet: number,
	delimiter: string,
	original?: Uint8Array
): Uint8Array {
	const decoded = original ? decodeText(original) : null;
	const eol = decoded
		? /\r\n/.test(decoded.text)
			? '\r\n'
			: /\n/.test(decoded.text)
				? '\n'
				: '\r\n'
		: '\r\n';
	const ext = book.engine.extent(sheet);
	const info = book.sheet(sheet);
	const same =
		decoded !== null &&
		(book.source.format === 'csv' || book.source.format === 'tsv') &&
		info.origin === 0 &&
		info.steps.length === 0;
	const records = same ? parseCsv(decoded.text, delimiter) : [];
	let out = '';
	const rows = Math.max(ext.rows, same ? records.length : 0);
	for (let r = 0; r < rows; r++) {
		const fields: string[] = [];
		for (let c = 0; c < ext.cols; c++) fields.push(fieldOf(book, sheet, r, c));
		while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
		const rec = records[r];
		if (rec && decoded) {
			const values = rec.fields.map(fieldValue);
			const now = Array.from({ length: Math.max(values.length, fields.length) }, (_, c) => {
				const cell = book.engine.cell(sheet, r, c);
				return cell?.value ?? null;
			});
			const unchanged =
				now.every((v, c) => sameValue(values[c] ?? null, v)) &&
				!now.some((_, c) => book.engine.cell(sheet, r, c)?.formula);
			if (unchanged) {
				const text = decoded.text.slice(rec.start, rec.end);
				out += /[\r\n]$/.test(text) || r === rows - 1 ? text : text + eol;
				continue;
			}
		}
		out += fields.map((f) => quote(f, delimiter)).join(delimiter);
		if (r < rows - 1 || !decoded || /[\r\n]$/.test(decoded.text)) out += eol;
	}
	const bytes = new TextEncoder().encode(out);
	if (decoded?.bom && decoded.encoding === 'utf-8') {
		const withBom = new Uint8Array(bytes.length + 3);
		withBom.set([0xef, 0xbb, 0xbf]);
		withBom.set(bytes, 3);
		return withBom;
	}
	return bytes;
}
