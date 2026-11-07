/**
 * Cell values as Excel has them: IEEE doubles, text, booleans, errors and blank,
 * and the coercions between them. Values are plain data so they cross into and
 * out of a worker; an error is `{ error: code }`.
 */
import { dateFromText } from './dates';

export const ERROR_CODES = [
	'#NULL!',
	'#DIV/0!',
	'#VALUE!',
	'#REF!',
	'#NAME?',
	'#NUM!',
	'#N/A'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorValue {
	readonly error: ErrorCode;
}

/** A cell's content once calculated. `null` is a blank cell. */
export type Scalar = number | string | boolean | ErrorValue | null;

const ERRORS = Object.fromEntries(
	ERROR_CODES.map((code) => [code, Object.freeze({ error: code })])
) as Record<ErrorCode, ErrorValue>;

export const err = (code: ErrorCode): ErrorValue => ERRORS[code];

export const isError = (v: unknown): v is ErrorValue =>
	typeof v === 'object' && v !== null && 'error' in v;

export const isErrorCode = (s: string): s is ErrorCode =>
	(ERROR_CODES as readonly string[]).includes(s.toUpperCase());

/** The longest text a cell holds, in UTF-16 units. */
export const MAX_TEXT = 32767;

/** A number as a result: infinities and NaN are #NUM!, and -0 is 0. */
export function num(n: number): number | ErrorValue {
	if (!Number.isFinite(n)) return err('#NUM!');
	return n === 0 ? 0 : n;
}

const NUMERIC = /^([+-]?)\s*(\$?)\s*(\d{1,3}(?:,\d{3})+|\d*)(\.\d*)?(?:[eE]([+-]?\d+))?\s*(%?)$/;

/** Numbers as Excel reads them from text: thousands, decimals, exponent, `%`, `$`, dates and times. */
export function numberFromText(text: string): number | null {
	const s = text.trim();
	if (s === '') return null;
	let neg = false;
	let body = s;
	const paren = /^\((.*)\)$/.exec(s);
	if (paren) {
		neg = true;
		body = paren[1];
	}
	const m = NUMERIC.exec(body);
	if (m && (m[3] !== '' || (m[4] !== undefined && m[4].length > 1))) {
		const digits = m[3].replace(/,/g, '') + (m[4] ?? '') + (m[5] ? `e${m[5]}` : '');
		let n = Number(digits);
		if (!Number.isFinite(n)) return null;
		if (m[6]) n /= 100;
		if (m[1] === '-') n = -n;
		return neg ? -n : n;
	}
	if (neg) return null;
	return dateFromText(s);
}

/** Excel's own text for a number, as `&` and text functions give it: 15 significant digits. */
export function numberToText(n: number): string {
	if (n === 0) return '0';
	const abs = Math.abs(n);
	if (abs >= 1e21 || abs < 1e-9) {
		const [m, e] = n.toExponential(14).split('e');
		const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
		const exp = Number(e);
		return `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
	}
	const p = Number(n.toPrecision(15));
	let s = String(p);
	if (s.includes('e')) {
		// Shown in full, as Excel does below 1e21.
		s = p.toFixed(Math.max(0, 15 - Math.floor(Math.log10(abs)) - 1)).replace(/\.?0+$/, '');
	}
	return s;
}

export type Coerced<T> = T | ErrorValue;

export function toNumber(v: Scalar): Coerced<number> {
	if (typeof v === 'number') return v;
	if (v === null) return 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'string') {
		const n = numberFromText(v);
		return n === null ? err('#VALUE!') : n;
	}
	return v;
}

export function toText(v: Scalar): Coerced<string> {
	if (typeof v === 'string') return v;
	if (v === null) return '';
	if (typeof v === 'number') return numberToText(v);
	if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
	return v;
}

export function toBool(v: Scalar): Coerced<boolean> {
	if (typeof v === 'boolean') return v;
	if (v === null) return false;
	if (typeof v === 'number') return v !== 0;
	if (typeof v === 'string') {
		const u = v.toUpperCase();
		if (u === 'TRUE') return true;
		if (u === 'FALSE') return false;
		return err('#VALUE!');
	}
	return v;
}

/** Equal at the 15 significant digits Excel keeps, so `0.1+0.2=0.3` holds as it does there. */
export function sameNumber(a: number, b: number): boolean {
	if (a === b) return true;
	return Number(a.toPrecision(15)) === Number(b.toPrecision(15));
}

const typeRank = (v: number | string | boolean) =>
	typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;

/**
 * Orders two values as Excel's comparison operators do: numbers before text before
 * booleans, text without regard to case, and blank as the zero of the other side.
 */
export function compare(a: Exclude<Scalar, ErrorValue>, b: Exclude<Scalar, ErrorValue>): number {
	if (a === null && b === null) return 0;
	if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
	if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
	const ra = typeRank(a);
	const rb = typeRank(b);
	if (ra !== rb) return ra - rb;
	if (typeof a === 'number') {
		if (sameNumber(a, b as number)) return 0;
		return a < (b as number) ? -1 : 1;
	}
	if (typeof a === 'string') {
		const x = a.toLowerCase();
		const y = (b as string).toLowerCase();
		return x === y ? 0 : x < y ? -1 : 1;
	}
	return a === b ? 0 : a ? 1 : -1;
}

/** The same value, for telling whether a cell changed. */
export function sameValue(a: Scalar, b: Scalar): boolean {
	if (isError(a) || isError(b)) return isError(a) && isError(b) && a.error === b.error;
	return a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a + 0, b + 0));
}
