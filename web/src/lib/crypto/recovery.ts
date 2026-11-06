/**
 * The recovery key: 32 random bytes shown once as 24 English words. BIP39 is
 * used purely as a checksummed encoding of those bytes; no seed is ever
 * derived from the phrase.
 */
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Bytes } from './encoding';
import { randomBytes } from './random';

export const RECOVERY_KEY_LENGTH = 32;
export const RECOVERY_WORDS = 24;

/** Why a phrase is not a recovery key. */
export type InvalidRecoveryPhraseCode = 'words' | 'checksum';

/** A phrase that does not encode a recovery key. */
export class InvalidRecoveryPhraseError extends Error {
	readonly code: InvalidRecoveryPhraseCode;

	constructor(code: InvalidRecoveryPhraseCode) {
		super(
			code === 'words'
				? `recovery phrase must be ${RECOVERY_WORDS} words from the word list`
				: 'recovery phrase has a typo: checksum does not match'
		);
		this.name = 'InvalidRecoveryPhraseError';
		this.code = code;
	}
}

const words = new Set(wordlist);

/** A fresh 32-byte recovery key. */
export function generateRecoveryKey(): Bytes {
	return randomBytes(RECOVERY_KEY_LENGTH);
}

/** Encodes a recovery key as 24 words separated by single spaces. */
export function formatRecoveryKey(key: Uint8Array): string {
	return entropyToMnemonic(key, wordlist);
}

/**
 * Decodes a phrase typed by a person: case and surrounding or repeated
 * whitespace are forgiven, everything else must be exact.
 */
export function parseRecoveryKey(phrase: string): Bytes {
	const parts = phrase.trim().toLowerCase().split(/\s+/);
	if (parts.length !== RECOVERY_WORDS || !parts.every((word) => words.has(word))) {
		throw new InvalidRecoveryPhraseError('words');
	}
	try {
		return mnemonicToEntropy(parts.join(' '), wordlist);
	} catch {
		throw new InvalidRecoveryPhraseError('checksum');
	}
}
