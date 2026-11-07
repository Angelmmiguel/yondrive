/**
 * What may be shown inside the app, and how. Metadata can be written by anyone who
 * could write to the node, so the name and the type both have to be harmless:
 * something whose extension or type says SVG or HTML is only ever downloaded,
 * because that could carry script, in this origin, next to the keys.
 */
import { extensionOf, inferType } from '../kinds';

export type ViewerKind = 'image' | 'text' | 'audio' | 'video' | 'pdf';

const ACTIVE_TYPES =
	/^(image\/svg|text\/html|application\/xhtml|application\/xml-dtd|text\/xsl|application\/xslt)/i;
const ACTIVE_EXTENSIONS = new Set([
	'svg',
	'svgz',
	'html',
	'htm',
	'xhtml',
	'xht',
	'shtml',
	'mht',
	'mhtml',
	'hta',
	'xsl',
	'xslt'
]);

const IMAGES: Record<string, string> = {
	'image/jpeg': 'image/jpeg',
	'image/png': 'image/png',
	'image/gif': 'image/gif',
	'image/webp': 'image/webp',
	'image/avif': 'image/avif',
	'image/bmp': 'image/bmp'
};

const TEXT_TYPES = new Set([
	'application/json',
	'application/xml',
	'application/x-yaml',
	'application/yaml',
	'application/javascript',
	'application/x-sh',
	'application/toml'
]);

const TEXT_EXTENSIONS = new Set([
	'txt',
	'md',
	'markdown',
	'csv',
	'tsv',
	'log',
	'json',
	'xml',
	'yaml',
	'yml',
	'toml',
	'ini',
	'conf',
	'js',
	'ts',
	'css',
	'go',
	'py',
	'rs',
	'c',
	'h',
	'sh',
	'sql'
]);

/** What fits in memory for a viewer that has to read the whole file. */
export const VIEW_LIMITS: Record<'image' | 'text' | 'pdf', number> = {
	image: 256 * 1024 * 1024,
	text: 4 * 1024 * 1024,
	pdf: 512 * 1024 * 1024
};

export function isDownloadOnly(file: { name: string; type: string }): boolean {
	return ACTIVE_EXTENSIONS.has(extensionOf(file.name)) || ACTIVE_TYPES.test(file.type);
}

/** The viewer of this file, or null if it can only be downloaded. */
export function viewerFor(file: { name: string; type: string }): ViewerKind | null {
	if (isDownloadOnly(file)) return null;
	const type = inferType(file.name, file.type).toLowerCase();
	if (Object.hasOwn(IMAGES, type)) return 'image';
	if (type === 'application/pdf') return 'pdf';
	if (type.startsWith('audio/')) return 'audio';
	if (type.startsWith('video/')) return 'video';
	if (type.startsWith('text/') || TEXT_TYPES.has(type)) return 'text';
	return TEXT_EXTENSIONS.has(extensionOf(file.name)) ? 'text' : null;
}

/** The type an image blob is built with: only ever one of the safe ones. */
export function safeImageType(file: { name: string; type: string }): string {
	const type = inferType(file.name, file.type).toLowerCase();
	return Object.hasOwn(IMAGES, type) ? IMAGES[type] : 'application/octet-stream';
}

/** Decodes text for the viewer. Bytes that are not UTF-8 show as replacement characters. */
export function decodeText(bytes: Uint8Array): string {
	return new TextDecoder('utf-8').decode(bytes);
}
