import { plainText, type Block } from '$lib/formats/model';

/** Words in a document: runs of non-space characters that hold a letter or a digit. */
export function countWords(blocks: readonly Block[]): number {
	return plainText({ blocks: [...blocks] })
		.split(/\s+/)
		.filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
