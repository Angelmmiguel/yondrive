/**
 * Passphrase strength as shown while one is typed. Length carries most of the
 * weight, since the KDF is slow; word count rewards the diceware style. A long
 * passphrase made of a short repeated pattern or of a handful of characters is
 * not long in any sense that matters, and stays weak. Below `MIN_PASSPHRASE` code
 * points it is refused outright.
 */
import { MAX_PASSPHRASE, MIN_PASSPHRASE } from '$lib/crypto/kdf';

/** 0 is too short, 4 is strong: what `StrengthMeter` draws. */
export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** Distinct code points below which no length makes a passphrase more than weak. */
const MIN_DISTINCT = 8;

export function passphraseStrength(passphrase: string): StrengthScore {
	const normalized = passphrase.normalize('NFKC');
	const points = Array.from(normalized);
	const characters = points.length;
	const words = normalized.trim() === '' ? 0 : normalized.trim().split(/\s+/).length;
	if (characters < MIN_PASSPHRASE) return 0;
	if (repeats(points) || new Set(points).size < MIN_DISTINCT) return 1;
	if (characters >= 28 || (characters >= 20 && words >= 4)) return 4;
	if (characters >= 20 || (characters >= 16 && words >= 3)) return 3;
	if (characters >= 16) return 2;
	return 1;
}

/**
 * Whether the passphrase is a pattern repeated at least twice, complete or not.
 * The shortest period is the length minus the longest prefix that is also a suffix.
 */
function repeats(points: string[]): boolean {
	const n = points.length;
	const border = new Array<number>(n).fill(0);
	for (let i = 1, k = 0; i < n; i++) {
		while (k > 0 && points[i] !== points[k]) k = border[k - 1];
		if (points[i] === points[k]) k++;
		border[i] = k;
	}
	return n > 0 && n - border[n - 1] <= n / 2;
}

/** What stops a new passphrase and its confirmation, for the form to say. Null when fine. */
export function passphraseProblem(passphrase: string, confirmation: string): string | null {
	if (passphraseStrength(passphrase) === 0) return 'Use at least 12 characters.';
	if (Array.from(passphrase.normalize('NFKC')).length > MAX_PASSPHRASE) {
		return 'Use at most 1024 characters.';
	}
	if (passphrase !== confirmation) return 'The two passphrases do not match.';
	return null;
}
