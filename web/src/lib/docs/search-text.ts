/**
 * Documents in search: their text, read on the device in the formats worker,
 * through the search plug-in point. Called with bytes alone, so the format is
 * told from the bytes, never from a name.
 */
import { registerExtractor } from '$lib/search/extract';
import { formatOf, type DocFormat } from '$lib/formats/document';
import { plainText } from '$lib/formats/model';
import { createFormats, type Formats } from './formats-client';

/** The format bytes are in, for those that are not plain text. */
export function sniffFormat(head: Uint8Array): DocFormat | null {
	const ascii = new TextDecoder('latin1').decode(head.subarray(0, 512));
	if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'doc';
	if (ascii.startsWith('{\\rtf')) return 'rtf';
	if (ascii.startsWith('PK\u0003\u0004')) {
		if (ascii.includes('mimetypeapplication/vnd.oasis.opendocument.text')) return 'odt';
		return 'docx';
	}
	return null;
}

const RICH = new Set<DocFormat>(['docx', 'odt', 'rtf', 'doc']);

export function registerDocumentText(formats: Pick<Formats, 'read'> = createFormats()): () => void {
	return registerExtractor({
		accepts: (_type, file) => {
			const f = formatOf(file.name);
			return f !== null && RICH.has(f);
		},
		async extract(blob) {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const format = sniffFormat(bytes);
			if (format === null) return '';
			const { model } = await formats.read(bytes, format);
			return plainText(model);
		}
	});
}
