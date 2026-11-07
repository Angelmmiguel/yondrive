/**
 * Typed text and cells, both ways: what a text typed into a cell becomes, and
 * the text that, typed, gives a cell back as it is. Plain functions, used by
 * the worker and by the page.
 */
import { walk } from '$lib/formula/ast';
import { dateFromText } from '$lib/formula/dates';
import type { CellInput } from '$lib/formula/engine';
import { parseFormula } from '$lib/formula/parse';
import { err, isErrorCode, type ErrorCode } from '$lib/formula/values';
import type { CellView } from './service';
import { textOf } from './ui/history';

/**
 * What a typed text is: a formula, a value, or nothing; and the number format it
 * suggests. Dates become serials of the workbook's date system.
 */
export function parseInput(
	text: string,
	date1904 = false
): { input: CellInput | null; numFmt?: string } {
	if (text === '') return { input: null };
	if (text.startsWith("'")) return { input: { value: text.slice(1) } };
	if (text.startsWith('=') && text.length > 1) return { input: { formula: text.slice(1) } };
	const t = text.trim();
	const upper = t.toUpperCase();
	if (upper === 'TRUE' || upper === 'FALSE') return { input: { value: upper === 'TRUE' } };
	if (isErrorCode(upper)) return { input: { value: err(upper as ErrorCode) } };
	let m: RegExpExecArray | null;
	if ((m = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?%$/.exec(t)) && (m[2] || m[3])) {
		const n = Number(`${m[1]}${m[2].replace(/,/g, '') || '0'}.${m[3] ?? ''}`) / 100;
		const dec = (m[3] ?? '').length;
		return { input: { value: n }, numFmt: dec > 0 ? `0.${'0'.repeat(Math.min(dec, 10))}%` : '0%' };
	}
	// -$5 and $-5 alike.
	if ((m = /^(-?)\$(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t)) && !(m[1] && m[2])) {
		const n = Number(m[1] + m[2] + m[3].replace(/,/g, '') + (m[4] ?? ''));
		return { input: { value: n }, numFmt: m[4] ? '"$"#,##0.00' : '"$"#,##0' };
	}
	if ((m = /^(-?)(\d{1,3}(?:,\d{3})+)(\.\d+)?$/.exec(t))) {
		return {
			input: { value: Number(m[1] + m[2].replace(/,/g, '') + (m[3] ?? '')) },
			numFmt: m[3] ? '#,##0.00' : '#,##0'
		};
	}
	if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) {
		const n = Number(t);
		if (Number.isFinite(n)) return { input: { value: n } };
	}
	const d = /\d/.test(t) && !/^\d+$/.test(t) ? dateFromText(t, date1904) : null;
	if (d !== null) {
		const hasTime = /:/.test(t);
		const ampm = /\s*(am|pm|a|p)$/i.test(t);
		const secs = /:\d+:\d+/.test(t);
		const time = `h:mm${secs ? ':ss' : ''}${ampm ? ' AM/PM' : ''}`;
		// 25:00 is a duration past a day, as Excel shows it.
		if (hasTime && d >= 1 && /^\d+:\d/.test(t) && !ampm)
			return { input: { value: d }, numFmt: `[h]:mm${secs ? ':ss' : ''}` };
		const onlyTime = hasTime && d < 1;
		return {
			input: { value: d },
			numFmt: onlyTime ? time : hasTime ? `m/d/yyyy ${time}` : 'm/d/yyyy'
		};
	}
	// As Excel takes them from older spreadsheets: +A1 and -A1 are formulas, and
	// @SUM(A1) is =SUM(A1), when they read a cell or call a function.
	if (/^[+\-@]./.test(t)) {
		const body = t[0] === '@' ? t.slice(1) : t;
		try {
			const ast = parseFormula(body);
			if ([...walk(ast)].some((n) => n.type === 'cell' || n.type === 'range' || n.type === 'call'))
				return { input: { formula: body } };
		} catch {
			// Text after all.
		}
	}
	return { input: { value: text } };
}

/**
 * The text that, typed, gives a cell back as it is: what the formula bar and F2
 * show. Text that would be read as something else is quoted.
 */
export function inputOf(v: CellView | null | undefined, numFmt = 'General'): string {
	if (!v) return '';
	if (v.formula) return v.formula;
	const x = v.value;
	if (typeof x === 'number') {
		if (/%/.test(numFmt) || /[dmyhs]/i.test(numFmt.replace(/"[^"]*"|\[[^\]]*\]/g, '')))
			return v.text;
		return String(x);
	}
	if (typeof x === 'string') {
		const back = parseInput(x).input;
		return back !== null && 'value' in back && back.value === x ? x : `'${x}`;
	}
	return textOf(v);
}
