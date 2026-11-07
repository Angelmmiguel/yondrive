/** Evaluating a parsed formula against the workbook, with Excel's operator rules. */
import type { Node } from './ast';
import { FUNCTIONS, power } from './functions';
import { deref, isRef, type Ctx, type Operand } from './operand';
import {
	compare,
	err,
	isError,
	isErrorCode,
	MAX_TEXT,
	num,
	toNumber,
	toText,
	type ErrorValue,
	type Scalar
} from './values';

function arithmetic(op: string, a: number, b: number): number | ErrorValue {
	switch (op) {
		case '+':
			return num(a + b);
		case '-':
			return num(a - b);
		case '*':
			return num(a * b);
		case '/':
			return b === 0 ? err('#DIV/0!') : num(a / b);
		default:
			return power(a, b);
	}
}

export function evaluate(node: Node, c: Ctx): Operand {
	switch (node.type) {
		case 'number':
			return node.value;
		case 'string':
			return node.value;
		case 'bool':
			return node.value;
		case 'error':
			return isErrorCode(node.code) ? err(node.code) : err('#VALUE!');
		case 'missing':
			return null;
		case 'cell': {
			const sheet = node.sheet === undefined ? c.sheet : c.sheetId(node.sheet);
			if (sheet === undefined) return err('#REF!');
			return {
				kind: 'ref',
				sheet,
				area: { top: node.row, left: node.col, bottom: node.row, right: node.col }
			};
		}
		case 'range': {
			const sheet = node.sheet === undefined ? c.sheet : c.sheetId(node.sheet);
			if (sheet === undefined) return err('#REF!');
			return {
				kind: 'ref',
				sheet,
				area: { top: node.top, left: node.left, bottom: node.bottom, right: node.right }
			};
		}
		case 'name':
			return err('#NAME?');
		case 'array':
			return err('#VALUE!');
		case 'paren':
			return evaluate(node.expr, c);
		case 'call': {
			const spec = FUNCTIONS[node.name];
			if (!spec) return err('#NAME?');
			if (node.args.length < spec.min || node.args.length > spec.max) return err('#VALUE!');
			return spec.fn(node.args, c);
		}
		case 'unary': {
			const v = deref(evaluate(node.arg, c), c);
			if (node.op === '+') return v;
			const n = toNumber(v, c.date1904);
			return isError(n) ? n : num(-n);
		}
		case 'percent': {
			const n = toNumber(deref(evaluate(node.arg, c), c), c.date1904);
			return isError(n) ? n : num(n / 100);
		}
		case 'binary': {
			const a = deref(evaluate(node.left, c), c);
			const b = deref(evaluate(node.right, c), c);
			if (isError(a)) return a;
			if (isError(b)) return b;
			if (node.op === '&') {
				const s = (toText(a) as string) + (toText(b) as string);
				return s.length > MAX_TEXT ? err('#VALUE!') : s;
			}
			if (
				node.op === '+' ||
				node.op === '-' ||
				node.op === '*' ||
				node.op === '/' ||
				node.op === '^'
			) {
				const x = toNumber(a, c.date1904);
				if (isError(x)) return x;
				const y = toNumber(b, c.date1904);
				if (isError(y)) return y;
				return arithmetic(node.op, x, y);
			}
			const d = compare(a, b);
			switch (node.op) {
				case '=':
					return d === 0;
				case '<>':
					return d !== 0;
				case '<':
					return d < 0;
				case '<=':
					return d <= 0;
				case '>':
					return d > 0;
				default:
					return d >= 0;
			}
		}
	}
}

/** A formula's result as its cell holds it: one value, and a blank reference reads as 0. */
export function evaluateFormula(node: Node, c: Ctx): Scalar {
	const o = evaluate(node, c);
	const v = isRef(o) ? deref(o, c) : o;
	if (v === null) return 0;
	if (typeof v === 'number') return num(v);
	if (typeof v === 'string' && v.length > MAX_TEXT) return err('#VALUE!');
	return v;
}
