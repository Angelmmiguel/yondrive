/**
 * Text out of a file, on the device. Plain text formats are built in; anything else
 * plugs in here, as documents will. An extractor runs on bytes nobody has vouched
 * for, and what it returns is only ever split into words.
 */
import { inferType } from '$lib/drive/kinds';

export interface FileFacts {
	name: string;
	type: string;
	size: number;
}

export interface TextExtractor {
	accepts(type: string, file: FileFacts): boolean;
	extract(blob: Blob): Promise<string>;
}

/** A file over this stays searchable by its name and tags, and is not read for its text. */
export const TEXT_LIMIT = 4 * 1024 * 1024;

const PLAIN = /^text\/|^application\/(json|xml|yaml|x-yaml|xhtml\+xml|javascript)$/;

const plainText: TextExtractor = {
	accepts: (type) => PLAIN.test(type),
	extract: (blob) => blob.text()
};

const extractors: TextExtractor[] = [plainText];

/** Adds a format. The newest asked first, so that a richer one can take over. */
export function registerExtractor(extractor: TextExtractor): () => void {
	extractors.unshift(extractor);
	return () => {
		const at = extractors.indexOf(extractor);
		if (at >= 0) extractors.splice(at, 1);
	};
}

export function extractorFor(file: FileFacts): TextExtractor | null {
	if (file.size > TEXT_LIMIT) return null;
	const type = inferType(file.name, file.type);
	return extractors.find((extractor) => extractor.accepts(type, file)) ?? null;
}

/** The text of a file, or an empty string for one no extractor takes. */
export async function extractText(file: FileFacts, blob: Blob): Promise<string> {
	return (await extractorFor(file)?.extract(blob)) ?? '';
}
