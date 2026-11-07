/**
 * The functions this engine calculates (PLAN 6.3), with Excel's rules for each:
 * what a reference contributes as opposed to a value typed into the formula,
 * which errors pass through, and what is blank. A function gets its arguments
 * unevaluated, so IF and IFERROR only evaluate the branch they take.
 */
import type { Node } from './ast';
import { criterion, wildcard } from './criteria';
import { dateSerial, serialOfDate, serialToYmd } from './dates';
import { formatValue, roundDecimal } from './numfmt';
import { clip, deref, isRef, type Ctx, type Operand, type RefValue } from './operand';
import {
	compare,
	err,
	isError,
	MAX_TEXT,
	num,
	numberFromText,
	toBool,
	toNumber,
	toText,
	type ErrorValue,
	type Scalar
} from './values';

type Fn = (args: Node[], c: Ctx) => Operand;

export interface FunctionSpec {
	min: number;
	max: number;
	fn: Fn;
	/** Calculated again on every recalculation (TODAY, NOW). */
	volatile?: true;
}

const isMissing = (n: Node | undefined) => n === undefined || n.type === 'missing';
const scalar = (n: Node, c: Ctx): Scalar => (n.type === 'missing' ? null : deref(c.ev(n), c));

function number(n: Node | undefined, c: Ctx, fallback = 0): number | ErrorValue {
	if (isMissing(n)) return fallback;
	return toNumber(scalar(n as Node, c));
}

function text(n: Node | undefined, c: Ctx): string | ErrorValue {
	if (isMissing(n)) return '';
	return toText(scalar(n as Node, c));
}

/** Numbers as SUM sees them: from references only numbers, typed values coerced. */
function numbers(args: Node[], c: Ctx): number[] | ErrorValue {
	const out: number[] = [];
	for (const a of args) {
		if (a.type === 'missing') continue;
		const o = c.ev(a);
		if (isRef(o)) {
			let e: ErrorValue | null = null;
			c.each(o.sheet, o.area, (v) => {
				if (e) return;
				if (typeof v === 'number') out.push(v);
				else if (isError(v)) e = v;
			});
			if (e) return e;
		} else {
			if (o === null) continue;
			const n = toNumber(o);
			if (isError(n)) return n;
			out.push(n);
		}
	}
	return out;
}

const reduce =
	(f: (xs: number[]) => number | ErrorValue): Fn =>
	(args, c) => {
		const xs = numbers(args, c);
		if (isError(xs)) return xs;
		const r = f(xs);
		return isError(r) ? r : num(r);
	};

const sum = (xs: number[]) => {
	let s = 0;
	for (const x of xs) s += x;
	return s;
};

function round(mode: 'round' | 'up' | 'down'): Fn {
	return (args, c) => {
		const x = number(args[0], c);
		if (isError(x)) return x;
		const d = number(args[1], c);
		if (isError(d)) return d;
		return num(roundDecimal(x, Math.trunc(d), mode));
	};
}

const unaryMath =
	(f: (x: number) => number | ErrorValue): Fn =>
	(args, c) => {
		const x = number(args[0], c);
		if (isError(x)) return x;
		const r = f(x);
		return isError(r) ? r : num(r);
	};

export function power(a: number, b: number): number | ErrorValue {
	if (a === 0 && b === 0) return err('#NUM!');
	if (a === 0 && b < 0) return err('#DIV/0!');
	if (a < 0 && !Number.isInteger(b)) return err('#NUM!');
	return num(a ** b);
}

/** Logical values for AND and OR; null when there are none. */
function logicals(args: Node[], c: Ctx): boolean[] | ErrorValue {
	const out: boolean[] = [];
	for (const a of args) {
		if (a.type === 'missing') continue;
		const o = c.ev(a);
		if (isRef(o)) {
			let e: ErrorValue | null = null;
			c.each(o.sheet, o.area, (v) => {
				if (e) return;
				if (typeof v === 'boolean') out.push(v);
				else if (typeof v === 'number') out.push(v !== 0);
				else if (isError(v)) e = v;
			});
			if (e) return e;
		} else {
			if (o === null) continue;
			const b = toBool(o);
			if (isError(b)) return b;
			out.push(b);
		}
	}
	return out;
}

function needRef(o: Operand): RefValue | ErrorValue {
	return isRef(o) ? o : isError(o) ? o : err('#VALUE!');
}

/** The cell at the same offset in another area, for SUMIF's sum range. */
function offsetOf(from: RefValue, to: RefValue, row: number, col: number) {
	return { row: to.area.top + (row - from.area.top), col: to.area.left + (col - from.area.left) };
}

function conditional(kind: 'sum' | 'count' | 'average'): Fn {
	return (args, c) => {
		const range = needRef(c.ev(args[0]));
		if (isError(range)) return range;
		const crit = criterion(scalar(args[1], c));
		if (kind === 'count') {
			let n = 0;
			let nonBlank = 0;
			c.each(range.sheet, range.area, (v) => {
				nonBlank++;
				if (crit(v)) n++;
			});
			if (crit(null)) {
				const a = range.area;
				n += (a.bottom - a.top + 1) * (a.right - a.left + 1) - nonBlank;
			}
			return n;
		}
		let target = range;
		if (!isMissing(args[2])) {
			const t = needRef(c.ev(args[2]));
			if (isError(t)) return t;
			target = t;
		}
		const a = range.area;
		const sized: RefValue = {
			kind: 'ref',
			sheet: target.sheet,
			area: {
				top: target.area.top,
				left: target.area.left,
				bottom: target.area.top + (a.bottom - a.top),
				right: target.area.left + (a.right - a.left)
			}
		};
		let total = 0;
		let count = 0;
		let e: ErrorValue | null = null;
		const add = (v: Scalar) => {
			if (e) return;
			if (typeof v === 'number') {
				total += v;
				count++;
			} else if (isError(v)) e = v;
		};
		c.each(range.sheet, a, (v, row, col) => {
			if (!crit(v)) return;
			const at = offsetOf(range, sized, row, col);
			add(c.value(sized.sheet, at.row, at.col));
		});
		if (crit(null)) {
			c.each(sized.sheet, sized.area, (v, row, col) => {
				const at = offsetOf(sized, range, row, col);
				if (c.value(range.sheet, at.row, at.col) === null) add(v);
			});
		}
		if (e) return e;
		if (kind === 'sum') return num(total);
		return count === 0 ? err('#DIV/0!') : num(total / count);
	};
}

const sameType = (a: Scalar, b: Scalar) =>
	typeof a === typeof b && !isError(a) && !isError(b) && a !== null && b !== null;

/** Whether a cell holds the value looked for, as exact lookups compare. */
function exactMatcher(lookup: Scalar): (v: Scalar) => boolean {
	if (typeof lookup === 'string') {
		const w = wildcard(lookup);
		return (v) => typeof v === 'string' && w(v);
	}
	if (lookup === null) return (v) => v === null;
	return (v) => sameType(v, lookup) && compare(v as never, lookup as never) === 0;
}

/**
 * The position (from 0) of a value in a list read by `at`, for MATCH and the
 * lookups: exact (0), the largest not above it (1), or the smallest not below
 * it (-1). The ordered forms walk the list as sorted data reads, and stop at
 * the first value past the one sought.
 */
function locate(lookup: Scalar, length: number, at: (i: number) => Scalar, type: number): number {
	if (type === 0) {
		const m = exactMatcher(lookup);
		for (let i = 0; i < length; i++) if (m(at(i))) return i;
		return -1;
	}
	let found = -1;
	for (let i = 0; i < length; i++) {
		const v = at(i);
		if (v === null || !sameType(v, lookup)) continue;
		const d = compare(v as never, lookup as never);
		if (type > 0) {
			if (d <= 0) found = i;
			else break;
		} else {
			if (d >= 0) found = i;
			else break;
		}
	}
	return found;
}

function lookup(vertical: boolean): Fn {
	return (args, c) => {
		const want = scalar(args[0], c);
		if (isError(want)) return want;
		const table = needRef(c.ev(args[1]));
		if (isError(table)) return table;
		const idx = number(args[2], c);
		if (isError(idx)) return idx;
		const exact = isMissing(args[3])
			? args.length > 3
			: (() => {
					const b = toBool(scalar(args[3], c));
					return isError(b) ? null : !b;
				})();
		if (exact === null) return err('#VALUE!');
		const k = Math.trunc(idx);
		const a = table.area;
		const width = vertical ? a.right - a.left + 1 : a.bottom - a.top + 1;
		if (k < 1) return err('#VALUE!');
		if (k > width) return err('#REF!');
		const area = clip(table, c);
		const length = vertical ? area.bottom - a.top + 1 : area.right - a.left + 1;
		const at = (i: number) =>
			vertical ? c.value(table.sheet, a.top + i, a.left) : c.value(table.sheet, a.top, a.left + i);
		const i = locate(want, length, at, exact ? 0 : 1);
		if (i < 0) return err('#N/A');
		return vertical
			? c.value(table.sheet, a.top + i, a.left + k - 1)
			: c.value(table.sheet, a.top + k - 1, a.left + i);
	};
}

const textFn =
	(f: (s: string) => string): Fn =>
	(args, c) => {
		const s = text(args[0], c);
		return isError(s) ? s : f(s);
	};

const checkLength = (s: string): string | ErrorValue => (s.length > MAX_TEXT ? err('#VALUE!') : s);

function datePart(part: 'year' | 'month' | 'day'): Fn {
	return (args, c) => {
		const v = scalar(args[0], c);
		const n = typeof v === 'string' && v.trim() === '' ? err('#VALUE!') : toNumber(v);
		if (isError(n)) return n;
		if (n < 0) return err('#NUM!');
		const ymd = serialToYmd(n, c.date1904);
		if (!ymd) return err('#NUM!');
		return ymd[part];
	};
}

const any = 255;

export const FUNCTIONS: Record<string, FunctionSpec> = {
	SUM: { min: 1, max: any, fn: reduce(sum) },
	AVERAGE: {
		min: 1,
		max: any,
		fn: reduce((xs) => (xs.length === 0 ? err('#DIV/0!') : sum(xs) / xs.length))
	},
	MIN: {
		min: 1,
		max: any,
		fn: reduce((xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => (b < a ? b : a))))
	},
	MAX: {
		min: 1,
		max: any,
		fn: reduce((xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => (b > a ? b : a))))
	},
	COUNT: {
		min: 1,
		max: any,
		fn: (args, c) => {
			let n = 0;
			for (const a of args) {
				if (a.type === 'missing') continue;
				const o = c.ev(a);
				if (isRef(o)) c.each(o.sheet, o.area, (v) => void (typeof v === 'number' && n++));
				else if (typeof o === 'number' || typeof o === 'boolean') n++;
				else if (typeof o === 'string' && numberFromText(o) !== null) n++;
			}
			return n;
		}
	},
	COUNTA: {
		min: 1,
		max: any,
		fn: (args, c) => {
			let n = 0;
			for (const a of args) {
				if (a.type === 'missing') continue;
				const o = c.ev(a);
				if (isRef(o)) c.each(o.sheet, o.area, () => void n++);
				else n++;
			}
			return n;
		}
	},
	ROUND: { min: 2, max: 2, fn: round('round') },
	ROUNDUP: { min: 2, max: 2, fn: round('up') },
	ROUNDDOWN: { min: 2, max: 2, fn: round('down') },
	ABS: { min: 1, max: 1, fn: unaryMath(Math.abs) },
	INT: { min: 1, max: 1, fn: unaryMath(Math.floor) },
	MOD: {
		min: 2,
		max: 2,
		fn: (args, c) => {
			const n = number(args[0], c);
			if (isError(n)) return n;
			const d = number(args[1], c);
			if (isError(d)) return d;
			if (d === 0) return err('#DIV/0!');
			return num(n - d * Math.floor(n / d));
		}
	},
	POWER: {
		min: 2,
		max: 2,
		fn: (args, c) => {
			const a = number(args[0], c);
			if (isError(a)) return a;
			const b = number(args[1], c);
			if (isError(b)) return b;
			return power(a, b);
		}
	},
	SQRT: { min: 1, max: 1, fn: unaryMath((x) => (x < 0 ? err('#NUM!') : Math.sqrt(x))) },
	IF: {
		min: 1,
		max: 3,
		fn: (args, c) => {
			const t = toBool(scalar(args[0], c));
			if (isError(t)) return t;
			const branch = t ? args[1] : args[2];
			if (branch === undefined) return t ? 0 : false;
			if (branch.type === 'missing') return 0;
			return c.ev(branch);
		}
	},
	IFERROR: {
		min: 2,
		max: 2,
		fn: (args, c) => {
			const o = args[0].type === 'missing' ? 0 : c.ev(args[0]);
			if (isError(deref(o, c))) return args[1].type === 'missing' ? 0 : c.ev(args[1]);
			return o;
		}
	},
	AND: {
		min: 1,
		max: any,
		fn: (args, c) => {
			const xs = logicals(args, c);
			if (isError(xs)) return xs;
			return xs.length === 0 ? err('#VALUE!') : xs.every(Boolean);
		}
	},
	OR: {
		min: 1,
		max: any,
		fn: (args, c) => {
			const xs = logicals(args, c);
			if (isError(xs)) return xs;
			return xs.length === 0 ? err('#VALUE!') : xs.some(Boolean);
		}
	},
	NOT: {
		min: 1,
		max: 1,
		fn: (args, c) => {
			const b = toBool(scalar(args[0], c));
			return isError(b) ? b : !b;
		}
	},
	TRUE: { min: 0, max: 0, fn: () => true },
	FALSE: { min: 0, max: 0, fn: () => false },
	SUMIF: { min: 2, max: 3, fn: conditional('sum') },
	COUNTIF: { min: 2, max: 2, fn: conditional('count') },
	AVERAGEIF: { min: 2, max: 3, fn: conditional('average') },
	VLOOKUP: { min: 3, max: 4, fn: lookup(true) },
	HLOOKUP: { min: 3, max: 4, fn: lookup(false) },
	INDEX: {
		min: 2,
		max: 4,
		fn: (args, c) => {
			const o = c.ev(args[0]);
			if (isError(o)) return o;
			if (!isRef(o)) return err('#VALUE!');
			const r = number(args[1], c);
			if (isError(r)) return r;
			const k = number(args[2], c);
			if (isError(k)) return k;
			const areaNum = number(args[3], c, 1);
			if (isError(areaNum)) return areaNum;
			if (Math.trunc(areaNum) !== 1) return err('#REF!');
			const a = o.area;
			const h = a.bottom - a.top + 1;
			const w = a.right - a.left + 1;
			let row = Math.trunc(r);
			let col = Math.trunc(k);
			if (args.length === 2 || isMissing(args[2])) {
				if (h === 1 && w > 1) {
					col = row;
					row = 0;
				}
			}
			if (row < 0 || col < 0) return err('#VALUE!');
			if (row > h || col > w) return err('#REF!');
			return {
				kind: 'ref',
				sheet: o.sheet,
				area: {
					top: row === 0 ? a.top : a.top + row - 1,
					bottom: row === 0 ? a.bottom : a.top + row - 1,
					left: col === 0 ? a.left : a.left + col - 1,
					right: col === 0 ? a.right : a.left + col - 1
				}
			};
		}
	},
	MATCH: {
		min: 2,
		max: 3,
		fn: (args, c) => {
			const want = scalar(args[0], c);
			if (isError(want)) return want;
			const o = c.ev(args[1]);
			if (isError(o)) return o;
			if (!isRef(o)) return err('#N/A');
			const t = number(args[2], c, 1);
			if (isError(t)) return t;
			const a = o.area;
			const area = clip(o, c);
			let at: (i: number) => Scalar;
			let length: number;
			if (a.left === a.right) {
				length = area.bottom - a.top + 1;
				at = (i) => c.value(o.sheet, a.top + i, a.left);
			} else if (a.top === a.bottom) {
				length = area.right - a.left + 1;
				at = (i) => c.value(o.sheet, a.top, a.left + i);
			} else return err('#N/A');
			const i = locate(want, length, at, Math.sign(Math.trunc(t)));
			return i < 0 ? err('#N/A') : i + 1;
		}
	},
	LEFT: {
		min: 1,
		max: 2,
		fn: (args, c) => {
			const s = text(args[0], c);
			if (isError(s)) return s;
			const n = args.length < 2 ? 1 : number(args[1], c);
			if (isError(n)) return n;
			if (n < 0) return err('#VALUE!');
			return s.slice(0, Math.trunc(n));
		}
	},
	RIGHT: {
		min: 1,
		max: 2,
		fn: (args, c) => {
			const s = text(args[0], c);
			if (isError(s)) return s;
			const n = args.length < 2 ? 1 : number(args[1], c);
			if (isError(n)) return n;
			if (n < 0) return err('#VALUE!');
			const k = Math.trunc(n);
			return k === 0 ? '' : s.slice(-k);
		}
	},
	MID: {
		min: 3,
		max: 3,
		fn: (args, c) => {
			const s = text(args[0], c);
			if (isError(s)) return s;
			const start = number(args[1], c);
			if (isError(start)) return start;
			const n = number(args[2], c);
			if (isError(n)) return n;
			if (start < 1 || n < 0) return err('#VALUE!');
			const from = Math.trunc(start) - 1;
			return s.slice(from, from + Math.trunc(n));
		}
	},
	LEN: {
		min: 1,
		max: 1,
		fn: (args, c) => {
			const s = text(args[0], c);
			return isError(s) ? s : s.length;
		}
	},
	TRIM: { min: 1, max: 1, fn: textFn((s) => s.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ')) },
	UPPER: { min: 1, max: 1, fn: textFn((s) => s.toUpperCase()) },
	LOWER: { min: 1, max: 1, fn: textFn((s) => s.toLowerCase()) },
	CONCAT: {
		min: 1,
		max: any,
		fn: (args, c) => {
			let out = '';
			for (const a of args) {
				if (a.type === 'missing') continue;
				const o = c.ev(a);
				if (isRef(o)) {
					let e: ErrorValue | null = null;
					c.each(o.sheet, o.area, (v) => {
						if (e) return;
						const t = toText(v);
						if (isError(t)) e = t;
						else out += t;
					});
					if (e) return e;
				} else {
					const t = toText(o);
					if (isError(t)) return t;
					out += t;
				}
				if (out.length > MAX_TEXT) return err('#VALUE!');
			}
			return out;
		}
	},
	CONCATENATE: {
		min: 1,
		max: any,
		fn: (args, c) => {
			let out = '';
			for (const a of args) {
				const t = text(a, c);
				if (isError(t)) return t;
				out += t;
			}
			return checkLength(out);
		}
	},
	TEXT: {
		min: 2,
		max: 2,
		fn: (args, c) => {
			let v = scalar(args[0], c);
			if (isError(v)) return v;
			const f = text(args[1], c);
			if (isError(f)) return f;
			if (typeof v === 'string') {
				const n = numberFromText(v);
				if (n !== null) v = n;
			}
			if (v === null) v = 0;
			return formatValue(v, f, { date1904: c.date1904 });
		}
	},
	VALUE: {
		min: 1,
		max: 1,
		fn: (args, c) => {
			const v = scalar(args[0], c);
			if (isError(v) || typeof v === 'number') return v;
			if (v === null) return 0;
			if (typeof v === 'boolean') return err('#VALUE!');
			const n = numberFromText(v);
			return n === null ? err('#VALUE!') : n;
		}
	},
	FIND: {
		min: 2,
		max: 3,
		fn: (args, c) => {
			const find = text(args[0], c);
			if (isError(find)) return find;
			const within = text(args[1], c);
			if (isError(within)) return within;
			const start = number(args[2], c, 1);
			if (isError(start)) return start;
			const s = Math.trunc(start);
			if (s < 1 || s > within.length + 1) return err('#VALUE!');
			const at = within.indexOf(find, s - 1);
			return at < 0 ? err('#VALUE!') : at + 1;
		}
	},
	SUBSTITUTE: {
		min: 3,
		max: 4,
		fn: (args, c) => {
			const s = text(args[0], c);
			if (isError(s)) return s;
			const from = text(args[1], c);
			if (isError(from)) return from;
			const to = text(args[2], c);
			if (isError(to)) return to;
			if (from === '') return s;
			if (isMissing(args[3])) return checkLength(s.split(from).join(to));
			const n = number(args[3], c);
			if (isError(n)) return n;
			const k = Math.trunc(n);
			if (k < 1) return err('#VALUE!');
			let at = -1;
			for (let i = 0; i < k; i++) {
				at = s.indexOf(from, at + (i === 0 ? 0 : from.length));
				if (at < 0) return s;
			}
			return checkLength(s.slice(0, at) + to + s.slice(at + from.length));
		}
	},
	TODAY: {
		min: 0,
		max: 0,
		volatile: true,
		fn: (_args, c) => Math.floor(serialOfDate(c.now(), c.date1904))
	},
	NOW: { min: 0, max: 0, volatile: true, fn: (_args, c) => serialOfDate(c.now(), c.date1904) },
	DATE: {
		min: 3,
		max: 3,
		fn: (args, c) => {
			const y = number(args[0], c);
			if (isError(y)) return y;
			const m = number(args[1], c);
			if (isError(m)) return m;
			const d = number(args[2], c);
			if (isError(d)) return d;
			return dateSerial(y, m, d, c.date1904) ?? err('#NUM!');
		}
	},
	YEAR: { min: 1, max: 1, fn: datePart('year') },
	MONTH: { min: 1, max: 1, fn: datePart('month') },
	DAY: { min: 1, max: 1, fn: datePart('day') }
};

/** Whether this engine calculates a function, by its name in upper case without prefix. */
export const isSupported = (name: string) => Object.hasOwn(FUNCTIONS, name);
