/**
 * One entry point for every spreadsheet format, as `document.ts` is for
 * documents: what a name opens as, reading bytes into the workbook model,
 * writing it back (into the original where the format allows), and the notice
 * that says what a file holds beyond what is edited. Pure, so it runs the same
 * in a worker.
 */
import { readCsv, sniffDelimiter, writeCsv } from './csv';
import type { Census } from './model';
import { readOds, writeOds } from './ods';
import { decodeText } from './txt';
import type { Book, OpenedSheets, SheetFormat } from './workbook';
import { readXls } from './xls';
import { readXlsx, writeXlsx } from './xlsx';

export { sheetFormatOf, sniffSheetFormat } from './names';

export type { SheetFormat };
/** What can be written: everything but `.xls`, which is read only. */
export type SheetSaveFormat = Exclude<SheetFormat, 'xls'>;

export const SHEET_MIME: Record<SheetSaveFormat, string> = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values'
};

export const SHEET_FORMAT_NAMES: Record<SheetFormat, string> = {
	xlsx: 'Excel workbook',
	ods: 'OpenDocument spreadsheet',
	csv: 'Comma-separated values',
	tsv: 'Tab-separated values',
	xls: 'Excel 97–2003 workbook'
};

/** Where a format is saved: `.xls` becomes `.xlsx`. */
export const sheetSaveFormatOf = (f: SheetFormat): SheetSaveFormat => (f === 'xls' ? 'xlsx' : f);

/** A name with its extension changed to that of a format. */
export function renameSheetFile(name: string, f: SheetSaveFormat): string {
	const at = name.lastIndexOf('.');
	return `${at > 0 ? name.slice(0, at) : name}.${f}`;
}

export async function readSpreadsheet(
	bytes: Uint8Array,
	format: SheetFormat
): Promise<OpenedSheets> {
	switch (format) {
		case 'xlsx':
			return readXlsx(bytes);
		case 'ods':
			return readOds(bytes);
		case 'csv':
			return readCsv(bytes);
		case 'tsv':
			return readCsv(bytes, '\t');
		case 'xls':
			return readXls(bytes);
	}
}

/**
 * Writes the workbook. Given the original in the same format, it writes into it
 * and keeps what did not change; otherwise it writes a new file. CSV and TSV hold
 * one sheet: `sheet` says which, by engine id, the first by default.
 */
export async function writeSpreadsheet(
	format: SheetSaveFormat,
	book: Book,
	opts: { original?: { bytes: Uint8Array; format: SheetFormat }; sheet?: number } = {}
): Promise<Uint8Array> {
	const base = opts.original?.format === format ? opts.original.bytes : undefined;
	switch (format) {
		case 'xlsx':
			return writeXlsx(book, base);
		case 'ods':
			return writeOds(book, base);
		case 'csv':
		case 'tsv': {
			const sheet = opts.sheet ?? book.ordered()[0]?.id;
			if (sheet === undefined) return new Uint8Array(0);
			// The delimiter a comma file was read with is kept: semicolons stay semicolons.
			const delimiter =
				format === 'tsv' ? '\t' : base ? sniffDelimiter(decodeText(base).text) : ',';
			return writeCsv(book, sheet, delimiter, base);
		}
	}
}

/** What saving to another format leaves behind, for the warning before it. */
export function lostOnSave(book: Book, to: SheetSaveFormat): string[] {
	const out: string[] = [];
	if (to === 'csv' || to === 'tsv') {
		if (book.sheets.length > 1) out.push('Every sheet but the current one');
		let formulas = false;
		let styled = false;
		for (const s of book.sheets) {
			for (const c of book.engine.cells(s.id)) {
				if (c.formula) formulas = true;
				if (c.style !== 0) styled = true;
			}
			if (s.merges.length > 0 || s.cols.length > 0) styled = true;
		}
		if (formulas) out.push('Formulas, which are saved as their values');
		if (styled) out.push('Formatting, merged cells and column widths');
	} else if (book.source.format === 'xlsx' || book.source.format === 'ods') {
		out.push('What the editor does not show, such as charts, pictures, comments and macros');
	}
	return out;
}

export interface SheetNotice {
	/** What happens to the file on save. */
	summary: string;
	/** One line for each way things are handled, if anything is. */
	lines: string[];
}

function list(items: Census['items']): string {
	return items
		.map(
			(i) =>
				`${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}${i.count > 1 ? ` (${i.count})` : ''}`
		)
		.join(', ');
}

/** The notice above the grid: generated from what this file holds. */
export function sheetNoticeOf(format: SheetFormat, census: Census): SheetNotice {
	const summary = {
		xlsx: 'Opened from .xlsx. Changes are saved back as .xlsx, and cells and parts that were not edited stay as they were.',
		ods: 'Opened from .ods. Changes are saved back as .ods, and cells that were not edited stay as they were.',
		csv: 'Comma-separated values: one sheet of values. Formulas and formatting are not kept in this format.',
		tsv: 'Tab-separated values: one sheet of values. Formulas and formatting are not kept in this format.',
		xls: 'Opened from .xls, read as well as it can be. Saving converts it to .xlsx, and the original stays in Versions.'
	}[format];
	const by = (h: string) => census.items.filter((i) => i.handling === h);
	const lines: string[] = [];
	const locked = by('locked');
	if (locked.length > 0) {
		lines.push(
			`Shown with the value the file had, not editable here, and kept as it was: ${list(locked)}.`
		);
	}
	const kept = by('kept');
	if (kept.length > 0) lines.push(`Kept in the file but not shown: ${list(kept)}.`);
	const lost = by('lost');
	if (lost.length > 0) lines.push(`Not carried over when saved: ${list(lost)}.`);
	for (const c of by('changed')) lines.push(`${c.label}.`);
	return { summary, lines };
}
