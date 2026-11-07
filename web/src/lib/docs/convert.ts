/**
 * The document model to editor nodes and back. The round trip is exact for
 * anything the editor did not change, which is what lets a writer recognise an
 * unchanged block by comparing models.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import {
	cleanMarks,
	normalizeInlines,
	type Block,
	type Cell,
	type DocModel,
	type Inline,
	type ListInfo,
	type Marks,
	type Paragraph,
	type Row
} from '$lib/formats/model';
import { schema, type ParagraphAttrs } from './schema';

function marksOf(m: Marks): Mark[] {
	const out: Mark[] = [];
	if (m.link !== undefined) out.push(schema.marks.link.create({ href: m.link }));
	if (m.bold) out.push(schema.marks.bold.create());
	if (m.italic) out.push(schema.marks.italic.create());
	if (m.underline) out.push(schema.marks.underline.create());
	if (m.strike) out.push(schema.marks.strike.create());
	if (m.code) out.push(schema.marks.code.create());
	if (m.font) out.push(schema.marks.font.create({ family: m.font }));
	if (m.size) out.push(schema.marks.size.create({ pt: m.size }));
	if (m.color) out.push(schema.marks.color.create({ value: m.color }));
	if (m.highlight) out.push(schema.marks.highlight.create({ value: m.highlight }));
	return out;
}

function inlineNodes(content: readonly Inline[]): PMNode[] {
	const out: PMNode[] = [];
	for (const i of content) {
		if (i.type === 'text') {
			if (i.text !== '') out.push(schema.text(i.text, marksOf(i.marks)));
		} else if (i.type === 'break')
			out.push(schema.nodes.hard_break.create({ page: i.page === true }));
		else {
			out.push(
				schema.nodes.image.create(
					{
						key: i.image,
						alt: i.alt,
						width: i.width ?? null,
						height: i.height ?? null,
						ref: i.ref ?? null
					},
					null,
					i.link !== undefined ? [schema.marks.link.create({ href: i.link })] : []
				)
			);
		}
	}
	return out;
}

function paragraphNode(p: Paragraph): PMNode {
	const attrs: ParagraphAttrs = {
		style: p.style,
		align: p.align ?? null,
		list: p.list ? { ...p.list } : null,
		ref: p.ref ?? null
	};
	return schema.nodes.paragraph.create(attrs, inlineNodes(p.content));
}

function blockNode(b: Block): PMNode {
	if (b.type === 'paragraph') return paragraphNode(b);
	if (b.type === 'locked')
		return schema.nodes.locked.create({ label: b.label, text: b.text, ref: b.ref });
	return schema.nodes.table.create(
		{ ref: b.ref ?? null },
		b.rows.map((r) =>
			schema.nodes.table_row.create(
				{ ref: r.ref ?? null },
				r.cells.map((c) =>
					(c.header ? schema.nodes.table_header : schema.nodes.table_cell).create(
						{ ref: c.ref ?? null, colspan: c.colspan ?? 1, rowspan: c.rowspan ?? 1 },
						(c.content.length > 0
							? c.content
							: [{ type: 'paragraph', style: 'normal', content: [] } as Paragraph]
						).map(paragraphNode)
					)
				)
			)
		)
	);
}

export function toDoc(model: Pick<DocModel, 'blocks'>): PMNode {
	const blocks =
		model.blocks.length > 0 ? model.blocks.map(blockNode) : [schema.nodes.paragraph.create()];
	return schema.nodes.doc.create(null, blocks);
}

function marksFrom(marks: readonly Mark[]): Marks {
	const m: Marks = {};
	for (const mark of marks) {
		switch (mark.type.name) {
			case 'link':
				m.link = mark.attrs.href as string;
				break;
			case 'bold':
			case 'italic':
			case 'underline':
			case 'strike':
			case 'code':
				m[mark.type.name] = true;
				break;
			case 'font':
				m.font = mark.attrs.family as string;
				break;
			case 'size':
				m.size = mark.attrs.pt as number;
				break;
			case 'color':
				m.color = mark.attrs.value as string;
				break;
			case 'highlight':
				m.highlight = mark.attrs.value as string;
				break;
		}
	}
	return cleanMarks(m);
}

function paragraphFrom(node: PMNode): Paragraph {
	const a = node.attrs as ParagraphAttrs;
	const content: Inline[] = [];
	node.forEach((child) => {
		if (child.isText)
			content.push({ type: 'text', text: child.text ?? '', marks: marksFrom(child.marks) });
		else if (child.type.name === 'hard_break') {
			content.push(child.attrs.page ? { type: 'break', page: true } : { type: 'break' });
		} else if (child.type.name === 'image' && child.attrs.key) {
			const img: Inline = {
				type: 'image',
				image: child.attrs.key as string,
				alt: child.attrs.alt as string
			};
			if (child.attrs.width) img.width = child.attrs.width as number;
			if (child.attrs.height) img.height = child.attrs.height as number;
			const link = child.marks.find((m) => m.type.name === 'link');
			if (link) img.link = link.attrs.href as string;
			if (child.attrs.ref !== null) img.ref = child.attrs.ref as number;
			content.push(img);
		}
	});
	const p: Paragraph = { type: 'paragraph', style: a.style, content: normalizeInlines(content) };
	if (a.align) p.align = a.align as Paragraph['align'];
	if (a.list) {
		const list: ListInfo = { kind: a.list.kind, level: a.list.level };
		if (a.list.kind === 'check') list.checked = a.list.checked === true;
		p.list = list;
	}
	if (a.ref !== null) p.ref = a.ref;
	return p;
}

function blockFrom(node: PMNode): Block {
	if (node.type.name === 'paragraph') return paragraphFrom(node);
	if (node.type.name === 'locked') {
		return {
			type: 'locked',
			label: node.attrs.label as string,
			text: node.attrs.text as string,
			ref: node.attrs.ref as number
		};
	}
	const rows: Row[] = [];
	node.forEach((rowNode) => {
		const cells: Cell[] = [];
		rowNode.forEach((cellNode) => {
			const paras: Paragraph[] = [];
			cellNode.forEach((p) => paras.push(paragraphFrom(p)));
			const cell: Cell = { content: paras };
			if (cellNode.type.name === 'table_header') cell.header = true;
			if ((cellNode.attrs.colspan as number) > 1) cell.colspan = cellNode.attrs.colspan as number;
			if ((cellNode.attrs.rowspan as number) > 1) cell.rowspan = cellNode.attrs.rowspan as number;
			if (cellNode.attrs.ref !== null) cell.ref = cellNode.attrs.ref as number;
			cells.push(cell);
		});
		const row: Row = { cells };
		if (rowNode.attrs.ref !== null) row.ref = rowNode.attrs.ref as number;
		rows.push(row);
	});
	const table: Block = { type: 'table', rows };
	if (node.attrs.ref !== null) table.ref = node.attrs.ref as number;
	return table;
}

export function fromDoc(doc: PMNode): Block[] {
	const out: Block[] = [];
	doc.forEach((n) => out.push(blockFrom(n)));
	return out;
}
