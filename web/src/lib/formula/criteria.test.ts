import { describe, expect, it } from 'vitest';
import { criterion, wildcard } from './criteria';

describe('wildcard', () => {
	it.each([
		['a*', 'apple', true],
		['a*', 'banana', false],
		['?b', 'Ab', true],
		['?b', 'b', false],
		['*', '', true],
		['a*e', 'ae', true],
		['a*e', 'apple', true],
		['a*e', 'apples', false],
		['*p*l*', 'apple', true],
		['~*', '*', true],
		['~*', 'a', false],
		['~?x', '?x', true],
		['~~', '~', true],
		['a~b', 'a~b', true],
		['a.b', 'axb', false],
		['(a)', '(A)', true],
		['a**b', 'ab', true],
		['a\nb*', 'A\nBc', true]
	])('%j against %j is %s', (pattern, text, expected) => {
		expect(wildcard(pattern)(text)).toBe(expected);
	});

	it('matches adversarial patterns in linear time', () => {
		const start = performance.now();
		// A backtracking regular expression takes seconds on this; more stars
		// or a longer text take hours.
		const pattern = '*a'.repeat(8) + '*b';
		const text = 'a'.repeat(40);
		expect(wildcard(pattern)(text)).toBe(false);
		expect(criterion(pattern)(text)).toBe(false);
		expect(performance.now() - start).toBeLessThan(500);
	});
});
