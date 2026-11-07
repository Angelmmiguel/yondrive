/**
 * Builds a small Word 97 binary document for tests, following the layout in
 * [MS-DOC]: a FIB, a piece table with one 8-bit and one UTF-16 piece, character
 * and paragraph property pages, and a one-level bulleted list definition. It is
 * synthetic: no copy of Word was available to produce real files, so this is
 * what the `.doc` reader is checked against.
 */
import { writeCfb } from '../../src/lib/formats/cfb';

export interface DocRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	/** Half points. */
	size?: number;
}

export interface DocPara {
	runs: DocRun[];
	istd?: number;
	jc?: number;
	ilfo?: number;
	inTable?: boolean;
	rowEnd?: boolean;
	/** The mark that ends it: a paragraph mark, or a cell or row mark. */
	end?: '\r' | '\x07';
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** `split` is the index of the first paragraph stored as UTF-16 rather than 8-bit. */
export function makeDoc(paras: DocPara[], split = Math.ceil(paras.length / 2)): Uint8Array {
	const word: number[] = new Array(1024).fill(0);
	const groups = [paras.slice(0, split), paras.slice(split)];
	const pieces: {
		cpStart: number;
		cpEnd: number;
		fc: number;
		compressed: boolean;
		byteStart: number;
	}[] = [];
	const chpxRuns: { start: number; end: number; grpprl: number[] }[][] = [[], []];
	const papxRuns: { start: number; end: number; grpprl: number[] }[][] = [[], []];
	let cp = 0;
	groups.forEach((group, g) => {
		const compressed = g === 0;
		const width = compressed ? 1 : 2;
		const byteStart = word.length;
		const cpStart = cp;
		for (const p of group) {
			const paraStart = word.length;
			const all = [...p.runs, { text: p.end ?? '\r' }];
			for (const r of all) {
				const start = word.length;
				for (const ch of r.text) {
					const code = ch.charCodeAt(0);
					if (compressed) word.push(code & 0xff);
					else word.push(...u16(code));
					cp++;
				}
				const grpprl: number[] = [];
				const run = r as DocRun;
				if (run.bold) grpprl.push(...u16(0x0835), 1);
				if (run.italic) grpprl.push(...u16(0x0836), 1);
				if (run.underline) grpprl.push(...u16(0x2a3e), 1);
				if (run.size) grpprl.push(...u16(0x4a43), ...u16(run.size));
				chpxRuns[g].push({ start, end: word.length, grpprl });
			}
			const sprms: number[] = [...u16(p.istd ?? 0)];
			if (p.jc !== undefined) sprms.push(...u16(0x2461), p.jc);
			if (p.inTable) sprms.push(...u16(0x2416), 1);
			if (p.rowEnd) sprms.push(...u16(0x2417), 1);
			if (p.ilfo) sprms.push(...u16(0x460b), ...u16(p.ilfo), ...u16(0x260a), 0);
			papxRuns[g].push({ start: paraStart, end: word.length, grpprl: sprms });
		}
		pieces.push({
			cpStart,
			cpEnd: cp,
			fc: compressed ? byteStart * 2 : byteStart,
			compressed,
			byteStart
		});
		void width;
	});
	const ccpText = cp;
	while (word.length % 512 !== 0) word.push(0);

	const fkp = (runs: { start: number; end: number; grpprl: number[] }[], papx: boolean): number => {
		const page = new Array(512).fill(0);
		const crun = runs.length;
		runs.forEach((r, k) => page.splice(k * 4, 4, ...u32(r.start)));
		page.splice(crun * 4, 4, ...u32(runs[crun - 1]?.end ?? 0));
		let free = 510;
		runs.forEach((r, k) => {
			const slot = (crun + 1) * 4 + k * (papx ? 13 : 1);
			if (!papx && r.grpprl.length === 0) return;
			let body: number[];
			if (papx) {
				const even = r.grpprl.length % 2 === 0 ? r.grpprl : [...r.grpprl, 0];
				body = [0, even.length / 2, ...even];
			} else body = [r.grpprl.length, ...r.grpprl];
			free -= body.length;
			free -= free % 2;
			page.splice(free, body.length, ...body);
			page[slot] = free / 2;
		});
		page[511] = crun;
		const pn = word.length / 512;
		word.push(...page);
		return pn;
	};
	const chpxPages = chpxRuns.map((runs) => (runs.length > 0 ? fkp(runs, false) : -1));
	const papxPages = papxRuns.map((runs) => (runs.length > 0 ? fkp(runs, true) : -1));

	const table: number[] = [];
	const place = (bytes: number[]) => {
		const fc = table.length;
		table.push(...bytes);
		return { fc, lcb: bytes.length };
	};
	const plcPcd = [
		...pieces.flatMap((p) => u32(p.cpStart)),
		...u32(pieces.at(-1)!.cpEnd),
		...pieces.flatMap((p) => [0, 0, ...u32(p.compressed ? p.fc | 0x40000000 : p.fc), 0, 0])
	];
	const clx = place([2, ...u32(plcPcd.length), ...plcPcd]);
	const bte = (pages: number[], runs: { start: number; end: number }[][]) => {
		const used = pages.map((pn, i) => ({ pn, runs: runs[i] })).filter((x) => x.pn >= 0);
		const fcs = [...used.map((x) => x.runs[0].start), used.at(-1)!.runs.at(-1)!.end];
		return place([...fcs.flatMap(u32), ...used.flatMap((x) => u32(x.pn))]);
	};
	const chpx = bte(chpxPages, chpxRuns);
	const papx = bte(papxPages, papxRuns);
	const lst = place([...u16(1), ...u32(1), ...u32(0), ...new Array(18).fill(0xff), 1, 0]);
	// Its one level follows the list table: bulleted (nfc 23) with a one-character text.
	table.push(
		...u32(1),
		23,
		0,
		...new Array(9).fill(0),
		0,
		...u32(0),
		...u32(0),
		0,
		0,
		0,
		0,
		...u16(1),
		...u16(0xf0b7)
	);
	const lfo = place([...u32(1), ...u32(1), ...u32(0), ...u32(0), 0, 0, 0, 0]);

	const fib = new Array(1024).fill(0);
	const set = (at: number, bytes: number[]) => fib.splice(at, bytes.length, ...bytes);
	set(0, u16(0xa5ec));
	set(2, u16(0x00c1));
	set(0x0a, u16(0x0200));
	set(32, u16(14));
	set(62, u16(22));
	set(64 + 12, u32(ccpText));
	set(152, u16(93));
	const pair = (i: number, v: { fc: number; lcb: number }) =>
		set(154 + i * 8, [...u32(v.fc), ...u32(v.lcb)]);
	pair(12, chpx);
	pair(13, papx);
	pair(33, clx);
	pair(73, lst);
	pair(74, lfo);
	word.splice(0, 1024, ...fib);

	return writeCfb([
		{ name: 'WordDocument', data: new Uint8Array(word) },
		{ name: '1Table', data: new Uint8Array(table) }
	]);
}

/** The sample the tests and the browser spec import. */
export function sampleDoc(): Uint8Array {
	return makeDoc(
		[
			{ runs: [{ text: 'Imported heading' }], istd: 1 },
			{
				runs: [
					{ text: 'Plain, ' },
					{ text: 'bold', bold: true },
					{ text: ' and ' },
					{ text: 'italic', italic: true },
					{ text: ' text.' }
				],
				jc: 1
			},
			{ runs: [{ text: 'A listed item' }], ilfo: 1 },
			{ runs: [{ text: 'A1' }], inTable: true, end: '\x07' },
			{ runs: [{ text: 'B1' }], inTable: true, end: '\x07' },
			{ runs: [], inTable: true, rowEnd: true, end: '\x07' },
			{ runs: [{ text: 'Wide characters: café ✓' }] },
			{ runs: [{ text: 'Last line, ' }, { text: 'big', size: 36 }] }
		],
		6
	);
}
