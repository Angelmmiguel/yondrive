/**
 * Excel number format codes, for display and for TEXT: General, fixed decimals,
 * thousands separators and scaling, percent, scientific, simple fractions,
 * currency and literal text, dates, times and elapsed time, and up to four
 * sections with conditions. Colours are recognised and ignored. Output is en-US.
 */
import { serialToYmd, weekday, MAX_SERIAL } from './dates';
import { isError, numberToText, type Scalar } from './values';

/** The built-in formats by id, as an en-US Excel shows them. */
export const BUILTIN_FORMATS: Record<number, string> = {
	0: 'General',
	1: '0',
	2: '0.00',
	3: '#,##0',
	4: '#,##0.00',
	5: '"$"#,##0_);\\("$"#,##0\\)',
	6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
	7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
	8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
	9: '0%',
	10: '0.00%',
	11: '0.00E+00',
	12: '# ?/?',
	13: '# ??/??',
	14: 'm/d/yyyy',
	15: 'd-mmm-yy',
	16: 'd-mmm',
	17: 'mmm-yy',
	18: 'h:mm AM/PM',
	19: 'h:mm:ss AM/PM',
	20: 'h:mm',
	21: 'h:mm:ss',
	22: 'm/d/yyyy h:mm',
	37: '#,##0_);(#,##0)',
	38: '#,##0_);[Red](#,##0)',
	39: '#,##0.00_);(#,##0.00)',
	40: '#,##0.00_);[Red](#,##0.00)',
	41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
	42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
	43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
	44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
	45: 'mm:ss',
	46: '[h]:mm:ss',
	47: 'mm:ss.0',
	48: '##0.0E+0',
	49: '@'
};

type Tok =
	| { t: 'lit'; s: string }
	| { t: 'digit'; c: '0' | '#' | '?' }
	| { t: 'point' }
	| { t: 'comma' }
	| { t: 'percent' }
	| { t: 'exp'; sign: '+' | '-' }
	| { t: 'slash' }
	| { t: 'text' }
	| { t: 'general' }
	| { t: 'date'; s: string }
	| { t: 'elapsed'; unit: 'h' | 'm' | 's'; width: number }
	| { t: 'ampm'; s: string }
	| { t: 'subsec'; digits: number };

interface Section {
	toks: Tok[];
	cond?: { op: string; value: number };
	date: boolean;
}

const COLORS = /^(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)$/i;

function tokenize(code: string): Section[] {
	const sections: Section[] = [];
	let toks: Tok[] = [];
	let cond: Section['cond'];
	const lit = (s: string) => {
		const last = toks[toks.length - 1];
		if (last?.t === 'lit') last.s += s;
		else toks.push({ t: 'lit', s });
	};
	let i = 0;
	const finish = () => {
		sections.push({
			toks,
			cond,
			date: toks.some((t) => t.t === 'date' || t.t === 'elapsed' || t.t === 'ampm')
		});
		toks = [];
		cond = undefined;
	};
	while (i < code.length) {
		const c = code[i];
		const lower = c.toLowerCase();
		if (c === '"') {
			const j = code.indexOf('"', i + 1);
			lit(code.slice(i + 1, j < 0 ? code.length : j));
			i = j < 0 ? code.length : j + 1;
		} else if (c === '\\') {
			lit(code[i + 1] ?? '');
			i += 2;
		} else if (c === '_') {
			lit(' ');
			i += 2;
		} else if (c === '*') {
			i += 2;
		} else if (c === ';') {
			finish();
			i++;
		} else if (c === '[') {
			const j = code.indexOf(']', i);
			const body = code.slice(i + 1, j < 0 ? code.length : j);
			i = j < 0 ? code.length : j + 1;
			let m: RegExpExecArray | null;
			if (COLORS.test(body)) continue;
			if ((m = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:e[+-]?\d+)?)$/i.exec(body))) {
				cond = { op: m[1], value: Number(m[2]) };
			} else if ((m = /^(h+|m+|s+)$/i.exec(body))) {
				toks.push({
					t: 'elapsed',
					unit: m[1][0].toLowerCase() as 'h' | 'm' | 's',
					width: m[1].length
				});
			} else if (body.startsWith('$')) {
				const dash = body.indexOf('-');
				lit(body.slice(1, dash < 0 ? body.length : dash));
			}
		} else if (/^general/i.test(code.slice(i))) {
			toks.push({ t: 'general' });
			i += 7;
		} else if (c === '0' || c === '#' || c === '?') {
			toks.push({ t: 'digit', c });
			i++;
		} else if (c === '.') {
			// Fractional seconds: `ss.00`.
			const prev = toks[toks.length - 1];
			const m = /^\.(0+)/.exec(code.slice(i));
			if (m && prev?.t === 'date' && prev.s[0] === 's') {
				toks.push({ t: 'subsec', digits: Math.min(m[1].length, 3) });
				i += m[0].length;
			} else if (m && prev?.t === 'elapsed' && prev.unit === 's') {
				toks.push({ t: 'subsec', digits: Math.min(m[1].length, 3) });
				i += m[0].length;
			} else {
				toks.push({ t: 'point' });
				i++;
			}
		} else if (c === ',') {
			toks.push({ t: 'comma' });
			i++;
		} else if (c === '%') {
			toks.push({ t: 'percent' });
			i++;
		} else if (lower === 'e' && (code[i + 1] === '+' || code[i + 1] === '-')) {
			toks.push({ t: 'exp', sign: code[i + 1] as '+' | '-' });
			i += 2;
		} else if (c === '/') {
			toks.push({ t: 'slash' });
			i++;
		} else if (c === '@') {
			toks.push({ t: 'text' });
			i++;
		} else if (/^(am\/pm|a\/p)/i.test(code.slice(i))) {
			const m = /^(am\/pm|a\/p)/i.exec(code.slice(i))!;
			toks.push({ t: 'ampm', s: m[1] });
			i += m[1].length;
		} else if ('ymdhs'.includes(lower)) {
			let j = i;
			while (j < code.length && code[j].toLowerCase() === lower) j++;
			toks.push({ t: 'date', s: lower.repeat(j - i) });
			i = j;
		} else if (lower === 'e' || lower === 'g' || lower === 'b') {
			// Era and calendar codes of other locales: shown as the year, or nothing.
			if (lower === 'e') toks.push({ t: 'date', s: 'yyyy' });
			i++;
		} else {
			lit(c);
			i++;
		}
	}
	finish();
	// `m` is minutes after an hour or before a second, months otherwise.
	for (const s of sections) {
		const dates = s.toks.filter((t) => t.t === 'date' || t.t === 'elapsed') as (
			{ t: 'date'; s: string } | { t: 'elapsed'; unit: string }
		)[];
		dates.forEach((t, k) => {
			if (t.t !== 'date' || t.s[0] !== 'm' || t.s.length > 2) return;
			const prev = dates[k - 1];
			const next = dates[k + 1];
			const afterHour =
				prev &&
				((prev.t === 'date' && prev.s[0] === 'h') || (prev.t === 'elapsed' && prev.unit === 'h'));
			const beforeSecond =
				next &&
				((next.t === 'date' && next.s[0] === 's') || (next.t === 'elapsed' && next.unit === 's'));
			if (afterHour || beforeSecond) t.s = t.s.replace(/m/g, 'M');
		});
	}
	return sections;
}

const cache = new Map<string, Section[]>();

function sectionsOf(code: string): Section[] {
	let s = cache.get(code);
	if (!s) {
		s = tokenize(code);
		if (cache.size > 2000) cache.clear();
		cache.set(code, s);
	}
	return s;
}

/** Whether a format shows numbers as dates or times. */
export function isDateFormat(code: string): boolean {
	return sectionsOf(code).some((s) => s.date);
}

/** Rounds half away from zero on the decimal digits Excel keeps (15). */
export function roundDecimal(
	x: number,
	digits: number,
	mode: 'round' | 'up' | 'down' = 'round'
): number {
	if (!Number.isFinite(x) || x === 0) return x;
	const sign = x < 0 ? -1 : 1;
	const [mant, exp] = Math.abs(x).toPrecision(15).split('e');
	const shifted = Number(`${mant}e${Number(exp ?? 0) + digits}`);
	const f = mode === 'round' ? Math.round : mode === 'up' ? Math.ceil : Math.floor;
	// Math.round rounds .5 up, which for a positive magnitude is away from zero.
	if (!Number.isFinite(shifted) || Math.abs(shifted) >= 1e15) return x;
	const r = f(Number(shifted.toPrecision(15)));
	return sign * Number(`${r}e${-digits}`);
}

/** General: what fits in 11 characters, switching to scientific when that shows more. */
export function formatGeneral(n: number): string {
	if (n === 0) return '0';
	const abs = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	const sci = () => {
		const [mant, e] = abs.toExponential(5).split('e');
		const m = mant.replace(/\.?0+$/, '');
		const ex = Number(e);
		return `${sign}${m}E${ex < 0 ? '-' : '+'}${String(Math.abs(ex)).padStart(2, '0')}`;
	};
	if (abs >= 1e11) return sci();
	const intDigits = abs < 1 ? 1 : Math.floor(Math.log10(abs)) + 1;
	const decimals = Math.max(0, 10 - intDigits);
	let fixed = roundDecimal(abs, decimals).toFixed(decimals);
	if (fixed.includes('.')) fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
	if (fixed.replace('.', '').length > 11) return sci();
	if (abs < 1) {
		const sigFixed = fixed.replace(/^0\.0*/, '').length;
		const sigSci = abs
			.toExponential(5)
			.split('e')[0]
			.replace(/\.?0+$/, '')
			.replace('.', '').length;
		if (sigFixed < sigSci || fixed === '0') return sci();
	}
	return sign + fixed;
}

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDate(v: number, s: Section, date1904: boolean): string {
	if (v < 0 || v > MAX_SERIAL + 1) return '#'.repeat(11);
	const sub = s.toks.find((t) => t.t === 'subsec') as { digits: number } | undefined;
	const prec = 10 ** (sub?.digits ?? 0);
	const total = Math.round(v * 86400 * prec) / prec;
	const day = Math.floor(total / 86400 + 1e-9);
	const secs = total - day * 86400;
	const ymd = serialToYmd(day, date1904) ?? { year: 0, month: 0, day: 0 };
	const h24 = Math.floor(secs / 3600);
	const min = Math.floor((secs % 3600) / 60);
	const sec = Math.floor(secs % 60);
	const frac = secs - Math.floor(secs);
	const ampm = s.toks.some((t) => t.t === 'ampm');
	const pad = (n: number, w: number) => String(n).padStart(w, '0');
	let out = '';
	for (const t of s.toks) {
		switch (t.t) {
			case 'lit':
				out += t.s;
				break;
			case 'date': {
				const k = t.s;
				const n = k.length;
				if (k[0] === 'y') out += n <= 2 ? pad(ymd.year % 100, 2) : pad(ymd.year, 4);
				else if (k[0] === 'm') {
					if (n === 1) out += ymd.month;
					else if (n === 2) out += pad(ymd.month, 2);
					else if (n === 3) out += MONTHS[ymd.month - 1]?.slice(0, 3) ?? '';
					else if (n === 5) out += MONTHS[ymd.month - 1]?.[0] ?? '';
					else out += MONTHS[ymd.month - 1] ?? '';
				} else if (k[0] === 'M') out += n === 1 ? min : pad(min, 2);
				else if (k[0] === 'd') {
					if (n === 1) out += ymd.day;
					else if (n === 2) out += pad(ymd.day, 2);
					else if (n === 3) out += DAYS[weekday(day)].slice(0, 3);
					else out += DAYS[weekday(day)];
				} else if (k[0] === 'h') {
					const h = ampm ? h24 % 12 || 12 : h24;
					out += n === 1 ? h : pad(h, 2);
				} else if (k[0] === 's') out += n === 1 ? sec : pad(sec, 2);
				break;
			}
			case 'elapsed': {
				const n =
					t.unit === 'h'
						? Math.floor(total / 3600)
						: t.unit === 'm'
							? Math.floor(total / 60)
							: Math.floor(total);
				out += pad(n, t.width);
				break;
			}
			case 'subsec':
				out += `.${frac.toFixed(t.digits).slice(2)}`;
				break;
			case 'ampm': {
				const pm = h24 >= 12;
				if (t.s.length > 3) out += pm ? 'PM' : 'AM';
				else out += t.s[0] === 'a' ? (pm ? 'p' : 'a') : pm ? 'P' : 'A';
				break;
			}
			case 'digit':
				out += t.c === '0' ? '0' : '';
				break;
			case 'point':
				out += '.';
				break;
			case 'comma':
				out += ',';
				break;
			case 'slash':
				out += '/';
				break;
			case 'percent':
				out += '%';
				break;
			default:
				break;
		}
	}
	return out;
}

/** Fills placeholders with digits, right to left, the first taking any extra. */
function fillInt(digits: string, ph: ('0' | '#' | '?')[]): string[] {
	const out: string[] = ph.map(() => '');
	let d = digits.length - 1;
	for (let k = ph.length - 1; k >= 0; k--) {
		if (d >= 0) out[k] = digits[d--];
		else out[k] = ph[k] === '0' ? '0' : ph[k] === '?' ? ' ' : '';
	}
	if (d >= 0 && ph.length > 0) out[0] = digits.slice(0, d + 1) + out[0];
	return out;
}

function bestFraction(x: number, maxDen: number): [number, number] {
	let [h0, h1, k0, k1] = [0, 1, 1, 0];
	let f = x;
	for (let i = 0; i < 64; i++) {
		const a = Math.floor(f);
		const h2 = a * h1 + h0;
		const k2 = a * k1 + k0;
		if (k2 > maxDen) break;
		[h0, h1, k0, k1] = [h1, h2, k1, k2];
		if (Math.abs(f - a) < 1e-12) break;
		f = 1 / (f - a);
	}
	// The best of the last convergent and the semiconvergents below maxDen.
	let best: [number, number] = [h1, k1];
	for (let den = 1; den <= maxDen && maxDen <= 999; den++) {
		const num = Math.round(x * den);
		if (Math.abs(num / den - x) < Math.abs(best[0] / best[1] - x) - 1e-15) best = [num, den];
	}
	return best;
}

function formatNumber(v: number, s: Section, showSign: boolean): string {
	const toks = s.toks;
	if (toks.some((t) => t.t === 'general')) {
		const g = formatGeneral(Math.abs(v));
		let out = '';
		for (const t of toks) out += t.t === 'general' ? g : t.t === 'lit' ? t.s : '';
		return (showSign && v < 0 ? '-' : '') + out;
	}
	const percents = toks.filter((t) => t.t === 'percent').length;
	let x = Math.abs(v) * 100 ** percents;
	const digitIdx = toks.map((t, k) => (t.t === 'digit' ? k : -1)).filter((k) => k >= 0);
	if (digitIdx.length === 0) {
		// Only literals: the number is not shown.
		return (
			(showSign && v < 0 ? '-' : '') +
			toks.map((t) => (t.t === 'lit' ? t.s : t.t === 'percent' ? '%' : '')).join('')
		);
	}
	const slash = toks.findIndex((t) => t.t === 'slash');
	const expAt = toks.findIndex((t) => t.t === 'exp');
	const pointAt = toks.findIndex((t) => t.t === 'point');
	// A comma between integer placeholders groups thousands; one with no
	// placeholder after it in its part of the number divides by a thousand.
	let scale = 0;
	let grouping = false;
	toks.forEach((t, k) => {
		if (t.t !== 'comma' || k < digitIdx[0]) return;
		const end = pointAt > k ? pointAt : expAt > k ? expAt : toks.length;
		const digitAfter = toks.slice(k + 1, end).some((u) => u.t === 'digit');
		if (!digitAfter) scale++;
		else if (pointAt < 0 || k < pointAt) grouping = true;
	});
	x /= 1000 ** scale;
	const sign = showSign && v < 0 ? '-' : '';

	if (slash >= 0 && expAt < 0) return sign + formatFraction(x, toks, slash);

	let exponent = 0;
	const intPh = toks
		.slice(0, pointAt >= 0 ? pointAt : expAt >= 0 ? expAt : toks.length)
		.filter((t) => t.t === 'digit') as { c: '0' | '#' | '?' }[];
	const decEnd = expAt >= 0 ? expAt : toks.length;
	const decPh =
		pointAt >= 0
			? (toks.slice(pointAt + 1, decEnd).filter((t) => t.t === 'digit') as { c: '0' | '#' | '?' }[])
			: [];
	// toFixed takes at most 100 digits; placeholders past them show zeros.
	const places = Math.min(decPh.length, 100);
	if (expAt >= 0 && x !== 0) {
		const step = intPh.length > 1 && intPh.some((p) => p.c === '#') ? intPh.length : 1;
		exponent = Math.floor(Math.log10(x));
		exponent = Math.floor(exponent / step) * step;
		x = x / 10 ** exponent;
		const r = roundDecimal(x, places);
		if (r >= 10 ** step) {
			exponent += step;
			x /= 10 ** step;
		}
	}
	const rounded = roundDecimal(x, places);
	const fixed = rounded.toFixed(places);
	const [ip, fp = ''] = fixed.split('.');
	let intDigits = ip === '0' && !intPh.some((p) => p.c === '0') ? '' : ip;
	if (intPh.length === 0) intDigits = '';
	const intOut = fillInt(
		intDigits,
		intPh.map((p) => p.c)
	);
	// Fraction digits: trailing zeros disappear under '#' and become spaces under '?'.
	const decOut = decPh.map((p, k) => fp[k] ?? '0');
	for (let k = decPh.length - 1; k >= 0; k--) {
		if (decOut[k] !== '0' || decPh[k].c === '0') break;
		decOut[k] = decPh[k].c === '?' ? ' ' : '';
	}
	const totalInt = intOut.join('').replace(/[^\d]/g, '').length;
	let out = sign;
	let ii = 0;
	let di = 0;
	let seenInt = 0;
	let afterPoint = false;
	let inExp = false;
	const expPh: string[] = [];
	for (let k = 0; k < toks.length; k++) {
		const t = toks[k];
		if (inExp) {
			if (t.t === 'digit') expPh.push(t.c);
			else if (t.t === 'lit') {
				out += renderExp();
				expPh.length = 0;
				inExp = false;
				out += t.s;
			}
			continue;
		}
		switch (t.t) {
			case 'digit':
				if (!afterPoint) {
					const chunk = intOut[ii++] ?? '';
					for (const ch of chunk) {
						out += ch;
						if (/\d/.test(ch)) {
							seenInt++;
							const left = totalInt - seenInt;
							if (grouping && left > 0 && left % 3 === 0) out += ',';
						}
					}
				} else out += decOut[di++] ?? '';
				break;
			case 'point':
				afterPoint = true;
				out += '.';
				break;
			case 'lit':
				out += t.s;
				break;
			case 'percent':
				out += '%';
				break;
			case 'exp':
				out += 'E';
				inExp = true;
				expPh.length = 0;
				break;
			case 'text':
				break;
			case 'comma':
				break;
			default:
				break;
		}
	}
	if (inExp) out += renderExp();
	return out;

	function renderExp(): string {
		const expTok = toks[expAt] as { sign: '+' | '-' };
		const sgn = exponent < 0 ? '-' : expTok.sign === '+' ? '+' : '';
		const digits = String(Math.abs(exponent)).padStart(expPh.filter((c) => c === '0').length, '0');
		return sgn + digits;
	}
}

function formatFraction(x: number, toks: Tok[], slash: number): string {
	const before = toks.slice(0, slash);
	const after = toks.slice(slash + 1);
	const denPh = after.filter((t) => t.t === 'digit').length;
	const fixedDen = /^\d+$/.test(
		after
			.filter((t) => t.t === 'lit')
			.map((t) => (t as { s: string }).s)
			.join('')
			.trim()
	)
		? Number(
				after
					.map((t) => (t.t === 'lit' ? t.s : ''))
					.join('')
					.trim()
			)
		: 0;
	// An integer part when there is a placeholder before the numerator's, after a space.
	const lastLit =
		before
			.map((t, k) => (t.t === 'lit' ? k : -1))
			.filter((k) => k >= 0)
			.pop() ?? -1;
	const intToks = lastLit >= 0 ? before.slice(0, lastLit).filter((t) => t.t === 'digit') : [];
	const numToks = before.slice(lastLit + 1).filter((t) => t.t === 'digit');
	let whole = 0;
	let rest = x;
	if (intToks.length > 0) {
		whole = Math.floor(x);
		rest = x - whole;
	}
	let num: number;
	let den: number;
	if (fixedDen > 0) {
		den = fixedDen;
		num = Math.round(rest * den);
	} else {
		[num, den] = bestFraction(rest, 10 ** Math.max(1, denPh) - 1);
	}
	if (intToks.length > 0 && num === den) {
		whole += 1;
		num = 0;
	}
	const pad = (s: string, n: number, left: boolean) => (left ? s.padStart(n) : s.padEnd(n));
	const wholeText = intToks.length > 0 ? (whole === 0 && num !== 0 ? '' : String(whole)) : '';
	if (intToks.length > 0 && num === 0) return pad(wholeText || '0', 1, true);
	const sep = intToks.length > 0 && wholeText !== '' ? ' ' : '';
	return `${wholeText}${sep}${pad(String(num), numToks.length, true)}/${fixedDen > 0 ? den : pad(String(den), denPh, false)}`;
}

function matches(cond: NonNullable<Section['cond']>, v: number): boolean {
	switch (cond.op) {
		case '<':
			return v < cond.value;
		case '<=':
			return v <= cond.value;
		case '>':
			return v > cond.value;
		case '>=':
			return v >= cond.value;
		case '=':
			return v === cond.value;
		default:
			return v !== cond.value;
	}
}

export interface FormatOptions {
	date1904?: boolean;
}

/** A value as a cell with this format shows it. */
export function formatValue(v: Scalar, code: string, opts: FormatOptions = {}): string {
	if (v === null) return '';
	if (isError(v)) return v.error;
	if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
	const sections = sectionsOf(code || 'General');
	if (typeof v === 'string') {
		const textSec = sections[3] ?? sections.find((s) => s.toks.some((t) => t.t === 'text'));
		if (!textSec) return v;
		return textSec.toks.map((t) => (t.t === 'text' ? v : t.t === 'lit' ? t.s : '')).join('');
	}
	if (!Number.isFinite(v)) return '#NUM!';
	let sec: Section;
	let showSign = true;
	const numeric = sections.slice(0, 3);
	if (numeric.some((s) => s.cond)) {
		const pick = numeric.find((s) => (s.cond ? matches(s.cond, v) : true));
		if (!pick) return '#'.repeat(11);
		sec = pick;
	} else if (numeric.length === 1 || v > 0 || (v === 0 && numeric.length < 3)) {
		sec = numeric[0];
		if (v === 0 || v > 0) showSign = false;
	} else if (v < 0) {
		sec = numeric[1];
		showSign = false;
	} else {
		sec = numeric[2];
	}
	if (sec.toks.length === 0) return '';
	if (sec.date)
		return formatDate(
			sec === numeric[1] && !showSign ? Math.abs(v) : v,
			sec,
			opts.date1904 ?? false
		);
	if (
		sec.toks.some((t) => t.t === 'text') &&
		!sec.toks.some((t) => t.t === 'digit' || t.t === 'general')
	) {
		return sec.toks
			.map((t) => (t.t === 'text' ? numberToText(v) : t.t === 'lit' ? t.s : ''))
			.join('');
	}
	return formatNumber(v, sec, showSign);
}

/** The number format a code needs for its id in a file: the built-in id, or -1. */
export function builtinIdOf(code: string): number {
	for (const [id, c] of Object.entries(BUILTIN_FORMATS)) if (c === code) return Number(id);
	return -1;
}
