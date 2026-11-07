/**
 * Plain text: one paragraph per line. Lines carry no formatting, so writing back
 * the lines that did not change reproduces them exactly; the line ending and a
 * UTF-8 byte order mark are kept. Text in another encoding is saved as UTF-8.
 */
import { inlineText, Tally, type Block, type Census, type DocModel } from './model';

export const TEXT_LIMITS = { size: 16 * 1024 * 1024 };

export class TextError extends Error {}

interface Decoded {
	text: string;
	bom: boolean;
	encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
}

export function decodeText(bytes: Uint8Array): Decoded {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return {
			text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
			bom: true,
			encoding: 'utf-8'
		};
	}
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		return {
			text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
			bom: true,
			encoding: 'utf-16le'
		};
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		return {
			text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
			bom: true,
			encoding: 'utf-16be'
		};
	}
	try {
		return {
			text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
			bom: false,
			encoding: 'utf-8'
		};
	} catch {
		return {
			text: new TextDecoder('windows-1252').decode(bytes),
			bom: false,
			encoding: 'windows-1252'
		};
	}
}

export function readText(bytes: Uint8Array): { model: DocModel; census: Census } {
	if (bytes.length > TEXT_LIMITS.size) throw new TextError('too large');
	const { text, encoding } = decodeText(bytes);
	const tally = new Tally();
	if (encoding !== 'utf-8')
		tally.add(`Saved as UTF-8 rather than ${encoding.toUpperCase()}`, 'changed');
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	const blocks: Block[] = lines.map((line, ref) => ({
		type: 'paragraph',
		style: 'normal',
		content: line === '' ? [] : [{ type: 'text', text: line, marks: {} }],
		ref
	}));
	return { model: { blocks, images: {} }, census: tally.census() };
}

/** The model's text, line by line, in the original's line ending. */
export function writeText(model: DocModel, original?: Uint8Array): Uint8Array {
	const decoded = original ? decodeText(original) : null;
	const eol = decoded?.text.includes('\r\n') ? '\r\n' : '\n';
	const lines: string[] = [];
	const walk = (blocks: readonly Block[]) => {
		for (const b of blocks) {
			if (b.type === 'paragraph') {
				const prefix = b.list
					? `${'  '.repeat(b.list.level)}${b.list.kind === 'number' ? '1.' : b.list.kind === 'check' ? (b.list.checked ? '[x]' : '[ ]') : '-'} `
					: '';
				lines.push(...(prefix + inlineText(b.content)).split('\n'));
			} else if (b.type === 'locked') lines.push(...b.text.split('\n'));
			else {
				for (const r of b.rows) {
					lines.push(
						r.cells.map((c) => c.content.map((p) => inlineText(p.content)).join(' ')).join('\t')
					);
				}
			}
		}
	};
	walk(model.blocks);
	const trailing = decoded === null || /\r?\n$/.test(decoded.text) ? eol : '';
	const body = lines.join(eol) + (lines.length > 0 ? trailing : '');
	const bytes = new TextEncoder().encode(body);
	if (decoded?.bom && decoded.encoding === 'utf-8') {
		const out = new Uint8Array(bytes.length + 3);
		out.set([0xef, 0xbb, 0xbf]);
		out.set(bytes, 3);
		return out;
	}
	return bytes;
}
