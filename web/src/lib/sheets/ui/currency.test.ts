import { describe, expect, it } from 'vitest';
import { readCsv } from '$lib/formats/csv';
import { readOds, writeOds } from '$lib/formats/ods';
import { readXlsx, writeXlsx } from '$lib/formats/xlsx';
import { formatValue } from '$lib/formula/numfmt';
import { CURRENCIES, currencyOf, currencySymbol } from './currency';

const shown: Record<string, string> = {
	USD: '$1,234.50',
	EUR: '€1,234.50',
	GBP: '£1,234.50',
	JPY: '¥1,235',
	CNY: '¥1,234.50',
	CHF: 'CHF 1,234.50',
	CAD: '$1,234.50',
	AUD: '$1,234.50',
	MXN: '$1,234.50',
	BRL: 'R$ 1,234.50',
	INR: '₹1,234.50'
};

describe('currencies', () => {
	it('shows each with its symbol where its readers expect it', () => {
		expect(CURRENCIES.map((c) => c.id)).toEqual(Object.keys(shown));
		for (const c of CURRENCIES) {
			expect(formatValue(1234.5, c.numFmt)).toBe(shown[c.id]);
			expect(currencyOf(c.numFmt)).toBe(c);
			expect(formatValue(-5, c.numFmt).startsWith('-')).toBe(true);
		}
	});

	it('finds the currency of formats written elsewhere, and none in others', () => {
		expect(currencySymbol('"$"#,##0.00_);\\("$"#,##0.00\\)')).toBe('$');
		expect(currencySymbol('#,##0.00 [$€-407]')).toBe('€');
		expect(currencySymbol('"CHF" #,##0.00')).toBe('CHF');
		expect(currencySymbol('#,##0.00 €')).toBe('€');
		expect(currencyOf('#,##0.00 €')?.id).toBe('EUR');
		expect(currencySymbol('"US$"#,##0')).toBe('US$');
		expect(currencyOf('"US$"#,##0')).toBeNull();
		for (const code of ['General', '#,##0.00', '0.00%', '[$-409]h:mm', 'm/d/yyyy', '@'])
			expect(currencySymbol(code)).toBeNull();
	});

	it('keeps the chosen currency through .xlsx and .ods', async () => {
		const { book } = readCsv(new TextEncoder().encode('1234.5\n'));
		const s = book.engine.sheets[0].id;
		for (const [i, c] of CURRENCIES.entries()) {
			book.engine.set(s, i, 0, { value: 1234.5 });
			book.engine.setStyle(s, i, 0, book.styleId({ ...book.styles[0], numFmt: c.numFmt }));
		}
		const x = (await readXlsx(await writeXlsx(book))).book;
		const o = (await readOds(await writeOds(book))).book;
		for (const [i, c] of CURRENCIES.entries()) {
			const xc = x.engine.cell(x.engine.sheets[0].id, i, 0)!;
			expect(x.styles[xc.style].numFmt).toBe(c.numFmt);
			const oc = o.engine.cell(o.engine.sheets[0].id, i, 0)!;
			expect(o.display(oc)).toBe(shown[c.id]);
			expect(currencySymbol(o.styles[oc.style].numFmt)).toBe(c.symbol);
		}
	});
});
