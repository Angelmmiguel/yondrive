/**
 * The currencies the toolbar offers, as the number format codes a spreadsheet
 * file keeps: a `[$symbol-locale]` code names the currency the way other
 * spreadsheet apps write it, so the choice survives a round trip through the
 * file, and the symbol sits where that currency's readers expect it.
 */

export interface Currency {
	/** ISO 4217 code. */
	id: string;
	name: string;
	symbol: string;
	numFmt: string;
}

export const CURRENCIES: readonly Currency[] = [
	{ id: 'USD', name: 'US dollar', symbol: '$', numFmt: '"$"#,##0.00' },
	{ id: 'EUR', name: 'Euro', symbol: '€', numFmt: '[$€-1809]#,##0.00' },
	{ id: 'GBP', name: 'Pound sterling', symbol: '£', numFmt: '[$£-809]#,##0.00' },
	{ id: 'JPY', name: 'Japanese yen', symbol: '¥', numFmt: '[$¥-411]#,##0' },
	{ id: 'CNY', name: 'Chinese yuan', symbol: '¥', numFmt: '[$¥-804]#,##0.00' },
	{ id: 'CHF', name: 'Swiss franc', symbol: 'CHF', numFmt: '[$CHF-100C] #,##0.00' },
	{ id: 'CAD', name: 'Canadian dollar', symbol: '$', numFmt: '[$$-1009]#,##0.00' },
	{ id: 'AUD', name: 'Australian dollar', symbol: '$', numFmt: '[$$-C09]#,##0.00' },
	{ id: 'MXN', name: 'Mexican peso', symbol: '$', numFmt: '[$$-80A]#,##0.00' },
	{ id: 'BRL', name: 'Brazilian real', symbol: 'R$', numFmt: '[$R$-416] #,##0.00' },
	{ id: 'INR', name: 'Indian rupee', symbol: '₹', numFmt: '[$₹-4009]#,##0.00' }
];

const SYMBOL = /[$€£¥₹]|CHF/;

/** The currency symbol a format's first section shows, if it shows one. */
export function currencySymbol(numFmt: string): string | null {
	const first = numFmt.split(';')[0];
	const bracket = /\[\$([^\]-]+)(?:-[^\]]*)?\]/.exec(first);
	if (bracket && SYMBOL.test(bracket[1])) return bracket[1];
	const quoted = /"([^"]*)"/.exec(first);
	if (quoted && SYMBOL.test(quoted[1])) return quoted[1].trim();
	// Bare symbols outside quotes and brackets, as in `$#,##0` or `#,##0 €`.
	const bare = SYMBOL.exec(first.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
	return bare ? bare[0] : null;
}

/**
 * The listed currency a format shows: its own code, or the first currency with
 * its symbol, as for a format another app wrote. Null when it shows none.
 */
export function currencyOf(numFmt: string): Currency | null {
	const exact = CURRENCIES.find((c) => c.numFmt === numFmt);
	if (exact) return exact;
	const symbol = currencySymbol(numFmt);
	return symbol === null ? null : (CURRENCIES.find((c) => c.symbol === symbol) ?? null);
}
