/**
 * A new recovery key on its way to being saved: its words, and the three of them
 * a person has to type back. It lives in memory only, so a reload starts over
 * with a new key and new questions, and nothing else has happened yet.
 */
import type { Bytes } from '$lib/crypto/encoding';
import { randomBytes, zero } from '$lib/crypto/random';
import { RECOVERY_WORDS } from '$lib/crypto/recovery';
import type { Sealer } from '$lib/crypto/sealer';

export const WORDS_ASKED = 3;

export interface PendingRecovery {
	key: Bytes;
	words: string[];
	/** Zero-based positions to ask for, in order. Empty without a recovery key. */
	asked: number[];
}

export function newRecovery(sealer: Sealer): PendingRecovery {
	const key = sealer.newRecoveryKey();
	const words = sealer.recoveryWords(key);
	return { key, words, asked: words.length === 0 ? [] : pickPositions() };
}

function pickPositions(): number[] {
	const picked = new Set<number>();
	while (picked.size < WORDS_ASKED) {
		const [byte] = randomBytes(1);
		// Below the largest multiple of 24 that fits a byte, so that no word is likelier.
		if (byte < 240) picked.add(byte % RECOVERY_WORDS);
	}
	return [...picked].sort((a, b) => a - b);
}

/** Whether each typed answer is the word asked for, forgiving case and spaces. */
export function answersMatch(pending: PendingRecovery, answers: readonly string[]): boolean {
	return pending.asked.every(
		(position, i) => (answers[i] ?? '').trim().toLowerCase() === pending.words[position]
	);
}

/** What the downloaded file holds. */
export function recoveryFile(pending: PendingRecovery, username: string, server: string): string {
	return [
		'YonDrive recovery key',
		'',
		`Server: ${server}`,
		`Username: ${username}`,
		'',
		pending.words.join(' '),
		'',
		'This key and your passphrase are the only ways into your files. Nobody can',
		'reset them for you. Keep this file away from the server, somewhere only you',
		'can reach.',
		''
	].join('\n');
}

export function discardRecovery(pending: PendingRecovery): void {
	zero(pending.key);
	pending.words.length = 0;
}
