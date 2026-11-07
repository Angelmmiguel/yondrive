/**
 * Criteria of SUMIF, COUNTIF and AVERAGEIF, and exact matching in lookups:
 * `5`, `"<5"`, `">=1/1/2024"`, `"<>"`, `"a*"`, `"?b"`, `"~*"`, case-insensitive.
 */
import { numberFromText, isError, sameNumber, type Scalar } from './values';

export type Criterion = (v: Scalar) => boolean;

/** A pattern with `*`, `?` and `~` as a whole-text, case-insensitive test. */
export function wildcard(pattern: string): (s: string) => boolean {
	if (!/[*?~]/.test(pattern)) {
		const p = pattern.toLowerCase();
		return (s) => s.toLowerCase() === p;
	}
	// Two pointers that backtrack only to the last `*`: O(n·m) at worst, where
	// a regular expression backtracks exponentially on patterns like `*a*a*b`.
	// A token is a literal character, ANY (`?`) or STAR (`*`).
	const ANY = 0;
	const STAR = 1;
	const tokens: (string | 0 | 1)[] = [];
	const lower = pattern.toLowerCase();
	for (let i = 0; i < lower.length; i++) {
		const ch = lower[i];
		if (ch === '~' && i + 1 < lower.length && '*?~'.includes(lower[i + 1])) tokens.push(lower[++i]);
		else if (ch === '*') {
			if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
		} else tokens.push(ch === '?' ? ANY : ch);
	}
	return (text) => {
		const s = text.toLowerCase();
		let p = 0;
		let i = 0;
		let star = -1;
		let mark = 0;
		while (i < s.length) {
			const t = tokens[p];
			if (t === STAR) {
				star = p++;
				mark = i;
			} else if (p < tokens.length && (t === ANY || t === s[i])) {
				p++;
				i++;
			} else if (star >= 0) {
				p = star + 1;
				i = ++mark;
			} else return false;
		}
		while (tokens[p] === STAR) p++;
		return p === tokens.length;
	};
}

const numEq = (n: number) => (v: Scalar) =>
	(typeof v === 'number' && sameNumber(v, n)) ||
	(typeof v === 'string' &&
		(() => {
			const x = numberFromText(v);
			return x !== null && sameNumber(x, n);
		})());

export function criterion(c: Scalar): Criterion {
	if (c === null) c = 0;
	if (typeof c === 'number') return numEq(c);
	if (typeof c === 'boolean') return (v) => v === c;
	if (isError(c)) return (v) => isError(v) && v.error === c.error;
	const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c)!;
	const op = m[1] ?? '';
	const operand = m[2];
	if (operand === '') {
		if (op === '') return (v) => v === null || v === '';
		if (op === '=') return (v) => v === null;
		if (op === '<>') return (v) => v !== null;
		return () => false;
	}
	const n = numberFromText(operand);
	if (n !== null) {
		const eq = numEq(n);
		switch (op) {
			case '':
			case '=':
				return eq;
			case '<>':
				return (v) => !eq(v);
			case '<':
				return (v) => typeof v === 'number' && v < n && !sameNumber(v, n);
			case '<=':
				return (v) => typeof v === 'number' && (v < n || sameNumber(v, n));
			case '>':
				return (v) => typeof v === 'number' && v > n && !sameNumber(v, n);
			default:
				return (v) => typeof v === 'number' && (v > n || sameNumber(v, n));
		}
	}
	const upper = operand.toUpperCase();
	if (upper === 'TRUE' || upper === 'FALSE') {
		const b = upper === 'TRUE';
		if (op === '' || op === '=') return (v) => v === b;
		if (op === '<>') return (v) => v !== b;
	}
	if (/^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)$/.test(upper)) {
		if (op === '' || op === '=') return (v) => isError(v) && v.error === upper;
		if (op === '<>') return (v) => !(isError(v) && v.error === upper);
	}
	if (op === '' || op === '=') {
		const w = wildcard(operand);
		return (v) => typeof v === 'string' && w(v);
	}
	if (op === '<>') {
		const w = wildcard(operand);
		return (v) => !(typeof v === 'string' && w(v));
	}
	const t = operand.toLowerCase();
	return (v) => {
		if (typeof v !== 'string') return false;
		const s = v.toLowerCase();
		if (op === '<') return s < t;
		if (op === '<=') return s <= t;
		if (op === '>') return s > t;
		return s >= t;
	};
}
