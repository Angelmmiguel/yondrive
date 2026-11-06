import { describe, expect, it } from 'vitest';
import {
	formatRecoveryKey,
	generateRecoveryKey,
	InvalidRecoveryPhraseError,
	parseRecoveryKey
} from './recovery';

// The 256-bit entries of the BIP39 reference vectors, which is where every
// implementation checks its wordlist and checksum against.
const vectors = [
	{
		entropy: Buffer.alloc(32, 0x00),
		phrase: `${'abandon '.repeat(23)}art`
	},
	{
		entropy: Buffer.alloc(32, 0x7f),
		phrase:
			'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'
	},
	{
		entropy: Buffer.alloc(32, 0x80),
		phrase:
			'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'
	},
	{
		entropy: Buffer.alloc(32, 0xff),
		phrase: `${'zoo '.repeat(23)}vote`
	}
];

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof InvalidRecoveryPhraseError) return e.code;
		throw e;
	}
	throw new Error('did not throw');
}

describe('known answers', () => {
	it.each(vectors)('encodes and decodes the BIP39 vector for $entropy.0', ({ entropy, phrase }) => {
		expect(formatRecoveryKey(entropy)).toBe(phrase);
		expect(parseRecoveryKey(phrase)).toEqual(new Uint8Array(entropy));
	});
});

describe('generateRecoveryKey', () => {
	it('is 32 random bytes', () => {
		const key = generateRecoveryKey();

		expect(key).toHaveLength(32);
		expect(key).not.toEqual(generateRecoveryKey());
	});
});

describe('formatRecoveryKey', () => {
	it('yields 24 words separated by single spaces', () => {
		const phrase = formatRecoveryKey(generateRecoveryKey());

		expect(phrase.split(' ')).toHaveLength(24);
		expect(phrase).toMatch(/^[a-z]+( [a-z]+){23}$/);
	});
});

describe('parseRecoveryKey', () => {
	it('round-trips a fresh key', () => {
		const key = generateRecoveryKey();

		expect(parseRecoveryKey(formatRecoveryKey(key))).toEqual(key);
	});

	it('forgives case and whitespace', () => {
		const key = generateRecoveryKey();
		const words = formatRecoveryKey(key).split(' ');
		const messy = `  ${words.map((w, i) => (i % 2 ? w.toUpperCase() : w)).join('\n\t  ')} \n`;

		expect(parseRecoveryKey(messy)).toEqual(key);
	});

	it('reports a changed word as a checksum error', () => {
		expect(code(() => parseRecoveryKey('abandon '.repeat(24).trim()))).toBe('checksum');
	});

	it('reports a wrong word count as a words error', () => {
		expect(code(() => parseRecoveryKey('abandon '.repeat(23).trim()))).toBe('words');
		expect(code(() => parseRecoveryKey(`${vectors[0].phrase} art`))).toBe('words');
		expect(code(() => parseRecoveryKey(''))).toBe('words');
	});

	it('reports an unknown word as a words error', () => {
		expect(code(() => parseRecoveryKey(`${'abandon '.repeat(23)}zzz`))).toBe('words');
		expect(code(() => parseRecoveryKey(`${'abandon '.repeat(23)}art.`))).toBe('words');
	});
});
