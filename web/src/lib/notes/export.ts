/**
 * Every note as plain Markdown files in a ZIP, built on the device: a folder for
 * each notebook, links between notes rewritten to relative paths, and pictures
 * and attached files beside the notes that use them. A link to a node that is not
 * in the export (a Drive file, a note in the trash) keeps its text and loses its
 * address, as no path could reach it. Only the blocks that held such a link are
 * written again; the rest of each file is copied as it was.
 */
import { readMarkdown, writeMarkdown } from '$lib/formats/markdown';
import type { DocModel, Inline } from '$lib/formats/model';
import { writeZip, type ZipChange } from '$lib/formats/zip';
import { NODE_HREF, paragraphs } from './parse';

export interface ExportItem {
	id: string;
	/** The folder in the archive: a notebook's name, or '' for the top. */
	folder: string;
	name: string;
}

export interface ExportNote extends ExportItem {
	markdown: string;
}

export interface ExportFile extends ExportItem {
	bytes: Uint8Array;
}

/** A path relative to the folder of `from`, each part encoded as a link wants it. */
export function relativePath(from: string, to: string): string {
	const a = from.split('/').slice(0, -1);
	const b = to.split('/');
	let common = 0;
	while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
	const up = a.slice(common).map(() => '..');
	return [...up, ...b.slice(common)]
		.map((part) => (part === '..' ? part : encodeURIComponent(part)))
		.join('/');
}

/** Gives each item a path no other has, numbering clashes the way a drive would. */
export function assignPaths(items: readonly ExportItem[]): Map<string, string> {
	const taken = new Set<string>();
	const out = new Map<string, string>();
	for (const item of items) {
		const dot = item.name.lastIndexOf('.');
		const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
		const ext = dot > 0 ? item.name.slice(dot) : '';
		const prefix = item.folder === '' ? '' : `${item.folder}/`;
		let path = `${prefix}${item.name}`;
		for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${prefix}${stem} (${n})${ext}`;
		taken.add(path.toLowerCase());
		out.set(item.id, path);
	}
	return out;
}

/** A note's Markdown with its links to nodes pointing at their paths in the export. */
export function rewriteLinks(
	markdown: string,
	from: string,
	paths: ReadonlyMap<string, string>
): string {
	const { model } = readMarkdown(markdown);
	let changed = false;
	const target = (href: string): string | null | undefined => {
		const m = NODE_HREF.exec(href);
		if (!m) return undefined;
		const to = paths.get(m[1]);
		return to === undefined ? null : relativePath(from, to);
	};
	for (const p of paragraphs(model.blocks)) {
		const next: Inline[] = [];
		for (const i of p.content) {
			if (i.type === 'text' && i.marks.link !== undefined) {
				const to = target(i.marks.link);
				if (to !== undefined) {
					changed = true;
					const marks = { ...i.marks };
					if (to === null) delete marks.link;
					else marks.link = to;
					next.push({ ...i, marks });
					continue;
				}
			} else if (i.type === 'image') {
				const to = target(i.image);
				if (to !== undefined) {
					changed = true;
					// A picture that is not in the export would point nowhere: its description stays.
					next.push(to === null ? { type: 'text', text: i.alt, marks: {} } : { ...i, image: to });
					continue;
				}
			}
			next.push(i);
		}
		p.content = next;
	}
	return changed ? writeMarkdown(model as DocModel, markdown) : markdown;
}

/** The archive: notes with their links rewritten, and files as they are. */
export async function buildExport(
	notes: readonly ExportNote[],
	files: readonly ExportFile[]
): Promise<Uint8Array> {
	const paths = assignPaths([...notes, ...files]);
	const encoder = new TextEncoder();
	const changes: ZipChange[] = [];
	for (const note of notes) {
		const path = paths.get(note.id) as string;
		changes.push({ name: path, data: encoder.encode(rewriteLinks(note.markdown, path, paths)) });
	}
	for (const file of files) changes.push({ name: paths.get(file.id) as string, data: file.bytes });
	return writeZip(null, changes);
}
