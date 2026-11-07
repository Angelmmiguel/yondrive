/**
 * What a file is, from its name and the type the browser reported. Sniffing the
 * bytes would be no better for files other people made, and the viewers and the
 * download headers do not rely on this for safety: see `viewers/kinds.ts`.
 */
import type { FileKind } from '$lib/components';

const TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	heic: 'image/heic',
	heif: 'image/heif',
	pdf: 'application/pdf',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	ogv: 'video/ogg',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	wav: 'audio/wav',
	flac: 'audio/flac',
	txt: 'text/plain',
	md: 'text/markdown',
	markdown: 'text/markdown',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	log: 'text/plain',
	json: 'application/json',
	xml: 'application/xml',
	yaml: 'text/yaml',
	yml: 'text/yaml',
	html: 'text/html',
	htm: 'text/html',
	xhtml: 'application/xhtml+xml',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	doc: 'application/msword',
	odt: 'application/vnd.oasis.opendocument.text',
	rtf: 'application/rtf',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	xls: 'application/vnd.ms-excel',
	ods: 'application/vnd.oasis.opendocument.spreadsheet'
};

/** The lowercase extension of a name, or nothing. */
export function extensionOf(name: string): string {
	const at = name.lastIndexOf('.');
	return at <= 0 ? '' : name.slice(at + 1).toLowerCase();
}

/** The type reported for a file, or the one its extension suggests. */
export function inferType(name: string, reported: string): string {
	const known = TYPES[extensionOf(name)];
	if (reported !== '' && reported !== 'application/octet-stream') return reported;
	return known ?? 'application/octet-stream';
}

/** What a file is drawn as. */
export function fileKindOf(node: {
	kind: 'file' | 'folder';
	name: string;
	type: string;
}): FileKind {
	if (node.kind === 'folder') return 'folder';
	const type = inferType(node.name, node.type);
	if (type.startsWith('image/')) return 'image';
	if (type.startsWith('video/')) return 'video';
	if (type === 'application/pdf') return 'pdf';
	if (type === 'text/markdown') return 'note';
	if (/spreadsheet|ms-excel|text\/csv|tab-separated/.test(type)) return 'sheet';
	if (/wordprocessing|msword|opendocument\.text|application\/rtf|^text\//.test(type)) return 'doc';
	return 'other';
}

export type Category = 'images' | 'video' | 'documents' | 'other';

/** Which part of the storage bar a file counts in. */
export function categoryOf(node: {
	kind: 'file' | 'folder';
	name: string;
	type: string;
}): Category {
	switch (fileKindOf(node)) {
		case 'image':
			return 'images';
		case 'video':
			return 'video';
		case 'doc':
		case 'sheet':
		case 'note':
		case 'pdf':
			return 'documents';
		default:
			return 'other';
	}
}
