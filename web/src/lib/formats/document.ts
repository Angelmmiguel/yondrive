/**
 * One entry point for every document format: what a name opens as, reading
 * bytes into the model, writing it back (into the original where the format
 * allows), what each format can hold, and the notice that says what a file
 * contains beyond what is edited. Pure, so it runs the same in a worker.
 */
import { readDoc } from './doc';
import { readDocx, writeDocx } from './docx';
import { readMarkdown, writeMarkdown } from './markdown';
import { type Block, type BlockStyle, type Census, type DocModel, type Marks } from './model';
import { readOdt, writeOdt } from './odf';
import { readRtf, writeRtf } from './rtf';
import { readText, writeText, decodeText } from './txt';

export { formatOf } from './names';

export type DocFormat = 'docx' | 'odt' | 'rtf' | 'md' | 'txt' | 'doc';
/** What can be written: everything but `.doc`, which is read only. */
export type SaveFormat = Exclude<DocFormat, 'doc'>;

export const MIME: Record<SaveFormat, string> = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	odt: 'application/vnd.oasis.opendocument.text',
	rtf: 'application/rtf',
	md: 'text/markdown',
	txt: 'text/plain'
};

export const FORMAT_NAMES: Record<DocFormat, string> = {
	docx: 'Word document',
	odt: 'OpenDocument text',
	rtf: 'Rich text',
	md: 'Markdown',
	txt: 'Plain text',
	doc: 'Word 97–2003 document'
};

/** Where a format is saved: `.doc` becomes `.docx`. */
export const saveFormatOf = (f: DocFormat): SaveFormat => (f === 'doc' ? 'docx' : f);

/** A name with its extension changed to that of a format. */
export function renameTo(name: string, f: SaveFormat): string {
	const at = name.lastIndexOf('.');
	return `${at > 0 ? name.slice(0, at) : name}.${f}`;
}

/** What the editor may offer for a format: anything else could not be saved. */
export interface Caps {
	marks: ReadonlySet<keyof Marks>;
	styles: ReadonlySet<BlockStyle>;
	align: boolean;
	lists: boolean;
	tables: boolean;
	images: boolean;
}

const ALL_MARKS = new Set<keyof Marks>([
	'bold',
	'italic',
	'underline',
	'strike',
	'script',
	'code',
	'font',
	'size',
	'color',
	'highlight',
	'link'
]);
const ALL_STYLES = new Set<BlockStyle>([
	'normal',
	'title',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'quote',
	'code'
]);
const RICH: Caps = {
	marks: ALL_MARKS,
	styles: ALL_STYLES,
	align: true,
	lists: true,
	tables: true,
	images: true
};

export const CAPS: Record<DocFormat, Caps> = {
	docx: RICH,
	odt: RICH,
	rtf: RICH,
	doc: RICH,
	md: {
		marks: new Set(['bold', 'italic', 'strike', 'code', 'link']),
		styles: new Set(['normal', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'code']),
		align: false,
		lists: true,
		tables: true,
		images: false
	},
	txt: {
		marks: new Set(),
		styles: new Set(['normal']),
		align: false,
		lists: false,
		tables: false,
		images: false
	}
};

export interface Opened {
	model: DocModel;
	census: Census;
}

export async function readDocument(bytes: Uint8Array, format: DocFormat): Promise<Opened> {
	switch (format) {
		case 'docx':
			return readDocx(bytes);
		case 'odt':
			return readOdt(bytes);
		case 'rtf':
			return readRtf(bytes);
		case 'md':
			return readMarkdown(decodeText(bytes).text);
		case 'txt':
			return readText(bytes);
		case 'doc':
			return readDoc(bytes);
	}
}

/**
 * Writes the model. Given the original in the same format, it writes into it and
 * keeps what did not change; otherwise it writes a fresh file.
 */
export async function writeDocument(
	format: SaveFormat,
	model: DocModel,
	original?: { bytes: Uint8Array; format: DocFormat }
): Promise<Uint8Array> {
	const base = original?.format === format ? original.bytes : undefined;
	switch (format) {
		case 'docx':
			return writeDocx(model, base);
		case 'odt':
			return writeOdt(model, base);
		case 'rtf':
			return writeRtf(model);
		case 'md': {
			const text = writeMarkdown(model, base === undefined ? undefined : decodeText(base).text);
			return new TextEncoder().encode(text);
		}
		case 'txt':
			return writeText(model, base);
	}
}

/** Whether saving to another format would drop locked content. */
export const hasLocked = (model: DocModel): boolean => {
	const walk = (blocks: readonly Block[]): boolean => blocks.some((b) => b.type === 'locked');
	return walk(model.blocks);
};

export interface Notice {
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

/** The notice above the editor: generated from what this file holds. */
export function noticeOf(format: DocFormat, census: Census): Notice {
	const summary = {
		docx: 'Opened from .docx. Changes are saved back as .docx, and what was not edited stays exactly as it was.',
		odt: 'Opened from .odt. Changes are saved back as .odt, and what was not edited stays exactly as it was.',
		rtf: 'Opened from .rtf. Changes are saved back as .rtf, which rewrites the whole file.',
		md: 'Opened from Markdown. Changes are saved back as Markdown, and blocks that were not edited stay exactly as they were.',
		txt: 'Plain text. Formatting is not available, and lines are saved as they are.',
		doc: 'Opened from .doc, read as well as it can be. Saving converts it to .docx, and the original stays in Versions.'
	}[format];
	const by = (h: string) => census.items.filter((i) => i.handling === h);
	const lines: string[] = [];
	const locked = by('locked');
	if (locked.length > 0)
		lines.push(`Shown but not editable here, and kept as it was: ${list(locked)}.`);
	const kept = by('kept');
	if (kept.length > 0) lines.push(`Kept in the file but not shown: ${list(kept)}.`);
	const lost = by('lost');
	if (lost.length > 0) lines.push(`Not carried over when saved: ${list(lost)}.`);
	for (const c of by('changed')) lines.push(`${c.label}.`);
	return { summary, lines };
}
