/**
 * Date serials of the 1900 date system: day 1 is 1900-01-01, and day 60 is the
 * 29 February 1900 that never was, kept because Excel kept it from Lotus 1-2-3.
 * From day 61 on, a serial counts days since 1899-12-30. The 1904 system, which
 * some workbooks use, starts at 1904-01-01 as day 0 and has no such day.
 */

/** The last day Excel accepts: 9999-12-31. */
export const MAX_SERIAL = 2958465;
const OFFSET_1904 = 1462;

const DAY_MS = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

export interface Ymd {
	year: number;
	month: number;
	day: number;
}

/**
 * The serial of a date, after Excel's DATE: months and days past their range
 * carry over, and years below 1900 count from 1900. Null when out of range.
 */
export function dateSerial(
	year: number,
	month: number,
	day: number,
	date1904 = false
): number | null {
	year = Math.trunc(year);
	month = Math.trunc(month);
	day = Math.trunc(day);
	if (year < 0 || year >= 10000) return null;
	if (year < 1900) year += 1900;
	const y = year + Math.floor((month - 1) / 12);
	const m = (((month - 1) % 12) + 12) % 12;
	const first = new Date(Date.UTC(2000, m, 1));
	first.setUTCFullYear(y);
	let serial = Math.round((first.getTime() - EPOCH) / DAY_MS);
	if (date1904) serial -= OFFSET_1904;
	// In Excel's calendar January and February 1900 start a day earlier, since
	// 1900-02-29 is a day there; counting days from the first of the month in that
	// calendar makes DATE(1900,1,60) the 29th, as it is in Excel.
	else if (y === 1900 && m <= 1) serial -= 1;
	serial += day - 1;
	if (y < 1900 || serial < 0 || serial > MAX_SERIAL) return null;
	return serial;
}

/** The calendar date of a serial's day; serial 0 is 1900-01-00, as Excel shows it. */
export function serialToYmd(serial: number, date1904 = false): Ymd | null {
	const n = Math.floor(serial);
	if (n < 0 || n > MAX_SERIAL) return null;
	if (date1904) return ymdOf(EPOCH + (n + OFFSET_1904) * DAY_MS);
	if (n === 0) return { year: 1900, month: 1, day: 0 };
	if (n === 60) return { year: 1900, month: 2, day: 29 };
	return ymdOf(EPOCH + (n < 60 ? n + 1 : n) * DAY_MS);
}

function ymdOf(ms: number): Ymd {
	const d = new Date(ms);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Day of the week, 0 for Sunday; serial 0 and 1 to 60 are as Excel has them. */
export function weekday(serial: number): number {
	const n = Math.floor(serial);
	// Excel takes 1900-01-01 as a Sunday (the real day was a Monday).
	return (((n - 1) % 7) + 7) % 7;
}

/** The serial of a moment on the local clock. */
export function serialOfDate(d: Date, date1904 = false): number {
	const day = dateSerial(d.getFullYear(), d.getMonth() + 1, d.getDate(), date1904) ?? 0;
	const secs =
		d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
	return day + secs / 86400;
}

const MONTHS = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december'
];

function monthOf(name: string): number {
	const n = name.toLowerCase();
	if (n.length < 3) return 0;
	const i = MONTHS.findIndex((m) => m.startsWith(n) || (n.length > 3 && n === m));
	return i + 1;
}

function timeOf(s: string): number | null {
	const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*(am|pm|a|p)?$/i.exec(s.trim());
	if (!m) return null;
	let h = Number(m[1]);
	const min = Number(m[2]);
	const sec = m[3] ? Number(m[3]) : 0;
	if (m[4]) {
		if (h < 1 || h > 12) return null;
		const pm = m[4].toLowerCase().startsWith('p');
		h = (h % 12) + (pm ? 12 : 0);
	}
	if (min > 59 || sec >= 60) return null;
	return (h * 3600 + min * 60 + sec) / 86400;
}

/**
 * A date or time typed as text, in the en-US forms Excel reads: `1/31/2024`,
 * `2024-01-31`, `31-Jan-2024`, `Jan 31, 2024`, `13:30`, `1:30 PM`, and a date
 * followed by a time. Best effort: Excel accepts more forms, by locale.
 */
export function dateFromText(text: string, date1904 = false): number | null {
	const s = text.trim();
	const t = timeOf(s);
	if (t !== null) return t;
	const sp = /^(.*?\d)\s+(\d{1,2}:\d.*)$/.exec(s);
	if (sp) {
		const d = dateFromText(sp[1], date1904);
		const tt = timeOf(sp[2]);
		if (d !== null && tt !== null && Number.isInteger(d)) return d + tt;
		return null;
	}
	let y: number;
	let mo: number;
	let d: number;
	let m: RegExpExecArray | null;
	const year = (v: string) => {
		const n = Number(v);
		return v.length <= 2 ? (n < 30 ? 2000 + n : 1900 + n) : n;
	};
	if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s))) {
		mo = Number(m[1]);
		d = Number(m[2]);
		y = year(m[3]);
	} else if ((m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s))) {
		y = Number(m[1]);
		mo = Number(m[2]);
		d = Number(m[3]);
	} else if ((m = /^(\d{1,2})[-\s]([A-Za-z]+)[-\s,]+(\d{2}|\d{4})$/.exec(s))) {
		d = Number(m[1]);
		mo = monthOf(m[2]);
		y = year(m[3]);
	} else if ((m = /^([A-Za-z]+)[-\s]+(\d{1,2}),?\s+(\d{2}|\d{4})$/.exec(s))) {
		mo = monthOf(m[1]);
		d = Number(m[2]);
		y = year(m[3]);
	} else if ((m = /^(\d{1,2})[/-](\d{1,2})$/.exec(s))) {
		mo = Number(m[1]);
		d = Number(m[2]);
		y = new Date().getFullYear();
	} else return null;
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	const serial = dateSerial(y, mo, d, date1904);
	if (serial === null) return null;
	// 2/30/2024 is not a date, though DATE would carry it into March.
	const back = serialToYmd(serial, date1904);
	if (!back || back.month !== mo || back.day !== d) return null;
	return serial;
}
