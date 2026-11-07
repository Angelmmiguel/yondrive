/**
 * The package parts of Office Open XML that a document needs: relationships,
 * content types and resolving one part's target from another. Every change is a
 * splice into the original text, so whatever else a part holds stays as it was.
 */
import { decodeXml, escapeAttr, kids, parseXml, type XElement } from './xml';
import { entryData, type ZipArchive } from './zip';

export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const REL = {
	officeDocument: `${REL_NS}/officeDocument`,
	image: `${REL_NS}/image`,
	hyperlink: `${REL_NS}/hyperlink`,
	numbering: `${REL_NS}/numbering`,
	styles: `${REL_NS}/styles`
};

export interface Relationship {
	id: string;
	type: string;
	target: string;
	external: boolean;
}

/** Where a part's relationships live: `word/document.xml` has `word/_rels/document.xml.rels`. */
export function relsPathOf(part: string): string {
	const at = part.lastIndexOf('/');
	return `${part.slice(0, at + 1)}_rels/${part.slice(at + 1)}.rels`;
}

/** A target relative to the part that names it, as a package path. */
export function resolveTarget(fromPart: string, target: string): string {
	if (target.startsWith('/')) return target.slice(1);
	const parts = fromPart.split('/').slice(0, -1);
	for (const seg of target.split('/')) {
		if (seg === '..') parts.pop();
		else if (seg !== '.' && seg !== '') parts.push(seg);
	}
	return parts.join('/');
}

export async function partText(zip: ZipArchive, name: string): Promise<string | null> {
	const e = zip.get(name);
	return e === undefined ? null : decodeXml(await entryData(e));
}

/** A relationships part, read and ready to take additions. */
export class Rels {
	readonly path: string;
	readonly list: Relationship[];
	readonly #source: string | null;
	readonly #added: Relationship[] = [];

	constructor(path: string, source: string | null) {
		this.path = path;
		this.#source = source;
		this.list = [];
		if (source === null) return;
		for (const r of kids(parseXml(source), 'Relationship')) {
			this.list.push({
				id: r.attrs.Id ?? '',
				type: r.attrs.Type ?? '',
				target: r.attrs.Target ?? '',
				external: r.attrs.TargetMode === 'External'
			});
		}
	}

	get(id: string): Relationship | undefined {
		return this.list.find((r) => r.id === id);
	}

	byType(type: string): Relationship | undefined {
		return this.list.find((r) => r.type === type);
	}

	/** The id of a relationship to this target, added if there is none. */
	ensure(type: string, target: string, external = false): string {
		const found = this.list.find(
			(r) => r.type === type && r.target === target && r.external === external
		);
		if (found) return found.id;
		let n = this.list.length + 1;
		while (this.list.some((r) => r.id === `rIdYd${n}`)) n++;
		const rel = { id: `rIdYd${n}`, type, target, external };
		this.list.push(rel);
		this.#added.push(rel);
		return rel.id;
	}

	get changed(): boolean {
		return this.#added.length > 0;
	}

	/** The part with the additions spliced in before its end. */
	text(): string {
		const add = this.#added
			.map(
				(r) =>
					`<Relationship Id="${escapeAttr(r.id)}" Type="${escapeAttr(r.type)}" Target="${escapeAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`
			)
			.join('');
		if (this.#source === null) {
			return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${add}</Relationships>`;
		}
		return spliceBeforeClose(this.#source, 'Relationships', add);
	}
}

/** `[Content_Types].xml`, ready to take a default or an override. */
export class ContentTypes {
	readonly #source: string;
	readonly #defaults = new Set<string>();
	readonly #overrides = new Set<string>();
	readonly #add: string[] = [];

	constructor(source: string) {
		this.#source = source;
		const root = parseXml(source);
		for (const d of kids(root, 'Default'))
			this.#defaults.add((d.attrs.Extension ?? '').toLowerCase());
		for (const o of kids(root, 'Override')) this.#overrides.add(o.attrs.PartName ?? '');
	}

	ensureDefault(ext: string, type: string): void {
		if (this.#defaults.has(ext.toLowerCase())) return;
		this.#defaults.add(ext.toLowerCase());
		this.#add.push(`<Default Extension="${escapeAttr(ext)}" ContentType="${escapeAttr(type)}"/>`);
	}

	ensureOverride(part: string, type: string): void {
		const name = `/${part}`;
		if (this.#overrides.has(name)) return;
		this.#overrides.add(name);
		this.#add.push(`<Override PartName="${escapeAttr(name)}" ContentType="${escapeAttr(type)}"/>`);
	}

	get changed(): boolean {
		return this.#add.length > 0;
	}

	text(): string {
		return spliceBeforeClose(this.#source, 'Types', this.#add.join(''));
	}
}

/** Inserts text just before the closing tag of the root element. */
export function spliceBeforeClose(source: string, rootLocalName: string, add: string): string {
	if (add === '') return source;
	const re = new RegExp(`</(?:[\\w.-]+:)?${rootLocalName}\\s*>\\s*$`);
	const m = re.exec(source);
	if (m) return source.slice(0, m.index) + add + source.slice(m.index);
	// A self-closing root.
	const self = new RegExp(`<((?:[\\w.-]+:)?${rootLocalName})([^>]*?)/>\\s*$`).exec(source);
	if (self) {
		return `${source.slice(0, self.index)}<${self[1]}${self[2]}>${add}</${self[1]}>`;
	}
	throw new Error(`no </${rootLocalName}> to add to`);
}

/** The first element of a name anywhere below, breadth first. */
export function find(el: XElement, name: string): XElement | undefined {
	const queue = [el];
	while (queue.length > 0) {
		const e = queue.shift() as XElement;
		for (const k of kids(e)) {
			if (k.name === name) return k;
			queue.push(k);
		}
	}
	return undefined;
}
