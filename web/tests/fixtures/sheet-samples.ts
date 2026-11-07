/**
 * Spreadsheets built byte by byte for the tests, so every byte of them is known:
 * an .xlsx package from sheet parts, an .ods laid out as LibreOffice writes one,
 * and an .xls laid out as BIFF8 says.
 */
import { writeCfb } from '../../src/lib/formats/cfb';
import { writeZip } from '../../src/lib/formats/zip';

const enc = new TextEncoder();

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A small package built here, so every byte of it is known. */
export async function xlsxOf(
	sheets: string[],
	extra: Record<string, string> = {},
	workbookExtra = ''
) {
	const files: Record<string, string> = {
		'[Content_Types].xml':
			'<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
			sheets
				.map(
					(_, i) =>
						`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
				)
				.join('') +
			'</Types>',
		'_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<workbook xmlns="${MAIN}" xmlns:r="${R}"><sheets>${sheets.map((_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${workbookExtra}</workbook>`,
		'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
		...Object.fromEntries(
			sheets.map((s, i) => [
				`xl/worksheets/sheet${i + 1}.xml`,
				`<?xml version="1.0" encoding="UTF-8"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${R}">${s}</worksheet>`
			])
		),
		...extra
	};
	return writeZip(
		null,
		Object.entries(files).map(([name, text]) => ({ name, data: enc.encode(text) }))
	);
}


const NS =
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';

export const ROW2 =
	'<table:table-row table:style-name="ro1"><table:table-cell office:value-type="string"><text:p>A</text:p></table:table-cell><table:table-cell table:style-name="ce1" office:value-type="float" office:value="2"><text:p>2.00</text:p></table:table-cell><table:table-cell table:formula="of:=[.B2]*10" office:value-type="float" office:value="20"><text:p>20</text:p></table:table-cell></table:table-row>';
export const ROWS34 =
	'<table:table-row table:style-name="ro1" table:number-rows-repeated="2"><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>';
export const TAIL =
	'<table:table-row table:style-name="ro1" table:number-rows-repeated="1048571"><table:table-cell table:number-columns-repeated="3"/></table:table-row>';

/** A spreadsheet laid out as LibreOffice writes one, built here so every byte is known. */
export function sampleOds(): Promise<Uint8Array> {
	const content =
		`<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS} office:version="1.3">` +
		'<office:automatic-styles>' +
		'<number:number-style style:name="N2"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1"/></number:number-style>' +
		'<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="2.258cm"/></style:style>' +
		'<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.452cm" style:use-optimal-row-height="true"/></style:style>' +
		'<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N2"/>' +
		'<style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>' +
		'</office:automatic-styles><office:body><office:spreadsheet>' +
		'<table:table table:name="Data"><table:table-column table:style-name="co1" table:number-columns-repeated="3" table:default-cell-style-name="Default"/>' +
		'<table:table-row table:style-name="ro1"><table:table-cell table:style-name="ce2" office:value-type="string"><text:p>Item</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Qty  x</text:p></table:table-cell><table:table-cell/></table:table-row>' +
		ROW2 +
		ROWS34 +
		'<table:table-row table:style-name="ro1"><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1" office:value-type="string"><text:p>Merged</text:p><office:annotation><text:p>note</text:p></office:annotation></table:table-cell><table:covered-table-cell/><table:table-cell table:formula="of:=SUM([.B2:.B4])" office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row>' +
		TAIL +
		'</table:table>' +
		'<table:table table:name="Other Sheet"><table:table-column/><table:table-row><table:table-cell table:formula="of:=[$Data.C2]&amp;COM.MICROSOFT.CONCAT(&quot;a&quot;;&quot;b&quot;)" office:value-type="string" office:string-value="20ab"><text:p>20ab</text:p></table:table-cell></table:table-row></table:table>' +
		'<table:named-expressions><table:named-range table:name="Q" table:base-cell-address="$Data.$B$2" table:cell-range-address="$Data.$B$2:.$B$3"/></table:named-expressions>' +
		'</office:spreadsheet></office:body></office:document-content>';
	const styles = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}><office:styles><style:default-style style:family="table-cell"><style:text-properties fo:font-size="10pt"/></style:default-style><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`;
	return writeZip(null, [
		{ name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.spreadsheet'), store: true },
		{ name: 'content.xml', data: enc.encode(content) },
		{ name: 'styles.xml', data: enc.encode(styles) },
		{ name: 'Pictures/x.png', data: new Uint8Array([1, 2, 3]) }
	]);
}


const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [...u16(n & 0xffff), ...u16(n >>> 16)];
const f64 = (n: number) => [...new Uint8Array(new Float64Array([n]).buffer)];
const latin = (s: string) => [...s].map((c) => c.charCodeAt(0));
const str8 = (s: string) => [s.length, 0, ...latin(s)];
const str16 = (s: string) => [...u16(s.length), 0, ...latin(s)];
export const rec = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];
export const bof = (dt: number) => rec(0x0809, [...u16(0x0600), ...u16(dt), ...u16(0), ...u16(1997), ...u32(0), ...u32(0)]);
export const EOF = rec(0x000a, []);
const xf = (ifnt: number, ifmt: number, align = 0x20, borders2 = 0, fills = 0) => rec(0x00e0, [...u16(ifnt), ...u16(ifmt), ...u16(0), align, 0, 0, 0, ...u32(0), ...u32(borders2), ...u16(fills)]);
const font = (bold: boolean) => rec(0x0031, [...u16(200), ...u16(0), ...u16(0x7fff), ...u16(bold ? 700 : 400), ...u16(0), 0, 0, 0, 0, ...str8('Arial')]);
const cell = (r: number, c: number, x: number) => [...u16(r), ...u16(c), ...u16(x)];
const REL = 0xc000;

/** A workbook laid out as BIFF8 says, with the records this reader needs and a few it skips. */
export function sampleXls(): Uint8Array {
	const sheet = [
		...bof(0x10),
		...rec(0x007d, [...u16(0), ...u16(0), ...u16(20 * 256), ...u16(15), ...u16(0), ...u16(0)]),
		...rec(0x0208, [...u16(1), ...u16(0), ...u16(2), ...u16(600), ...u16(0), ...u16(0), ...u16(0x40), ...u16(15)]),
		...rec(0x00fd, [...cell(0, 0, 16), ...u32(0)]),
		...rec(0x00fd, [...cell(0, 1, 15), ...u32(2)]),
		...rec(0x0203, [...cell(1, 0, 15), ...f64(1.5)]),
		...rec(0x027e, [...cell(1, 1, 15), ...u32((100 << 2) | 2)]),
		...rec(0x00bd, [...u16(2), ...u16(0), ...u16(15), ...u32((2 << 2) | 2), ...u16(17), ...u32((314 << 2) | 3), ...u16(1)]),
		...rec(0x0205, [...cell(3, 0, 15), 1, 0]),
		...rec(0x0205, [...cell(3, 1, 15), 0x07, 1]),
		...rec(0x0006, [...cell(4, 0, 15), ...f64(101.5), ...u16(0), ...u32(0), ...u16(11), 0x24, ...u16(1), ...u16(0 | REL), 0x24, ...u16(1), ...u16(1 | REL), 0x03]),
		...rec(0x0006, [...cell(4, 1, 15), ...f64(101.5), ...u16(0), ...u32(0), ...u16(13), 0x25, ...u16(1), ...u16(1), ...u16(0 | REL), ...u16(1 | REL), 0x22, 1, ...u16(4)]),
		...rec(0x0006, [...cell(4, 2, 15), 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...u16(0), ...u32(0), ...u16(10), 0x24, ...u16(0), ...u16(0 | REL), 0x17, 1, 0, 0x21, 0x08]),
		...rec(0x0207, str16('Hello!')),
		...rec(0x0006, [...cell(4, 3, 15), ...f64(7), ...u16(0), ...u32(0), ...u16(5), 0x23, ...u32(1)]),
		...rec(0x001c, [0, 0, 0, 0]),
		...rec(0x00e5, [...u16(1), ...u16(5), ...u16(5), ...u16(0), ...u16(1)]),
		...EOF
	];
	// SST with its second string split across a CONTINUE record, wide after the split.
	const sst = [...u32(3), ...u32(3), ...str16('Hello'), ...str16('World'), ...u16(10), 0, ...latin('ABCDE')];
	const cont = [1, ...[...'FGHIJ'].flatMap((c) => [c.charCodeAt(0), 0])];
	const head = (at: number) => [
		...bof(0x05),
		...font(false), ...font(false), ...font(false), ...font(false), ...font(true),
		...rec(0x041e, [...u16(164), ...str16('0.00" EUR"')]),
		...Array.from({ length: 16 }, () => xf(0, 0)).flat(),
		xf(5, 164, 0x22),
		xf(0, 0, 0x20, 1 << 26, 10),
		...rec(0x0085, [...u32(at), 0, 0, ...str8('Sheet1')]),
		...rec(0x0085, [...u32(0), 0, 2, ...str8('Chart1')]),
		...rec(0x00fc, sst),
		...rec(0x003c, cont),
		...EOF
	].flat();
	const globals = head(0);
	const all = [...head(globals.length), ...sheet];
	return writeCfb([{ name: 'Workbook', data: new Uint8Array(all) }]);
}

