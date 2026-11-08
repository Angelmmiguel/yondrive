/**
 * Size budgets for the built app, checked at the end of every client build so
 * that `pnpm build` (and so `just web-build`) fails when one is exceeded.
 *
 * The shell is what every screen loads before it draws anything: the entries,
 * the root layout and the layout of the signed-in app, with what they import
 * statically. A route is what its page adds to the shell, statically. Heavy
 * modules belong to the routes that use them, so the shell must hold none of
 * them; what a route loads on demand (pdf.js in the viewer, for one) is not
 * counted against it. Sizes are gzip. Workers are built on their own and do
 * not count either. `YONDRIVE_BUDGETS=print pnpm build` prints what it measures.
 */
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

const KIB = 1024;

/** Slightly above what the build measured when they were set; see docs/ARCHITECTURE.md. */
export const BUDGETS = {
	shellJs: 178 * KIB,
	shellCss: 14 * KIB,
	routeJs: {
		'/': 7 * KIB,
		'/admin': 15 * KIB,
		'/doc/[id]': 133 * KIB,
		'/enrol': 2 * KIB,
		'/favorites': 5 * KIB,
		'/files/[id]': 6 * KIB,
		'/invite': 3 * KIB,
		'/notes': 9 * KIB,
		'/notes/[id]': 136 * KIB,
		'/recent': 5 * KIB,
		'/r/[id]': 10 * KIB,
		'/recover': 4 * KIB,
		'/reset': 2 * KIB,
		'/s/[id]': 7 * KIB,
		'/settings': 7 * KIB,
		'/setup': 13 * KIB,
		'/shared': 6 * KIB,
		'/shared/by-me': 3 * KIB,
		'/sheet/[id]': 94 * KIB,
		'/signin': 3 * KIB,
		'/styleguide': 7 * KIB,
		'/tags/[id]': 5 * KIB,
		'/trash': 5 * KIB,
		'/unlock': 2 * KIB
	} as Record<string, number>
};

/** Modules that must never be in the shell, by a pattern on their path. */
const HEAVY: Record<string, RegExp> = {
	ProseMirror: /node_modules\/.*prosemirror-/,
	'pdf.js': /node_modules\/.*pdfjs-dist/,
	'formula engine': /src\/lib\/formula\//,
	'sheets grid': /src\/lib\/sheets\/(ui\/|service)/,
	'office formats': /src\/lib\/formats\/(cfb|csv|doc|docx|odf|ods|rtf|workbook|xls|xlsx.*)\.ts$/
};

interface Chunk {
	type: 'chunk';
	fileName: string;
	code: string;
	imports: string[];
	modules: Record<string, { renderedLength: number }>;
	facadeModuleId: string | null;
	isEntry: boolean;
	viteMetadata?: { importedCss: Set<string> };
}

interface Asset {
	type: 'asset';
	fileName: string;
	source: string | Uint8Array;
}

/** What a build measures, in gzip bytes, with the heavy modules found in its shell. */
export interface Sizes {
	shellJs: number;
	shellCss: number;
	routeJs: Record<string, number>;
	heavyInShell: string[];
}

const gz = (data: string | Uint8Array) => gzipSync(data, { level: 9 }).length;

/** The modules of a chunk that left code in it. */
const rendered = (c: Chunk) =>
	Object.entries(c.modules)
		.filter(([, m]) => m.renderedLength > 0)
		.map(([id]) => id);

/** The route a node chunk draws, from the page or layout module it holds. */
function routeOf(chunk: Chunk): string | null {
	for (const id of Object.keys(chunk.modules)) {
		const m = /src\/routes(\/.*)?\/\+(page|layout)\.svelte$/.exec(id);
		if (!m) continue;
		if (m[2] === 'layout') return `layout ${m[1] ?? '/'}`;
		return (m[1] ?? '').replace(/\/\([^)]+\)/g, '') || '/';
	}
	return null;
}

/** Measures a client bundle. */
export function measure(bundle: Record<string, Chunk | Asset>): Sizes {
	const chunks = Object.values(bundle).filter((o): o is Chunk => o.type === 'chunk');
	const byName = new Map(chunks.map((c) => [c.fileName, c]));
	const closure = (roots: Chunk[]): Set<Chunk> => {
		const out = new Set<Chunk>();
		const walk = (c: Chunk) => {
			if (out.has(c)) return;
			out.add(c);
			for (const i of c.imports) {
				const next = byName.get(i);
				if (next) walk(next);
			}
		};
		roots.forEach(walk);
		return out;
	};
	// Every route node is an entry of its own; the app's entries are the others.
	const nodes = chunks.filter((c) => /client-optimized\/nodes\//.test(c.facadeModuleId ?? ''));
	const layouts = nodes.filter((c) => ['layout /', 'layout /(app)'].includes(routeOf(c) ?? ''));
	const entries = chunks.filter((c) => c.isEntry && !nodes.includes(c));
	const shell = closure([...entries, ...layouts]);
	const css = new Set<string>();
	for (const c of shell) c.viteMetadata?.importedCss.forEach((f) => css.add(f));
	const routeJs: Record<string, number> = {};
	for (const node of nodes) {
		const route = routeOf(node);
		if (route === null || route.startsWith('layout ')) continue;
		let size = 0;
		for (const c of closure([node])) if (!shell.has(c)) size += gz(c.code);
		routeJs[route] = size;
	}
	const inShell = [...shell].flatMap(rendered);
	return {
		shellJs: [...shell].reduce((n, c) => n + gz(c.code), 0),
		shellCss: [...css].reduce((n, f) => n + gz((bundle[f] as Asset | undefined)?.source ?? ''), 0),
		routeJs,
		heavyInShell: Object.entries(HEAVY)
			.filter(([, re]) => inShell.some((id) => re.test(id)))
			.map(([name]) => name)
	};
}

/** What is over its budget, said in words; empty when the build fits. */
export function overBudget(sizes: Sizes, budgets = BUDGETS): string[] {
	const kib = (n: number) => `${(n / KIB).toFixed(1)} KiB`;
	const out = sizes.heavyInShell.map((name) => `${name} is in the shell`);
	if (sizes.shellJs > budgets.shellJs) {
		out.push(`shell JS ${kib(sizes.shellJs)} > ${kib(budgets.shellJs)}`);
	}
	if (sizes.shellCss > budgets.shellCss) {
		out.push(`shell CSS ${kib(sizes.shellCss)} > ${kib(budgets.shellCss)}`);
	}
	for (const [route, size] of Object.entries(sizes.routeJs)) {
		const budget = budgets.routeJs[route];
		if (budget === undefined) out.push(`${route} has no budget (${kib(size)})`);
		else if (size > budget) out.push(`${route} JS ${kib(size)} > ${kib(budget)}`);
	}
	return out;
}

/** Fails the client build when it is over a budget. */
export function budgets(): Plugin {
	return {
		name: 'yondrive-budgets',
		apply: 'build',
		generateBundle(_options, bundle) {
			if (this.environment.name !== 'client') return;
			const sizes = measure(bundle as unknown as Record<string, Chunk | Asset>);
			// The service worker is a client build of its own, with no routes in it.
			if (Object.keys(sizes.routeJs).length === 0) return;
			if (process.env.YONDRIVE_BUDGETS === 'print') console.log(JSON.stringify(sizes, null, '\t'));
			const over = overBudget(sizes);
			if (over.length > 0) this.error(`over the size budgets:\n  ${over.join('\n  ')}`);
		}
	};
}
