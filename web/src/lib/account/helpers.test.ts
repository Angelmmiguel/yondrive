import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/types';
import { PassphraseTooLongError, PassphraseTooShortError } from '$lib/crypto/kdf';
import { InvalidRecoveryPhraseError } from '$lib/crypto/recovery';
import { accountHasWrappedKeys, sealerFor, SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { memoryStorage } from '$lib/testing/account';
import { readDisplayName, writeDisplayName } from './display-name';
import {
	describeError,
	LockedError,
	WrongCredentialsError,
	WrongPassphraseError,
	WrongRecoveryKeyError
} from './errors';
import {
	answersMatch,
	discardRecovery,
	newRecovery,
	recoveryFile,
	WORDS_ASKED
} from './recovery-key';
import { passphraseProblem, passphraseStrength } from './strength';
import { newAccountBody, optional, recordOf, rekeyBody } from './wire';

describe('a pending recovery key', () => {
	const sealer = sealerFor(SUITE_E2E);

	it('has 24 words and asks for three distinct ones in order', () => {
		for (let i = 0; i < 50; i++) {
			const { words, asked } = newRecovery(sealer);
			expect(words).toHaveLength(24);
			expect(asked).toHaveLength(WORDS_ASKED);
			expect(new Set(asked).size).toBe(WORDS_ASKED);
			expect([...asked].sort((a, b) => a - b)).toEqual(asked);
			expect(asked.every((p) => p >= 0 && p < 24)).toBe(true);
		}
	});

	it('is different each time', () => {
		expect(newRecovery(sealer).words).not.toEqual(newRecovery(sealer).words);
	});

	it('accepts the words asked for, forgiving case and spaces', () => {
		const pending = newRecovery(sealer);
		const answers = pending.asked.map((p) => pending.words[p]);
		expect(answersMatch(pending, answers)).toBe(true);
		expect(
			answersMatch(
				pending,
				answers.map((a) => `  ${a.toUpperCase()} `)
			)
		).toBe(true);
	});

	it('refuses anything else', () => {
		const pending = newRecovery(sealer);
		const answers = pending.asked.map((p) => pending.words[p]);
		expect(answersMatch(pending, [])).toBe(false);
		expect(answersMatch(pending, [answers[0], answers[1], 'nope'])).toBe(false);
		expect(answersMatch(pending, [answers[1], answers[0], answers[2]])).toBe(false);
	});

	it('does not exist without encryption', () => {
		const pending = newRecovery(sealerFor(SUITE_NONE));
		expect(pending.words).toEqual([]);
		expect(pending.asked).toEqual([]);
		expect(pending.key).toHaveLength(0);
	});

	it('writes its words to the file, and goes when discarded', () => {
		const pending = newRecovery(sealer);
		const phrase = pending.words.join(' ');
		const file = recoveryFile(pending, 'alice', 'nas');
		expect(file).toContain(phrase);
		expect(file).toContain('alice');
		discardRecovery(pending);
		expect(pending.key.every((b) => b === 0)).toBe(true);
		expect(pending.words).toEqual([]);
	});
});

describe('passphrase strength', () => {
	it.each([
		['', 0],
		['short', 0],
		['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1],
		['abcabcabcabcabcabcabc', 1],
		['twelve chars', 1],
		['sixteencharacters', 2],
		['twenty one characters', 3],
		['four words go here ok', 4],
		['correct horse battery staple', 4]
	])('%j scores %i', (passphrase, score) => {
		expect(passphraseStrength(passphrase)).toBe(score);
	});
});

describe('the wire', () => {
	const sealer = sealerFor(SUITE_E2E);
	const { record } = sealer.createUser(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
	const none = sealerFor(SUITE_NONE).createUser(new Uint8Array(0), new Uint8Array(0)).record;
	const kdf = { name: 'argon2id', m: 8192, t: 1, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' } as const;

	const body = (r: typeof record, recoveryAuthKey: Uint8Array) =>
		newAccountBody({
			username: 'a',
			email: '',
			authKey: new Uint8Array(32).fill(3),
			kdf,
			recoveryAuthKey,
			record: r
		});

	it('carries keys and the recovery auth key when the sealer made them', () => {
		const sent = body(record, new Uint8Array(32).fill(4));
		expect(sent.keys).toBeDefined();
		expect(sent.recovery_auth_key).toBeDefined();
		expect(recordOf({ keys: sent.keys })).toEqual(record);
	});

	it('leaves them out when the sealer made nothing', () => {
		const sent = body(none, new Uint8Array(0));
		expect('keys' in sent && sent.keys !== undefined).toBe(false);
		expect(sent.recovery_auth_key).toBeUndefined();
		expect(sent.email).toBeUndefined();
	});

	it('reads an account with no keys as an empty record, which the guard sees as no keys', () => {
		expect(accountHasWrappedKeys(recordOf({}))).toBe(false);
		expect(accountHasWrappedKeys(recordOf({ keys: body(record, new Uint8Array(32)).keys }))).toBe(
			true
		);
	});

	it('shapes a rekey as its groups', () => {
		const key = new Uint8Array(32).fill(5);
		expect(rekeyBody({ currentAuthKey: key })).toEqual({
			current_auth_key: optional(key),
			auth_key: undefined,
			kdf: undefined,
			wrapped_master_key: undefined,
			recovery_auth_key: undefined,
			wrapped_master_key_recovery: undefined
		});
		const passphraseOnly = rekeyBody({
			currentAuthKey: key,
			passphrase: { authKey: key, kdf, wrapped: new Uint8Array(0) }
		});
		expect(passphraseOnly.auth_key).toBeDefined();
		expect(passphraseOnly.wrapped_master_key).toBeUndefined();
	});
});

describe('describeError', () => {
	it.each([
		[new WrongCredentialsError(), 'Wrong username or passphrase.'],
		[new WrongPassphraseError(), 'That passphrase is not correct.'],
		[new LockedError(), 'locked before'],
		[new WrongRecoveryKeyError(), 'recovery key'],
		[new PassphraseTooShortError(), '12'],
		[new PassphraseTooLongError(), '1024'],
		[new InvalidRecoveryPhraseError('words'), '24 words'],
		[new InvalidRecoveryPhraseError('checksum'), 'mistyped'],
		[new ApiError(429, 'rate_limited'), 'Too many'],
		[new ApiError(0, 'network'), 'cannot be reached'],
		[new ApiError(500, 'internal'), 'Something went wrong'],
		[new Error('secret detail'), 'Something went wrong']
	])('%s', (error, text) => {
		expect(describeError(error)).toContain(text);
	});

	it('never repeats what an unexpected error says', () => {
		expect(describeError(new Error('secret detail'))).not.toContain('secret');
	});
});

describe('the display name', () => {
	it('stays on the device, trimmed', () => {
		const storage = memoryStorage();
		expect(readDisplayName(storage)).toBe('');
		writeDisplayName(storage, '  Ada Lovelace ');
		expect(readDisplayName(storage)).toBe('Ada Lovelace');
		writeDisplayName(storage, '');
		expect(readDisplayName(storage)).toBe('');
		expect(readDisplayName(null)).toBe('');
	});
});

describe('passphraseProblem', () => {
	const good = 'correct horse battery staple';

	it('says what is wrong, and nothing when fine', () => {
		expect(passphraseProblem('short', 'short')).toContain('12');
		expect(passphraseProblem('x'.repeat(1025), 'x'.repeat(1025))).toContain('1024');
		expect(passphraseProblem(good, 'other')).toContain('match');
		expect(passphraseProblem(good, good)).toBeNull();
	});
});
