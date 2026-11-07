/**
 * The formula parser: en-US syntax as files store it. Operators bind as in Excel,
 * where negation comes before `%` and `^`, so `-2^2` is 4, and `^` groups from
 * the left. Anything outside the grammar (3-D and external references, structured
 * references, intersection and union) is a syntax error, and the cell keeps its
 * formula as text.
 */
import { colIndex, MAX_ROWS } from './address';
import { rangeOf, type BinaryOp, type Node } from './ast';

export class FormulaSyntaxError extends Error {}

/** Excel's own limit on formula length. */
export const MAX_FORMULA = 8192;
const MAX_DEPTH = 128;

const ERROR_RE = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/i;
const NUMBER_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const QUOTED_SHEET_RE = /^'((?:[^']|'')+)'!/;
const SHEET_RE = /^([A-Za-z_¡-￿][\w.¡-￿]*)!/;
const COLS_RE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w(.!$])/;
const ROWS_RE = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\w(.!])/;
const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w(.!])/;
const FUNC_RE = /^([A-Za-z_][\w.]*)\(/;
const NAME_RE = /^[A-Za-z_\\¡-￿][\w.?\\¡-￿]*/;
const PREFIX_RE = /^((?:_xlfn\.|_xlws\.)+)/i;

interface Pos {
	row: number;
	col: number;
	rowAbs: boolean;
	colAbs: boolean;
}

export function parseFormula(text: string): Node {
	if (text.length > MAX_FORMULA) throw new FormulaSyntaxError('formula too long');
	let i = 0;
	let depth = 0;
	const s = text;
	const ws = () => {
		while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++;
	};
	const fail = (what = 'unexpected input'): never => {
		throw new FormulaSyntaxError(`${what} at ${i}`);
	};
	const peek = (t: string) => s.startsWith(t, i);
	const rest = () => s.slice(i, i + 300);

	const cellPos = (m: RegExpExecArray): Pos | null => {
		const col = colIndex(m[2]);
		const row = Number(m[4]) - 1;
		if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
		return { row, col, rowAbs: m[3] === '$', colAbs: m[1] === '$' };
	};

	/** A reference, error or name after an optional sheet prefix. */
	const reference = (sheet: string | undefined): Node | null => {
		const r = rest();
		let m: RegExpExecArray | null;
		if ((m = COLS_RE.exec(r))) {
			const a = colIndex(m[2]);
			const b = colIndex(m[4]);
			if (a >= 0 && b >= 0) {
				i += m[0].length;
				return rangeOf(
					'cols',
					sheet,
					{ row: 0, col: a, rowAbs: false, colAbs: m[1] === '$' },
					{ row: 0, col: b, rowAbs: false, colAbs: m[3] === '$' }
				);
			}
		}
		if ((m = ROWS_RE.exec(r))) {
			const a = Number(m[2]) - 1;
			const b = Number(m[4]) - 1;
			if (a >= 0 && b >= 0 && a < MAX_ROWS && b < MAX_ROWS) {
				i += m[0].length;
				return rangeOf(
					'rows',
					sheet,
					{ row: a, col: 0, rowAbs: m[1] === '$', colAbs: false },
					{ row: b, col: 0, rowAbs: m[3] === '$', colAbs: false }
				);
			}
		}
		if ((m = CELL_RE.exec(r))) {
			const a = cellPos(m);
			if (a) {
				i += m[0].length;
				if (peek(':')) {
					const save = i;
					i++;
					// A second sheet prefix must name the same sheet.
					const r2 = rest();
					const q = QUOTED_SHEET_RE.exec(r2) ?? SHEET_RE.exec(r2);
					if (q) {
						const other = q[1].replace(/''/g, "'");
						if (sheet === undefined || other.toLowerCase() !== sheet.toLowerCase()) fail();
						i += q[0].length;
					}
					const m2 = CELL_RE.exec(rest());
					const b = m2 && cellPos(m2);
					if (b && m2) {
						i += m2[0].length;
						return rangeOf('cells', sheet, a, b);
					}
					i = save;
				}
				const node: Node = { type: 'cell', ...a };
				if (sheet !== undefined) node.sheet = sheet;
				return node;
			}
		}
		if ((m = ERROR_RE.exec(r))) {
			i += m[0].length;
			const node: Node = { type: 'error', code: m[0].toUpperCase() };
			if (sheet !== undefined) node.sheet = sheet;
			return node;
		}
		return null;
	};

	const primary = (): Node => {
		ws();
		if (i >= s.length) fail('unexpected end');
		const c = s[i];
		if (c === '"') {
			let out = '';
			i++;
			for (;;) {
				const j = s.indexOf('"', i);
				if (j < 0) fail('unterminated string');
				out += s.slice(i, j);
				i = j + 1;
				if (s[i] === '"') {
					out += '"';
					i++;
				} else break;
			}
			return { type: 'string', value: out };
		}
		if (c === '(') {
			i++;
			const expr = expression();
			ws();
			if (!peek(')')) fail('expected )');
			i++;
			return { type: 'paren', expr };
		}
		if (c === '{') return array();
		if (c === '#') {
			const m = ERROR_RE.exec(rest());
			if (!m) fail('unknown error value');
			i += m![0].length;
			return { type: 'error', code: m![0].toUpperCase() };
		}
		const r = rest();
		// Rows (`1:3`) before numbers, since both start with a digit.
		if (c === '$') return reference(undefined) ?? fail('expected a reference');
		if (/\d/.test(c) || c === '.') {
			const ref = reference(undefined);
			if (ref) return ref;
			const m = NUMBER_RE.exec(r);
			if (!m) fail();
			i += m![0].length;
			const value = Number(m![0]);
			if (!Number.isFinite(value)) fail('number out of range');
			return { type: 'number', value, raw: m![0] };
		}
		let m: RegExpExecArray | null;
		if ((m = QUOTED_SHEET_RE.exec(r) ?? SHEET_RE.exec(r))) {
			const sheet = m[1].replace(/''/g, "'");
			i += m[0].length;
			const ref = reference(sheet);
			if (ref) return ref;
			const n = NAME_RE.exec(rest());
			if (!n) fail('expected a reference');
			i += n![0].length;
			return { type: 'name', name: n![0], sheet };
		}
		if ((m = FUNC_RE.exec(r))) {
			i += m[0].length;
			const written = m[1];
			const pre = PREFIX_RE.exec(written);
			const prefix = pre ? pre[1] : '';
			const name = written.slice(prefix.length).toUpperCase();
			if (name === '') fail('bad function name');
			const args = call();
			return { type: 'call', name, prefix, args };
		}
		const ref = reference(undefined);
		if (ref) return ref;
		if ((m = /^(TRUE|FALSE)(?![\w.(])/i.exec(r))) {
			i += m[0].length;
			return { type: 'bool', value: m[1].toUpperCase() === 'TRUE' };
		}
		if ((m = NAME_RE.exec(r))) {
			i += m[0].length;
			return { type: 'name', name: m[0] };
		}
		return fail();
	};

	const call = (): Node[] => {
		const args: Node[] = [];
		ws();
		if (peek(')')) {
			i++;
			return args;
		}
		for (;;) {
			ws();
			if (peek(',') || peek(')')) args.push({ type: 'missing' });
			else args.push(expression());
			ws();
			if (peek(',')) {
				i++;
				continue;
			}
			if (peek(')')) {
				i++;
				return args;
			}
			fail('expected , or )');
		}
	};

	const constant = (): Node => {
		ws();
		const r = rest();
		let m: RegExpExecArray | null;
		if ((m = /^([+-]?)(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(r))) {
			i += m[0].length;
			return { type: 'number', value: Number(m[0]), raw: m[0] };
		}
		if (s[i] === '"' || s[i] === '#') return primary();
		if ((m = /^(TRUE|FALSE)(?![\w.(])/i.exec(r))) {
			i += m[0].length;
			return { type: 'bool', value: m[1].toUpperCase() === 'TRUE' };
		}
		return fail('expected a constant');
	};

	const array = (): Node => {
		i++;
		const rows: Node[][] = [[]];
		for (;;) {
			rows[rows.length - 1].push(constant());
			ws();
			if (peek(',')) i++;
			else if (peek(';')) {
				i++;
				rows.push([]);
			} else if (peek('}')) {
				i++;
				break;
			} else fail('expected , ; or }');
		}
		if (rows.some((r) => r.length !== rows[0].length)) fail('ragged array');
		return { type: 'array', rows };
	};

	const postfix = (): Node => {
		let n = primary();
		ws();
		while (peek('%')) {
			i++;
			n = { type: 'percent', arg: n };
			ws();
		}
		return n;
	};

	const unary = (): Node => {
		ws();
		if (peek('-') || peek('+')) {
			const op = s[i] as '-' | '+';
			i++;
			if (++depth > MAX_DEPTH) fail('nested too deep');
			const arg = unary();
			depth--;
			return { type: 'unary', op, arg };
		}
		return postfix();
	};

	const binary = (next: () => Node, ops: BinaryOp[]) => (): Node => {
		let left = next();
		for (;;) {
			ws();
			// Longer operators are listed first, so `<=` is never read as `<`.
			const op = ops.find((o) => peek(o));
			if (!op) return left;
			i += op.length;
			left = { type: 'binary', op, left, right: next() };
		}
	};

	const power = binary(unary, ['^']);
	const product = binary(power, ['*', '/']);
	const sum = binary(product, ['+', '-']);
	const concat = binary(sum, ['&']);
	const comparison = binary(concat, ['<>', '<=', '>=', '=', '<', '>']);

	function expression(): Node {
		if (++depth > MAX_DEPTH) fail('nested too deep');
		const n = comparison();
		depth--;
		return n;
	}

	const root = expression();
	ws();
	if (i < s.length) fail();
	return root;
}
