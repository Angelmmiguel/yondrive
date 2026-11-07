/**
 * A parsed formula, and printing it back. Formulas are stored in en-US syntax
 * in files, which is the syntax here. Newer functions are written to files with
 * a prefix (`_xlfn.CONCAT`) that people never see; the printer adds it for files
 * and leaves it out for display. OpenDocument has its own reference syntax, also
 * printed from the same tree.
 */
import { colName, MAX_COLS, MAX_ROWS } from './address';

export interface CellNode {
	type: 'cell';
	sheet?: string;
	row: number;
	col: number;
	rowAbs: boolean;
	colAbs: boolean;
}

export interface RangeNode {
	type: 'range';
	sheet?: string;
	/** Whole columns (`A:C`), whole rows (`2:5`), or a block of cells. */
	kind: 'cells' | 'cols' | 'rows';
	top: number;
	left: number;
	bottom: number;
	right: number;
	topAbs: boolean;
	leftAbs: boolean;
	bottomAbs: boolean;
	rightAbs: boolean;
}

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=';

export type Node =
	| { type: 'number'; value: number; raw: string }
	| { type: 'string'; value: string }
	| { type: 'bool'; value: boolean }
	/** An error literal, or a reference that was deleted (`Sheet1!#REF!`). */
	| { type: 'error'; code: string; sheet?: string }
	| CellNode
	| RangeNode
	| { type: 'name'; name: string; sheet?: string }
	/** `name` in upper case without its prefix; `prefix` as written (`_xlfn.`). */
	| { type: 'call'; name: string; prefix: string; args: Node[] }
	| { type: 'unary'; op: '-' | '+'; arg: Node }
	| { type: 'percent'; arg: Node }
	| { type: 'binary'; op: BinaryOp; left: Node; right: Node }
	| { type: 'paren'; expr: Node }
	| { type: 'array'; rows: Node[][] }
	| { type: 'missing' };

export type RefNode = CellNode | RangeNode;

/** Functions written to files with `_xlfn.`, of those this engine knows. */
const FUTURE = new Set(['CONCAT']);

export interface PrintOptions {
	/** `file` adds the `_xlfn.` prefixes; `display` is what a person types. */
	mode?: 'file' | 'display' | 'odf';
}

const PLAIN_SHEET = /^[A-Za-z_¡-￿][A-Za-z0-9_.¡-￿]*$/;

/** A sheet name as a formula needs it: quoted when it is not a plain word. */
export function quoteSheet(name: string): string {
	const looksLikeRef =
		/^[A-Za-z]{1,3}\d+$/.test(name) || /^R\d*C\d*$/i.test(name) || /^(TRUE|FALSE)$/i.test(name);
	if (PLAIN_SHEET.test(name) && !looksLikeRef) return name;
	return `'${name.replace(/'/g, "''")}'`;
}

const cellText = (row: number, col: number, rowAbs: boolean, colAbs: boolean) =>
	`${colAbs ? '$' : ''}${colName(col)}${rowAbs ? '$' : ''}${row + 1}`;

function refText(n: RefNode, mode: PrintOptions['mode']): string {
	if (mode === 'odf') return odfRef(n);
	const prefix = n.sheet === undefined ? '' : `${quoteSheet(n.sheet)}!`;
	if (n.type === 'cell') return prefix + cellText(n.row, n.col, n.rowAbs, n.colAbs);
	if (n.kind === 'cols') {
		return `${prefix}${n.leftAbs ? '$' : ''}${colName(n.left)}:${n.rightAbs ? '$' : ''}${colName(n.right)}`;
	}
	if (n.kind === 'rows') {
		return `${prefix}${n.topAbs ? '$' : ''}${n.top + 1}:${n.bottomAbs ? '$' : ''}${n.bottom + 1}`;
	}
	return `${prefix}${cellText(n.top, n.left, n.topAbs, n.leftAbs)}:${cellText(n.bottom, n.right, n.bottomAbs, n.rightAbs)}`;
}

function odfRef(n: RefNode): string {
	const sheet = n.sheet === undefined ? '' : `$${quoteSheet(n.sheet)}`;
	const at = (row: number, col: number, rowAbs: boolean, colAbs: boolean) =>
		`${sheet}.${cellText(row, col, rowAbs, colAbs)}`;
	if (n.type === 'cell') return `[${at(n.row, n.col, n.rowAbs, n.colAbs)}]`;
	if (n.kind === 'cols') {
		return `[${sheet}.${n.leftAbs ? '$' : ''}${colName(n.left)}:.${n.rightAbs ? '$' : ''}${colName(n.right)}]`;
	}
	if (n.kind === 'rows') {
		return `[${sheet}.${n.topAbs ? '$' : ''}${n.top + 1}:.${n.bottomAbs ? '$' : ''}${n.bottom + 1}]`;
	}
	return `[${at(n.top, n.left, n.topAbs, n.leftAbs)}:.${cellText(n.bottom, n.right, n.bottomAbs, n.rightAbs)}]`;
}

/** The formula text of a tree, without the leading `=`. */
export function print(node: Node, opts: PrintOptions = {}): string {
	const mode = opts.mode ?? 'file';
	const sep = mode === 'odf' ? ';' : ',';
	const p = (n: Node): string => {
		switch (n.type) {
			case 'number':
				return n.raw;
			case 'string':
				return `"${n.value.replace(/"/g, '""')}"`;
			case 'bool':
				return mode === 'odf' ? (n.value ? 'TRUE()' : 'FALSE()') : n.value ? 'TRUE' : 'FALSE';
			case 'error':
				if (mode === 'odf' && n.code === '#REF!') return '[.#REF!]';
				return n.sheet === undefined || mode === 'odf'
					? n.code
					: `${quoteSheet(n.sheet)}!${n.code}`;
			case 'cell':
			case 'range':
				return refText(n, mode);
			case 'name':
				return n.sheet === undefined ? n.name : `${quoteSheet(n.sheet)}!${n.name}`;
			case 'call': {
				let name = n.name;
				if (mode === 'file') name = (n.prefix || (FUTURE.has(n.name) ? '_xlfn.' : '')) + n.name;
				else if (mode === 'odf' && n.name === 'CONCAT') name = 'COM.MICROSOFT.CONCAT';
				return `${name}(${n.args.map(p).join(sep)})`;
			}
			case 'unary':
				return n.op + p(n.arg);
			case 'percent':
				return `${p(n.arg)}%`;
			case 'binary':
				return p(n.left) + n.op + p(n.right);
			case 'paren':
				return `(${p(n.expr)})`;
			case 'array':
				return `{${n.rows.map((r) => r.map(p).join(sep)).join(';')}}`;
			case 'missing':
				return '';
		}
	};
	return p(node);
}

/** Every node, parents first. */
export function* walk(node: Node): Generator<Node> {
	yield node;
	switch (node.type) {
		case 'call':
			for (const a of node.args) yield* walk(a);
			break;
		case 'unary':
		case 'percent':
			yield* walk(node.arg);
			break;
		case 'binary':
			yield* walk(node.left);
			yield* walk(node.right);
			break;
		case 'paren':
			yield* walk(node.expr);
			break;
		case 'array':
			for (const r of node.rows) for (const c of r) yield* walk(c);
			break;
	}
}

/** A copy of the tree with each reference replaced by what `f` gives; the same tree if none changed. */
export function mapRefs(node: Node, f: (ref: RefNode) => Node): Node {
	switch (node.type) {
		case 'cell':
		case 'range':
			return f(node);
		case 'call': {
			const args = node.args.map((a) => mapRefs(a, f));
			return args.some((a, i) => a !== node.args[i]) ? { ...node, args } : node;
		}
		case 'unary':
		case 'percent': {
			const arg = mapRefs(node.arg, f);
			return arg === node.arg ? node : { ...node, arg };
		}
		case 'binary': {
			const left = mapRefs(node.left, f);
			const right = mapRefs(node.right, f);
			return left === node.left && right === node.right ? node : { ...node, left, right };
		}
		case 'paren': {
			const expr = mapRefs(node.expr, f);
			return expr === node.expr ? node : { ...node, expr };
		}
		default:
			return node;
	}
}

/** A whole-column or whole-row range keeps to the edges of the grid. */
export function rangeOf(
	kind: RangeNode['kind'],
	sheet: string | undefined,
	a: { row: number; col: number; rowAbs: boolean; colAbs: boolean },
	b: { row: number; col: number; rowAbs: boolean; colAbs: boolean }
): RangeNode {
	const [top, topAbs, bottom, bottomAbs] =
		kind === 'cols'
			? [0, false, MAX_ROWS - 1, false]
			: a.row <= b.row
				? [a.row, a.rowAbs, b.row, b.rowAbs]
				: [b.row, b.rowAbs, a.row, a.rowAbs];
	const [left, leftAbs, right, rightAbs] =
		kind === 'rows'
			? [0, false, MAX_COLS - 1, false]
			: a.col <= b.col
				? [a.col, a.colAbs, b.col, b.colAbs]
				: [b.col, b.colAbs, a.col, a.colAbs];
	const r: RangeNode = {
		type: 'range',
		kind,
		top,
		left,
		bottom,
		right,
		topAbs,
		leftAbs,
		bottomAbs,
		rightAbs
	};
	if (sheet !== undefined) r.sheet = sheet;
	return r;
}
