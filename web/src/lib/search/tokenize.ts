/**
 * Words out of text, the same way for what is indexed and for what is typed.
 * Unicode aware: letters and digits of any script, lower case and without accents,
 * so that "cancion" finds "Canción". Scripts written without spaces index each
 * character as its own word.
 */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/** Beyond this a word is cut. Nobody searches for the rest of it. */
export const MAX_WORD = 64;

function fold(text: string): string {
	return text.normalize('NFKD').replace(MARKS, '').toLowerCase().normalize('NFC');
}

/** The words of a text, in order, with repeats. */
export function tokenize(text: string): string[] {
	const spaced = fold(text).replace(UNSPACED, ' $& ');
	return (spaced.match(WORD) ?? []).map((word) =>
		word.length > MAX_WORD ? word.slice(0, MAX_WORD) : word
	);
}

/** The distinct words of a text, at most `limit`, the first ones found. */
export function uniqueTokens(text: string, limit = Infinity): string[] {
	const seen = new Set<string>();
	for (const word of tokenize(text)) {
		if (seen.size >= limit) break;
		seen.add(word);
	}
	return [...seen];
}
