/**
 * What a file opens as, from its name or its first bytes. Kept apart from the
 * readers and writers so that the page can ask without loading them: they run
 * in workers, and only the editors' routes bring them in.
 */
import type { DocFormat } from './document';
import type { SheetFormat } from './workbook';

const DOC_EXTENSIONS: Record<string, DocFormat> = {
	docx: 'docx',
	odt: 'odt',
	rtf: 'rtf',
	md: 'md',
	markdown: 'md',
	txt: 'txt',
	doc: 'doc'
};

const SHEET_EXTENSIONS: Record<string, SheetFormat> = {
	xlsx: 'xlsx',
	xlsm: 'xlsx',
	ods: 'ods',
	csv: 'csv',
	tsv: 'tsv',
	tab: 'tsv',
	xls: 'xls'
};

const extension = (name: string) => {
	const at = name.lastIndexOf('.');
	return at <= 0 ? null : name.slice(at + 1).toLowerCase();
};

/** The format a file opens as in the editor, from its name; null if it does not. */
export function formatOf(name: string): DocFormat | null {
	const ext = extension(name);
	return ext === null ? null : (DOC_EXTENSIONS[ext] ?? null);
}

/** The format a file opens as in the spreadsheet editor, from its name; null if it does not. */
export function sheetFormatOf(name: string): SheetFormat | null {
	const ext = extension(name);
	return ext === null ? null : (SHEET_EXTENSIONS[ext] ?? null);
}

/** The format bytes are in, for those that need no name to tell: null for text. */
export function sniffSheetFormat(head: Uint8Array): 'xlsx' | 'ods' | 'xls' | null {
	if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'xls';
	const ascii = new TextDecoder('latin1').decode(head.subarray(0, 512));
	if (ascii.startsWith('PK\u0003\u0004')) {
		return ascii.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')
			? 'ods'
			: 'xlsx';
	}
	return null;
}
