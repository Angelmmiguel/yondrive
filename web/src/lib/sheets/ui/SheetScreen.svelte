<!--
  The spreadsheet editor of the Sheets board: header, toolbar, name box and
  formula bar, the grid, sheet tabs, a status bar with the selection's sum and
  the zoom, and the details and versions panels. It opens one file in its own
  worker and saves edits as versions, as the document editor does.
-->
<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { api } from '$lib/api/client';
	import type { Editor } from '$lib/api/types';
	import { formatBytes, formatWhen } from '$lib/app/format';
	import {
		Banner,
		Button,
		Checkbox,
		Dialog,
		Field,
		Icon,
		Menu,
		SegmentedControl,
		TextInput,
		type MenuItem
	} from '$lib/components';
	import { describeDriveError } from '$lib/drive/errors';
	import type { DriveNode } from '$lib/drive/tree';
	import { listVersions, restoreVersion, type VersionEntry } from '$lib/drive/versions';
	import { driveFiles } from '$lib/editing/drive-files';
	import { Presence } from '$lib/editing/presence';
	import { EditSession, type SaveStatus, type SessionFile } from '$lib/editing/session';
	import FileSide from '$lib/editing/ui/FileSide.svelte';
	import { colName, MAX_COLS, MAX_ROWS, parseArea, type Area } from '$lib/formula/address';
	import {
		renameSheetFile,
		SHEET_FORMAT_NAMES,
		SHEET_MIME,
		sheetFormatOf,
		sheetSaveFormatOf,
		type SheetFormat,
		type SheetNotice,
		type SheetSaveFormat
	} from '$lib/formats/spreadsheet';
	import type { CellStyle, HAlign } from '$lib/formats/workbook';
	import { DEFAULT_STYLE } from '$lib/formats/workbook';
	import { canWrite, isOwner } from '$lib/sharing/roles';
	import { drive } from '$lib/state/drive.svelte';
	import { session as account } from '$lib/state/session.svelte';
	import { theme } from '$lib/state/theme.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { createSheets, type Sheets } from '../client';
	import { RemoteError, RpcTimeoutError } from '../rpc';
	import type { CellView, SheetMeta } from '../service';
	import { SheetCaches } from './cache';
	import { SheetEditor, type Outcome } from './edits';
	import { describeInputError } from './messages';
	import { areaOf, cellCount, overlaps, single, withMerges, type Selection } from './selection';
	import SheetGrid, { type Draft } from './SheetGrid.svelte';
	import SheetTabs, { type TabAction } from './SheetTabs.svelte';
	import SheetToolbar, { type BorderKind } from './SheetToolbar.svelte';
	import {
		BLANK,
		DISTINCT_LIMIT,
		distinctValues,
		hiddenRows as hiddenOf,
		statNumber,
		setOf,
		statsOf,
		textsByRow,
		toggled,
		type Filter
	} from './summary';

	interface Props {
		nodeId: string;
	}

	let { nodeId }: Props = $props();

	/** The most a spreadsheet may be to open here. */
	const OPEN_LIMIT = 64 * 1024 * 1024;
	const STATS_LIMIT = 200_000;

	let phase = $state<'loading' | 'ready' | 'failed' | 'stopped'>('loading');
	let problem = $state('');
	let fileId = $state(untrack(() => nodeId));
	let fileName = $state('');
	let format = $state<SheetFormat>('xlsx');
	let saveAs = $state<SheetSaveFormat>('xlsx');
	let status = $state<SaveStatus>('saved');
	let saveError = $state('');
	let notice = $state<SheetNotice | null>(null);
	let fixedRanges = $state.raw<string[]>([]);
	let warnedFixed = false;
	let mode = $state<'edit' | 'view'>('edit');
	let zoom = $state(100);
	const narrow = new MediaQuery('max-width: 720px');
	let panel = $state<'details' | 'versions' | null>(narrow.current ? null : 'details');
	let others = $state.raw<Editor[]>([]);
	let othersDismissed = $state(false);
	let conflict = $state<{ copy: SessionFile; original: SessionFile } | null>(null);
	let versions = $state.raw<VersionEntry[]>([]);
	let versionsError = $state('');

	let sheets = $state.raw<SheetMeta[]>([]);
	let current = $state(0);
	let styles = $state.raw<CellStyle[]>([DEFAULT_STYLE]);
	let rev = $state(0);
	let sel = $state<Selection>(single({ row: 0, col: 0 }));
	let draft = $state<Draft | null>(null);
	let activeView = $state.raw<CellView | null>(null);
	let inputError = $state('');
	let stats = $state('');
	let canUndo = $state(false);
	let canRedo = $state(false);
	let filters = $state.raw<Record<number, Filter>>({});
	let hidden = $state.raw<ReadonlySet<number>>(new Set());
	let grid = $state<ReturnType<typeof SheetGrid>>();
	let printRows = $state.raw<string[][] | null>(null);

	// Dialogs.
	let renaming = $state<{ id: number; name: string; error: string } | null>(null);
	let deleting = $state<SheetMeta | null>(null);
	let sorting = $state<{ area: Area; col: number; order: 'asc' | 'desc'; header: boolean } | null>(
		null
	);
	let filtering = $state<{
		col: number;
		values: string[];
		/** Values past the most the list shows, which stay as they are. */
		more: boolean;
		hidden: Set<string>;
	} | null>(null);
	let fixedWarning = $state.raw<(() => void) | null>(null);
	let mergeWarning = $state.raw<Area | null>(null);
	let converting = $state<{ to: SheetSaveFormat; lost: string[] } | null>(null);

	let client: Sheets | null = null;
	let stopping = false;
	let editor: SheetEditor | null = null;
	let fileSession: EditSession<SheetSaveFormat> | null = null;
	const caches = new SheetCaches();

	const node = $derived(drive.node(fileId));
	const canEdit = $derived(node !== undefined && canWrite(node));
	const editing = $derived(canEdit && mode === 'edit' && phase === 'ready');
	const meta = $derived(sheets.find((s) => s.id === current) ?? sheets[0]);
	const cache = $derived(caches.of(meta?.id ?? -1));
	const area = $derived(meta ? withMerges(areaOf(sel), meta.merges) : areaOf(sel));
	const textFormat = (f: string) => f === 'csv' || f === 'tsv';
	const filter = $derived(filters[current] ?? null);
	const filterCols = $derived(
		filter && meta
			? new Set(Array.from({ length: Math.max(1, meta.cols) }, (_, i) => i))
			: new Set<number>()
	);

	const presence = new Presence({
		api,
		onchange: (list) => {
			others = list;
			if (list.length === 0) othersDismissed = false;
		}
	});

	function stopWorker() {
		stopping = true;
		client?.stop();
		client = null;
		stopping = false;
	}

	const stopped = () => phase === 'stopped';

	/** The worker ended: what it held is gone, so nothing more may be saved from it. */
	function workerFailed() {
		if (stopping || phase !== 'ready') return;
		fileSession?.discard();
		phase = 'stopped';
		presence.stop();
	}

	async function load() {
		phase = 'loading';
		problem = '';
		const core = drive.core;
		if (core === null) return;
		try {
			const found = await core.tree.resolve(fileId);
			if (found.kind !== 'file' || found.currentVersion === null)
				throw new Error('This file has nothing in it yet.');
			const f = sheetFormatOf(found.name);
			if (f === null) throw new Error('This kind of file does not open in the spreadsheet editor.');
			const version = await core.openVersion(found);
			const blob = await core.readBlob(found, version, { limit: OPEN_LIMIT });
			const bytes = new Uint8Array(await blob.arrayBuffer());
			stopWorker();
			const c = createSheets({ onFail: workerFailed });
			client = c;
			const loaded = await c.api.load(bytes, f);
			fileSession?.discard();
			caches.reset();
			const ed = new SheetEditor(c.api, loaded.styles);
			editor = ed;
			format = f;
			saveAs = sheetSaveFormatOf(f);
			fileName = found.name;
			notice = loaded.notice;
			fixedRanges = loaded.fixedRanges;
			warnedFixed = false;
			styles = loaded.styles;
			sheets = loaded.sheets;
			current = loaded.sheets.find((s) => !s.hidden)?.id ?? loaded.sheets[0].id;
			sel = single({ row: 0, col: 0 });
			draft = null;
			filters = {};
			hidden = new Set();
			mode = canWrite(found) ? 'edit' : 'view';
			syncHistory();
			fileSession = new EditSession<SheetSaveFormat>(
				{
					...driveFiles(),
					onstatus: (s, e) => {
						status = s;
						saveError = s === 'failed' ? describeDriveError(e) : '';
					},
					onconflict: (copy) => {
						conflict = {
							copy,
							original: { id: found.id, name: found.name, version: found.currentVersion ?? '' }
						};
						toasts.push(
							'info',
							`Someone else saved this spreadsheet first. Your changes are in a copy: ${copy.name}`,
							0
						);
					},
					onfile: (file) => {
						const moved = file.id !== fileId;
						fileId = file.id;
						fileName = file.name;
						format = sheetFormatOf(file.name) ?? format;
						if (moved) {
							replaceState(resolve(`/sheet/${file.id}`), {});
							presence.start(file.id, editing);
						}
					}
				},
				{ id: found.id, name: found.name, version: found.currentVersion },
				{ original: f, saveAs: sheetSaveFormatOf(f) },
				async (to) => (await ed.save(to, textFormat(to) ? current : undefined)).bytes
			);
			phase = 'ready';
			presence.start(found.id, canWrite(found));
			void loadVersions();
			await tick();
			grid?.focus();
		} catch (e) {
			// The worker may have ended while this ran: that says it all already.
			if (stopped()) return;
			phase = 'failed';
			problem =
				e instanceof RemoteError
					? 'The file could not be read as a spreadsheet. It may be damaged, or use parts of the format this app does not read.'
					: e instanceof Error && !('code' in e)
						? e.message
						: describeDriveError(e);
		}
	}

	async function loadVersions() {
		const core = drive.core;
		const sealer = account.sealer;
		if (core === null || sealer === null) return;
		try {
			versionsError = '';
			versions = await listVersions(fileId, drive.node(fileId)?.currentVersion ?? null, {
				api,
				sealer
			});
		} catch (e) {
			versionsError = describeDriveError(e);
		}
	}

	$effect(() => {
		if (status === 'saved') untrack(() => void loadVersions());
	});

	$effect(() => {
		if (drive.status !== 'ready') return;
		untrack(() => void load());
	});

	$effect(() => {
		const e = editing;
		untrack(() => {
			if (phase === 'ready') presence.start(fileId, e);
			if (!e) draft = null;
		});
	});

	onDestroy(() => {
		const s = fileSession;
		presence.stop();
		void (s?.close() ?? Promise.resolve()).finally(() => stopWorker());
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		if (fileSession?.dirty) {
			void fileSession.flush();
			event.preventDefault();
		}
	}

	// --- Reading cells ---------------------------------------------------------------

	function windowOf(a: Area): Promise<CellView[]> {
		if (!client) return Promise.resolve([]);
		return client.api.window(current, a.top, a.left, a.bottom, a.right);
	}

	/** The active cell, for the formula bar and the toolbar. */
	$effect(() => {
		void rev;
		const p = sel.active;
		const id = current;
		const c = client;
		if (!c || phase !== 'ready') return;
		void c.api.cell(id, p.row, p.col).then(
			(v) => {
				if (id === current && p === sel.active) activeView = v;
			},
			() => {}
		);
	});

	/** The selection by name; typing another one there and Enter goes to it. */
	let nameBox = $derived(
		cellCount(areaOf(sel)) > 1 && area.bottom < MAX_ROWS - 1 && area.right < MAX_COLS - 1
			? `${colName(area.left)}${area.top + 1}:${colName(area.right)}${area.bottom + 1}`
			: `${colName(sel.active.col)}${sel.active.row + 1}`
	);

	const activeStyle = $derived(styles[activeView?.style ?? 0] ?? DEFAULT_STYLE);

	/** The selection cut to what has content. */
	function used(a: Area): Area {
		const m = meta;
		if (!m) return a;
		return {
			top: a.top,
			left: a.left,
			bottom: Math.max(a.top, Math.min(a.bottom, m.rows - 1)),
			right: Math.max(a.left, Math.min(a.right, m.cols - 1))
		};
	}

	// The status bar: sum, average and count of the selection, a moment after it settles.
	let statsTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		void rev;
		const a = used(area);
		const id = current;
		if (phase !== 'ready') return;
		if (statsTimer) clearTimeout(statsTimer);
		statsTimer = setTimeout(() => {
			if (cellCount(a) > STATS_LIMIT) {
				stats = '';
				return;
			}
			void windowOf(a).then((cells) => {
				if (id !== current) return;
				const s = statsOf(cells.filter((c) => !hidden.has(c.row)).map((c) => c.value));
				stats =
					s.numbers > 0
						? `Sum: ${statNumber(s.sum)}  ·  Average: ${statNumber(s.average ?? 0)}  ·  Count: ${s.count}`
						: s.count > 0
							? `Count: ${s.count}`
							: '';
			});
		}, 120);
	});

	// --- Filtering -------------------------------------------------------------------

	async function columnTexts(f: Filter, col: number, last: number): Promise<Map<number, string>> {
		const cells = await windowOf({ top: f.header + 1, left: col, bottom: last, right: col });
		return textsByRow(cells);
	}

	async function refilter() {
		const f = filter;
		const m = meta;
		if (!f || !m) {
			hidden = new Set();
			return;
		}
		const last = m.rows - 1;
		const texts: Record<number, ReadonlyMap<number, string>> = {};
		for (const cf of f.columns) texts[cf.col] = await columnTexts(f, cf.col, last);
		hidden = hiddenOf(f, last, (c) => texts[c] ?? textsByRow([]));
	}

	$effect(() => {
		void filter;
		void current;
		untrack(() => void refilter());
	});

	async function openFilter(col: number) {
		let f = filter;
		const m = meta;
		if (!m) return;
		if (!f) {
			f = { header: sel.active.row, columns: [] };
			filters = { ...filters, [current]: f };
		}
		const texts = await columnTexts(f, col, m.rows - 1);
		const { values, more } = distinctValues(
			texts,
			f.header + 1,
			Math.max(f.header + 1, m.rows - 1)
		);
		filtering = {
			col,
			values,
			more,
			hidden: setOf(f.columns.find((c) => c.col === col)?.hidden ?? [])
		};
	}

	function applyFilter() {
		const f = filter;
		const fl = filtering;
		if (!f || !fl) return;
		const columns = f.columns.filter((c) => c.col !== fl.col);
		if (fl.hidden.size > 0) columns.push({ col: fl.col, hidden: setOf(fl.hidden) });
		filters = { ...filters, [current]: { ...f, columns } };
		filtering = null;
	}

	function clearFilter() {
		const { [current]: _gone, ...rest } = filters;
		void _gone;
		filters = rest;
		filtering = null;
	}

	// --- Edits -----------------------------------------------------------------------

	function syncHistory() {
		canUndo = editor?.history.canUndo ?? false;
		canRedo = editor?.history.canRedo ?? false;
	}

	/** Takes in what an edit changed: new styles, the sheets' layout, cells to fetch again. */
	async function absorb(out: Outcome) {
		if (out.styles) styles = out.styles;
		const m = meta;
		const beyond =
			m && out.changed.some((r) => r.sheet === m.id && (r.row >= m.rows || r.col >= m.cols));
		if (out.layout || beyond || out.changed.some((r) => r.sheet !== current)) {
			if (client) sheets = await client.api.sheets();
		}
		if (out.layout) caches.clear();
		else caches.changed(out.changed);
		rev++;
		if (filter) void refilter();
	}

	function report(e: unknown) {
		if (e instanceof RpcTimeoutError || phase === 'stopped') return;
		const msg = e instanceof RemoteError ? describeInputError(e) : null;
		toasts.push('danger', msg ?? (e instanceof Error ? e.message : 'That did not work.'));
	}

	/** Runs an edit, then saves soon. False when it was refused. */
	async function apply(run: (ed: SheetEditor) => Promise<Outcome | null>): Promise<boolean> {
		const ed = editor;
		if (!ed || !editing) return false;
		try {
			const out = await run(ed);
			if (!out) return true;
			await absorb(out);
			fileSession?.changed();
			if (out.partial)
				toasts.push(
					'info',
					'That area is too large to format every empty cell, so only the cells with something in them were formatted.'
				);
			if (out.notUndoable)
				toasts.push('info', 'That change is too large to undo, so the undo history was cleared.');
			if (out.step) {
				if (out.step.sheet !== current) current = out.step.sheet;
				const a = out.step.area;
				sel = {
					anchor: { row: a.top, col: a.left },
					focus: { row: a.bottom, col: a.right },
					active: { row: a.top, col: a.left }
				};
				grid?.reveal(sel.active);
			}
			return true;
		} catch (e) {
			report(e);
			return false;
		} finally {
			syncHistory();
		}
	}

	async function onedit(edits: { row: number; col: number; text: string }[]): Promise<boolean> {
		inputError = '';
		const ed = editor;
		if (!ed || !editing) return false;
		try {
			const out = await ed.setCells(current, edits);
			await absorb(out);
			fileSession?.changed();
			return true;
		} catch (e) {
			if (e instanceof RemoteError && e.name === 'FormulaInputError') {
				inputError = describeInputError(e);
				return false;
			}
			report(e);
			return false;
		} finally {
			syncHistory();
		}
	}

	const style = (patch: Parameters<SheetEditor['style']>[2][number]['patch'], label?: string) =>
		apply((ed) => ed.style(current, area, [{ area, patch }], label));

	function toggleMark(mark: 'bold' | 'italic' | 'strike') {
		void style({ font: { [mark]: activeStyle.font[mark] ? null : true } });
	}

	function setBorder(kind: BorderKind) {
		const thin = { style: 'thin' };
		const a = area;
		const parts: { area: Area; patch: Parameters<SheetEditor['style']>[2][number]['patch'] }[] = [];
		const edge = (k: 'top' | 'bottom' | 'left' | 'right') => {
			const strip =
				k === 'top'
					? { ...a, bottom: a.top }
					: k === 'bottom'
						? { ...a, top: a.bottom }
						: k === 'left'
							? { ...a, right: a.left }
							: { ...a, left: a.right };
			parts.push({ area: strip, patch: { border: { [k]: thin } } });
		};
		if (kind === 'all')
			parts.push({
				area: a,
				patch: { border: { top: thin, right: thin, bottom: thin, left: thin } }
			});
		else if (kind === 'none')
			parts.push({
				area: a,
				patch: { border: { top: null, right: null, bottom: null, left: null } }
			});
		else if (kind === 'outer') (['top', 'bottom', 'left', 'right'] as const).forEach(edge);
		else edge(kind);
		void apply((ed) => ed.style(current, a, parts, 'Borders'));
	}

	async function toggleMerge() {
		const m = meta;
		if (!m) return;
		const a = area;
		if (m.merges.some((x) => overlaps(x, a))) {
			await apply((ed) => ed.unmerge(current, a));
			return;
		}
		if (cellCount(a) === 1) {
			toasts.push('info', 'Select more than one cell to merge.');
			return;
		}
		if (cellCount(a) > 100_000) {
			toasts.push('info', 'That is too large to merge.');
			return;
		}
		const cells = await windowOf(a);
		if (cells.some((c) => (c.row !== a.top || c.col !== a.left) && c.text !== '')) mergeWarning = a;
		else await apply((ed) => ed.merge(current, a));
	}

	/** Rows and columns: a warning first where the file has ranges that will not follow. */
	function structural(run: () => void) {
		if (fixedRanges.length > 0 && !warnedFixed) fixedWarning = run;
		else run();
	}

	function rowsCols(id: string) {
		const a = area;
		const nRows = a.bottom - a.top + 1;
		const nCols = a.right - a.left + 1;
		const whole = (r: boolean) =>
			r ? a.left === 0 && a.right >= MAX_COLS - 1 : a.top === 0 && a.bottom >= MAX_ROWS - 1;
		structural(() => {
			if (id === 'row-above')
				void apply((ed) => ed.insert(current, 'rows', a.top, whole(true) ? nRows : 1));
			else if (id === 'row-below')
				void apply((ed) => ed.insert(current, 'rows', a.bottom + 1, whole(true) ? nRows : 1));
			else if (id === 'row-delete')
				void apply((ed) => ed.remove(current, 'rows', a.top, whole(true) ? nRows : 1)).then(
					fitSelection
				);
			else if (id === 'col-left')
				void apply((ed) => ed.insert(current, 'cols', a.left, whole(false) ? nCols : 1));
			else if (id === 'col-right')
				void apply((ed) => ed.insert(current, 'cols', a.right + 1, whole(false) ? nCols : 1));
			else if (id === 'col-delete')
				void apply((ed) => ed.remove(current, 'cols', a.left, whole(false) ? nCols : 1)).then(
					fitSelection
				);
		});
	}

	function fitSelection() {
		sel = single(sel.active);
	}

	async function openSort() {
		const m = meta;
		if (!m) return;
		const a =
			cellCount(areaOf(sel)) > 1
				? used(area)
				: { top: 0, left: 0, bottom: Math.max(0, m.rows - 1), right: Math.max(0, m.cols - 1) };
		const top = await windowOf({ ...a, bottom: Math.min(a.bottom, a.top + 1) });
		const first = top.filter((c) => c.row === a.top);
		const second = top.filter((c) => c.row === a.top + 1);
		const header =
			a.bottom > a.top &&
			first.length > 0 &&
			first.every((c) => typeof c.value === 'string') &&
			second.some((c) => typeof c.value !== 'string');
		sorting = {
			area: a,
			col: Math.min(Math.max(sel.active.col, a.left), a.right),
			order: 'asc',
			header
		};
	}

	function runSort() {
		// A plain copy: what crosses to the worker cannot be a reactive proxy.
		const s = $state.snapshot(sorting);
		sorting = null;
		if (!s) return;
		void apply((ed) =>
			ed.sort(current, s.area, [{ col: Number(s.col), desc: s.order === 'desc' }], s.header)
		);
	}

	function oncommand(cmd: 'undo' | 'redo' | 'bold' | 'italic' | 'strike' | 'save') {
		if (cmd === 'save') void fileSession?.flush();
		else if (cmd === 'undo') void apply((ed) => ed.undo());
		else if (cmd === 'redo') void apply((ed) => ed.redo());
		else if (editing) toggleMark(cmd);
	}

	function onpaste(at: { row: number; col: number }, rows: string[][], cut: Area | null) {
		const edits: { row: number; col: number; text: string }[] = [];
		rows.forEach((r, i) =>
			r.forEach((text, j) => edits.push({ row: at.row + i, col: at.col + j, text }))
		);
		if (edits.length > 100_000) {
			toasts.push('info', 'That is too much to paste at once.');
			return;
		}
		const dest = {
			top: at.row,
			left: at.col,
			bottom: at.row + rows.length - 1,
			right: at.col + Math.max(...rows.map((r) => r.length)) - 1
		};
		if (cut) {
			// The cells left behind are emptied, where the paste did not land on them.
			for (let r = cut.top; r <= cut.bottom; r++)
				for (let c = cut.left; c <= cut.right; c++)
					if (r < dest.top || r > dest.bottom || c < dest.left || c > dest.right)
						edits.push({ row: r, col: c, text: '' });
		}
		void apply((ed) => ed.setCells(current, edits, cut ? 'Move' : 'Paste')).then((ok) => {
			if (ok)
				sel = {
					anchor: { row: dest.top, col: dest.left },
					focus: { row: dest.bottom, col: dest.right },
					active: { row: dest.top, col: dest.left }
				};
		});
	}

	// --- Sheets ----------------------------------------------------------------------

	async function sheetOp(run: (s: Sheets['api']) => Promise<unknown>) {
		const ed = editor;
		if (!ed || !editing || !client) return;
		try {
			await ed.untracked(run);
			sheets = await client.api.sheets();
			fileSession?.changed();
		} catch (e) {
			report(e);
		} finally {
			syncHistory();
		}
	}

	async function pick(id: number) {
		if (draft && !(await grid?.commit())) return;
		if (id === current) return;
		current = id;
		sel = single({ row: 0, col: 0 });
		void tick().then(() => grid?.focus());
	}

	async function addSheet() {
		const ed = editor;
		if (!ed || !client) return;
		let made: SheetMeta | null = null;
		await sheetOp(async (a) => (made = await a.addSheet()));
		const m = made as SheetMeta | null;
		if (m) void pick(m.id);
	}

	function tabAction(id: number, action: TabAction) {
		const at = sheets.filter((s) => !s.hidden).findIndex((s) => s.id === id);
		const all = sheets.findIndex((s) => s.id === id);
		if (action === 'rename') renaming = { id, name: sheets[all].name, error: '' };
		else if (action === 'delete') deleting = sheets[all];
		else if (action === 'left' || action === 'right') {
			const shown = sheets.filter((s) => !s.hidden);
			const other = shown[at + (action === 'left' ? -1 : 1)];
			if (!other) return;
			const to = sheets.findIndex((s) => s.id === other.id);
			void sheetOp((a) => a.moveSheet(id, to));
		} else if (action === 'hide') {
			void sheetOp((a) => a.setSheetHidden(id, true)).then(() => {
				if (id === current) void pick(sheets.find((s) => !s.hidden)?.id ?? id);
			});
		} else if (action.startsWith('show:')) {
			const show = Number(action.slice(5));
			void sheetOp((a) => a.setSheetHidden(show, false)).then(() => pick(show));
		}
	}

	async function doRename() {
		const r = renaming;
		const ed = editor;
		if (!r || !ed || !client) return;
		try {
			await ed.untracked((a) => a.renameSheet(r.id, r.name));
			sheets = await client.api.sheets();
			fileSession?.changed();
			renaming = null;
			rev++;
		} catch (e) {
			if (e instanceof RemoteError) renaming = { ...r, error: describeInputError(e) };
			else report(e);
		} finally {
			syncHistory();
		}
	}

	async function doDelete() {
		const d = deleting;
		deleting = null;
		if (!d) return;
		await sheetOp((a) => a.removeSheet(d.id));
		caches.stale();
		rev++;
		if (d.id === current) void pick(sheets.find((s) => !s.hidden)?.id ?? sheets[0].id);
	}

	function freeze(id: string) {
		const m = meta;
		if (!m) return;
		const f = m.frozen ?? { rows: 0, cols: 0 };
		const next =
			id === 'freeze-row'
				? { rows: f.rows === 1 ? 0 : 1, cols: f.cols }
				: id === 'freeze-col'
					? { rows: f.rows, cols: f.cols === 1 ? 0 : 1 }
					: id === 'freeze-here'
						? { rows: sel.active.row, cols: sel.active.col }
						: { rows: 0, cols: 0 };
		void apply((ed) => ed.freeze(current, next.rows, next.cols));
	}

	// --- Saving, converting, downloading -----------------------------------------

	async function confirmConvert() {
		const c = converting;
		converting = null;
		if (!c || !fileSession) return;
		saveAs = c.to;
		await fileSession.convertTo(c.to);
		if (fileSession.status === 'saved') {
			toasts.push(
				'ok',
				`Saved as ${SHEET_FORMAT_NAMES[c.to]}. The previous version is in Versions.`
			);
			format = c.to;
			notice = { summary: `Saved as .${c.to} from now on.`, lines: [] };
		}
	}

	async function askConvert(to: string) {
		if (!client) return;
		const f = to as SheetSaveFormat;
		converting = { to: f, lost: await client.api.lostOnSave(f) };
	}

	const originalExt = $derived(sheetFormatOf(fileName) ?? format);
	const downloads = $derived<MenuItem[]>([
		{
			id: 'original',
			lead: `.${originalExt}`,
			label: SHEET_FORMAT_NAMES[originalExt],
			note: 'Original'
		},
		...(['xlsx', 'ods'] as SheetSaveFormat[])
			.filter((f) => f !== originalExt)
			.map((f) => ({ id: f, lead: `.${f}`, label: SHEET_FORMAT_NAMES[f] })),
		...(['csv', 'tsv'] as SheetSaveFormat[])
			.filter((f) => f !== originalExt)
			.map((f) => ({ id: f, lead: `.${f}`, label: SHEET_FORMAT_NAMES[f], note: 'This sheet' })),
		{ id: 'print', label: 'Print or save as PDF…', icon: 'print' as const }
	]);

	async function download(id: string) {
		if (id === 'print') {
			await print();
			return;
		}
		if (id === 'original') {
			if (node) await drive.download(node);
			return;
		}
		const ed = editor;
		if (!ed) return;
		try {
			const f = id as SheetSaveFormat;
			const { bytes } = await ed.save(f, current);
			const url = URL.createObjectURL(
				new Blob([bytes as Uint8Array<ArrayBuffer>], { type: SHEET_MIME[f] })
			);
			const a = document.createElement('a');
			a.href = url;
			a.download = renameSheetFile(fileName, f);
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			if (textFormat(f) && sheets.length > 1)
				toasts.push(
					'info',
					`Only the sheet “${meta?.name}” is in this file: ${f.toUpperCase()} holds one sheet of values.`
				);
		} catch (e) {
			report(e);
		}
	}

	/** The browser prints the sheet's used cells as a plain table, as the grid only draws what is in view. */
	async function print() {
		const m = meta;
		if (!m) return;
		const a = { top: 0, left: 0, bottom: Math.max(0, m.rows - 1), right: Math.max(0, m.cols - 1) };
		if (cellCount(a) > 100_000) {
			toasts.push(
				'info',
				'This sheet is too large to print from here. Download it and print it from another app.'
			);
			return;
		}
		const cells = await windowOf(a);
		const rows = Array.from({ length: a.bottom + 1 }, () => Array<string>(a.right + 1).fill(''));
		for (const c of cells) if (!hidden.has(c.row)) rows[c.row][c.col] = c.text;
		printRows = rows.filter((_, i) => !hidden.has(i));
		await tick();
		window.print();
	}

	async function restore(v: VersionEntry) {
		const core = drive.core;
		const sealer = account.sealer;
		if (!core || !sealer || !node) return;
		await fileSession?.flush();
		try {
			await restoreVersion(fileId, v, node.currentVersion, { api, sealer, tree: core.tree });
			toasts.push('ok', 'Restored as the current version.');
			await load();
		} catch (e) {
			toasts.push('danger', describeDriveError(e));
		}
	}

	// --- Formula bar -------------------------------------------------------------

	$effect(() => {
		if (draft === null) inputError = '';
	});

	const barValue = $derived(draft ? draft.text : (grid?.inputOf(activeView) ?? ''));

	function onbarfocus() {
		if (!editing || draft) return;
		if (activeView?.readOnly) return;
		draft = { text: grid?.inputOf(activeView) ?? '', how: 'edit' };
	}

	function onbarinput(e: Event & { currentTarget: HTMLInputElement }) {
		if (!editing) return;
		draft = { text: e.currentTarget.value, how: 'edit' };
	}

	function onbarkey(e: KeyboardEvent) {
		if (!draft) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			void grid?.commit(e.shiftKey ? -1 : 1, 0, e.ctrlKey || e.metaKey);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			void grid?.commit(0, e.shiftKey ? -1 : 1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			inputError = '';
			grid?.cancel();
		}
	}

	function onnamekey(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		const a = parseArea(e.currentTarget.value.trim().toUpperCase());
		if (!a) {
			toasts.push('info', 'Type a cell or a range, such as B4 or A1:C10.');
			return;
		}
		sel = {
			anchor: { row: a.top, col: a.left },
			focus: { row: a.bottom, col: a.right },
			active: { row: a.top, col: a.left }
		};
		grid?.reveal(sel.active);
		grid?.focus();
	}

	function insertFunction(name: string) {
		if (!editing) return;
		void grid?.startEdit('edit', `=${name}(`);
	}

	// --- Header ------------------------------------------------------------------

	const MODES = [
		{ value: 'edit', label: 'Editing', icon: 'pencil' },
		{ value: 'view', label: 'Viewing', icon: 'eye' }
	] as const;

	const trail = $derived.by(() => {
		void drive.rev;
		const n = node;
		if (!n) return [];
		return drive.core?.tree.breadcrumbs(n.id).slice(0, -1) ?? [];
	});

	const details = $derived.by(() => {
		const n = node;
		if (!n || !meta) return [];
		return [
			{ k: 'Format', v: `${SHEET_FORMAT_NAMES[format]} (.${format})` },
			{ k: 'Size', v: formatBytes(n.size) },
			{ k: 'Sheets', v: String(sheets.length) },
			{
				k: 'This sheet',
				v: `${meta.rows} ${meta.rows === 1 ? 'row' : 'rows'} · ${meta.cols} ${meta.cols === 1 ? 'column' : 'columns'}`
			},
			{
				k: 'Location',
				v: [
					isOwner(n) ? 'My files' : 'Shared',
					...trail.slice(1).map((t: DriveNode) => t.name)
				].join(' / ')
			},
			{ k: 'Owner', v: isOwner(n) ? 'You' : 'Shared with you' },
			{ k: 'Created', v: formatWhen(n.created) },
			{ k: 'Modified', v: formatWhen(n.updatedAt) }
		];
	});

	const saveTargets = $derived(
		(textFormat(originalExt)
			? [originalExt as SheetSaveFormat, 'xlsx', 'ods']
			: (['xlsx', 'ods'] as SheetSaveFormat[])
		).map((f) => ({
			id: f,
			name: SHEET_FORMAT_NAMES[f as SheetSaveFormat]
		}))
	);

	const back = $derived(node?.parentId ? resolve(`/files/${node.parentId}`) : resolve('/'));
	const statusText = $derived(
		!canEdit
			? 'View only'
			: { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', failed: 'Not saved' }[
					status
				]
	);
	const othersNames = $derived(others.map((o) => o.username).join(', '));
	const dark = $derived(
		theme.choice === 'dark' ||
			(theme.choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
	);

	const viewItems = $derived<MenuItem[]>([
		{
			id: 'freeze-row',
			label: meta?.frozen?.rows === 1 ? 'Unfreeze the top row' : 'Freeze the top row'
		},
		{
			id: 'freeze-col',
			label: meta?.frozen?.cols === 1 ? 'Unfreeze the first column' : 'Freeze the first column'
		},
		{ id: 'freeze-here', label: 'Freeze above and left of the cell' },
		...(meta?.frozen ? [{ id: 'unfreeze', label: 'Unfreeze' }] : []),
		{ id: 'recalc', label: 'Recalculate', icon: 'history' as const }
	]);

	/** More: what the sheet offers besides the toolbar, and on a phone what does not fit in the header. */
	const more = $derived<MenuItem[]>([
		...(narrow.current && canEdit
			? [
					mode === 'edit'
						? { id: 'mode', label: 'Switch to viewing', icon: 'eye' as const }
						: { id: 'mode', label: 'Switch to editing', icon: 'pencil' as const }
				]
			: []),
		...(editing ? viewItems : []),
		...(narrow.current && node && isOwner(node)
			? [{ id: 'share', label: 'Share…', icon: 'shared' as const }]
			: []),
		...(narrow.current ? downloads.map((d) => ({ ...d, id: `download:${d.id}` })) : []),
		...(narrow.current
			? [
					{
						id: 'theme',
						label: dark ? 'Light theme' : 'Dark theme',
						icon: (dark ? 'sun' : 'moon') as 'sun' | 'moon'
					}
				]
			: [])
	]);

	function chooseMore(id: string) {
		if (id === 'mode') mode = mode === 'edit' ? 'view' : 'edit';
		else if (id === 'share' && node) drive.dialog = { kind: 'share', node };
		else if (id === 'theme') theme.choose(dark ? 'light' : 'dark');
		else if (id.startsWith('download:')) void download(id.slice('download:'.length));
		else if (id === 'recalc') {
			const c = client;
			if (c)
				void apply((ed) =>
					ed.queue(async () => ({ changed: (await c.api.recalc()).changed, layout: false }))
				);
		} else freeze(id);
	}

	function setFavorite() {
		const n = node;
		if (!n) return;
		void drive.run((core) => core.tree.patch(n.id, { favorite: !n.favorite }));
	}

	function togglePanel() {
		panel = panel ? null : 'details';
	}

	const canAddSheet = $derived(!textFormat(format));
	const csvNote = $derived(
		textFormat(format)
			? `A .${format} file holds one sheet of values. To keep formulas, formatting or more sheets, download it as .xlsx or change “Save changes as” in Details.`
			: ''
	);
</script>

<svelte:window onbeforeunload={beforeUnload} />
<svelte:head><title>{fileName || 'Spreadsheet'} · YonDrive</title></svelte:head>

<div class="screen">
	<div class="top">
		<header class="head">
			<a class="ghost back" href={back} aria-label="Back to the folder"
				><Icon name="arrow-left" /></a
			>
			<span class="badge" aria-hidden="true"><Icon name="sheet" size={19} /></span>
			<div class="title">
				<div class="line">
					<h1 class="name" title={fileName}>{fileName}</h1>
					<span class="fmt">{format.toUpperCase()}</span>
					{#if node && isOwner(node)}
						<button
							type="button"
							class="ghost star"
							class:on={node.favorite}
							aria-label={node.favorite ? 'Remove from favorites' : 'Add to favorites'}
							aria-pressed={node.favorite}
							onclick={setFavorite}><Icon name="star" size={16} filled={node.favorite} /></button
						>
					{/if}
				</div>
				<div class="meta">
					{#if !narrow.current && trail.length > 0}
						<nav aria-label="Location" class="crumbs">
							{#each trail as t, i (t.id)}
								{#if i > 0}<span aria-hidden="true">/</span>{/if}
								<a href={i === 0 ? resolve('/') : resolve(`/files/${t.id}`)}
									>{i === 0 ? (node && isOwner(node) ? 'My files' : 'Shared') : t.name}</a
								>
							{/each}
						</nav>
						<span aria-hidden="true">·</span>
					{/if}
					<span
						data-testid="save-status"
						class:bad={status === 'failed'}
						title={saveError || undefined}
						>{#if status === 'saved' && canEdit}<Icon
								name="check"
								size={13}
							/>{/if}{statusText}</span
					>
					{#if status === 'failed' && phase === 'ready'}
						<button type="button" class="retry" onclick={() => void fileSession?.flush()}
							>Try again</button
						>
					{/if}
				</div>
			</div>
			{#if narrow.current}
				<Menu label="More" items={more} width={280} align="end" onselect={chooseMore}>
					{#snippet trigger(attrs)}
						<button type="button" class="ghost" aria-label="More" {...attrs}
							><Icon name="more" /></button
						>
					{/snippet}
				</Menu>
			{:else}
				<div class="actions">
					{#if canEdit}
						<SegmentedControl
							label="Mode"
							options={MODES}
							value={mode}
							onchange={(v) => (mode = v as 'edit' | 'view')}
						/>
					{/if}
					<Menu
						label="Download as"
						heading="Download as"
						triggerLabel="Download"
						triggerIcon="download"
						items={downloads}
						width={300}
						align="end"
						onselect={(id) => void download(id)}
					/>
					{#if node && isOwner(node)}
						<Button
							variant="primary"
							icon="shared"
							onclick={() => node && (drive.dialog = { kind: 'share', node })}>Share</Button
						>
					{/if}
					<button
						type="button"
						class="ghost"
						aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
						onclick={() => theme.choose(dark ? 'light' : 'dark')}
						><Icon name={dark ? 'sun' : 'moon'} /></button
					>
					{#if more.length > 0}
						<Menu label="More options" items={more} width={280} align="end" onselect={chooseMore}>
							{#snippet trigger(attrs)}
								<button type="button" class="ghost" aria-label="More options" {...attrs}
									><Icon name="more" /></button
								>
							{/snippet}
						</Menu>
					{/if}
				</div>
			{/if}
		</header>
		{#if phase === 'ready' && editing}
			<SheetToolbar
				style={activeStyle}
				merged={!!meta?.merges.some((m) => overlaps(m, area))}
				filterOn={filter !== null}
				panel={panel !== null}
				{canUndo}
				{canRedo}
				onundo={() => oncommand('undo')}
				onredo={() => oncommand('redo')}
				onnumfmt={(code) => void style({ numFmt: code }, 'Number format')}
				onfontsize={(pt) => void style({ font: { size: pt } }, 'Font size')}
				onmark={toggleMark}
				oncolor={(which, color) =>
					void (which === 'text'
						? style({ font: { color } }, 'Text color')
						: style({ fill: color }, 'Fill color'))}
				onborder={setBorder}
				onmerge={() => void toggleMerge()}
				onalign={(h: HAlign) =>
					void style({ align: { h: h === 'general' ? null : h } }, 'Alignment')}
				onwrap={() => void style({ align: { wrap: activeStyle.align.wrap ? null : true } }, 'Wrap')}
				onsort={() => void openSort()}
				onfilter={() => void openFilter(sel.active.col)}
				onfunction={insertFunction}
				ontogglepanel={togglePanel}
			/>
		{:else if phase === 'ready'}
			<div class="viewbar">
				<button
					type="button"
					class="ghost sm"
					aria-pressed={panel !== null}
					aria-label="Toggle details panel"
					onclick={togglePanel}><Icon name="panel" size={16} /> Details</button
				>
			</div>
		{/if}
		{#if phase === 'ready'}
			<div class="fbar">
				<label for="sheet-namebox" class="sr">Selected cell</label>
				<input
					id="sheet-namebox"
					class="namebox"
					bind:value={nameBox}
					spellcheck="false"
					autocomplete="off"
					onkeydown={onnamekey}
				/>
				<span class="fx" aria-hidden="true">fx</span>
				<label for="sheet-formula" class="sr">Cell contents</label>
				<input
					id="sheet-formula"
					class="formula"
					value={barValue}
					readonly={!editing || !!activeView?.readOnly}
					spellcheck="false"
					autocomplete="off"
					title={activeView?.readOnly
						? 'Kept as it was in the file and not editable here.'
						: undefined}
					onfocus={onbarfocus}
					oninput={onbarinput}
					onkeydown={onbarkey}
				/>
			</div>
			{#if inputError}
				<p class="inputerror" role="alert" data-testid="formula-error">{inputError}</p>
			{/if}
		{/if}
	</div>

	<div class="body">
		{#if narrow.current && phase === 'ready' && panel}
			<button
				type="button"
				class="scrim"
				aria-label="Close the panel"
				onclick={() => (panel = null)}
			></button>
		{/if}
		<main class="main">
			{#if phase === 'failed'}
				<div class="note">
					<Banner tone="danger" title="This spreadsheet could not be opened">{problem}</Banner>
				</div>
			{:else if phase === 'stopped'}
				<div class="note" data-testid="sheet-stopped">
					<Banner tone="danger" title="The spreadsheet stopped responding">
						It took too long and was stopped. Nothing half done was saved; changes since the last
						save could not be kept.
						{#snippet actions()}
							<Button size="sm" onclick={() => void load()}>Open it again</Button>
						{/snippet}
					</Banner>
				</div>
			{:else if phase === 'loading'}
				<p class="loading" aria-live="polite">Opening…</p>
			{/if}
			{#if conflict}
				<div class="note">
					<Banner
						tone="warn"
						title="Saved as a separate copy"
						dismissible
						ondismiss={() => (conflict = null)}
					>
						Someone else saved “{conflict.original.name}” while you were editing, so nothing of
						theirs was overwritten. Your changes are in “{conflict.copy.name}”, which you are
						editing now.
						<a href={resolve(`/sheet/${conflict.original.id}`)} data-sveltekit-reload
							>Open their version</a
						>
					</Banner>
				</div>
			{/if}
			{#if others.length > 0 && !othersDismissed}
				<div class="note" data-testid="editing-warning">
					<Banner
						tone="warn"
						title="{othersNames} {others.length === 1 ? 'is' : 'are'} also editing this spreadsheet"
					>
						You can carry on. If you both save, the later save becomes a separate copy, so neither
						is lost.
						{#snippet actions()}
							<Button size="sm" onclick={() => (othersDismissed = true)}>Continue</Button>
						{/snippet}
					</Banner>
				</div>
			{/if}
			{#if notice && phase === 'ready'}
				<div class="notice" role="status" data-testid="sheet-notice">
					<Icon name="info" />
					<div class="notice-text">
						<span>{notice.summary}</span>
						{#each notice.lines as line (line)}<span>{line}</span>{/each}
						{#if csvNote}<span>{csvNote}</span>{/if}
					</div>
					<button type="button" class="ghost" aria-label="Dismiss" onclick={() => (notice = null)}
						><Icon name="close" size={16} /></button
					>
				</div>
			{/if}
			{#if phase === 'ready' && meta}
				<div class="gridwrap">
					{#key meta.id}
						<SheetGrid
							bind:this={grid}
							bind:sel
							bind:draft
							file={fileId}
							{meta}
							{styles}
							{cache}
							{rev}
							load={windowOf}
							editable={editing}
							{zoom}
							hiddenRows={hidden}
							filtered={filterCols}
							{onedit}
							onclear={(a) => void apply((ed) => ed.clear(current, a))}
							{onpaste}
							{oncommand}
							onresize={(axis, from, to, px) =>
								void apply((ed) =>
									ed.resize(
										current,
										axis,
										from,
										to,
										axis === 'width'
											? Math.max(0, Math.round(((px - 5) / 7) * 100) / 100)
											: Math.round(px * 0.75 * 4) / 4
									)
								)}
							onmenu={rowsCols}
							onfilter={(col) => void openFilter(col)}
							onblocked={(v) =>
								toasts.push(
									'info',
									v.unsupported?.length
										? `This cell uses ${v.unsupported.join(', ')}, which this app does not calculate. It is kept as it was in the file and cannot be edited here.`
										: 'This cell is kept as it was in the file and cannot be edited here.'
								)}
							onmessage={(t) => toasts.push('info', t)}
						/>
					{/key}
				</div>
			{/if}
		</main>

		{#if panel && phase === 'ready'}
			<div class="sidewrap">
				<FileSide
					label="Spreadsheet details"
					bind:tab={panel}
					{details}
					format={originalExt}
					saveFormat={saveAs}
					targets={saveTargets}
					hint="Converting keeps a copy of the original in Versions. CSV and TSV save only the current sheet, so they are under Download."
					{canEdit}
					{versions}
					{versionsError}
					onconvert={(f) => void askConvert(f)}
					onrestore={(v) => void restore(v)}
					ondownload={(v) => node && void drive.download(node, v.id)}
				/>
			</div>
		{/if}
	</div>

	<footer class="foot">
		{#if phase === 'ready'}
			<SheetTabs
				{sheets}
				{current}
				editable={editing}
				canAdd={canAddSheet}
				onpick={(id) => void pick(id)}
				onadd={() => void addSheet()}
				onaction={tabAction}
			/>
		{/if}
		<span class="status">
			<span data-testid="sheet-stats">{stats}</span>
			{#if filter}<span>Filtered: {hidden.size} {hidden.size === 1 ? 'row' : 'rows'} hidden</span
				>{/if}
			<span class="zoom">
				<button
					type="button"
					class="ghost"
					aria-label="Zoom out"
					onclick={() => (zoom = Math.max(50, zoom - 10))}
					><Icon name="zoom-out" size={16} /></button
				>
				<span class="pct">{zoom}%</span>
				<button
					type="button"
					class="ghost"
					aria-label="Zoom in"
					onclick={() => (zoom = Math.min(200, zoom + 10))}
					><Icon name="zoom-in" size={16} /></button
				>
			</span>
		</span>
	</footer>
</div>

{#if printRows}
	<table class="printout" aria-hidden="true">
		<tbody>
			{#each printRows as row, i (i)}
				<tr
					>{#each row as cell, j (j)}<td>{cell}</td>{/each}</tr
				>
			{/each}
		</tbody>
	</table>
{/if}

<Dialog open={renaming !== null} title="Rename sheet" onclose={() => (renaming = null)} width={420}>
	{#if renaming}
		<form
			id="sheet-rename"
			onsubmit={(e) => {
				e.preventDefault();
				void doRename();
			}}
		>
			<Field label="Name" error={renaming.error}>
				{#snippet children(field)}
					<TextInput
						{...field}
						bind:value={renaming!.name}
						data-autofocus
						autocomplete="off"
						maxlength={31}
					/>
				{/snippet}
			</Field>
		</form>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (renaming = null)}>Cancel</Button>
		<Button variant="primary" type="submit" form="sheet-rename">Rename</Button>
	{/snippet}
</Dialog>

<Dialog
	open={deleting !== null}
	title="Delete “{deleting?.name ?? ''}”?"
	onclose={() => (deleting = null)}
	width={440}
>
	<p>
		The sheet and everything on it go. Formulas on other sheets that read it show #REF!. This cannot
		be undone here, but the version before is in Versions once saved.
	</p>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleting = null)}>Cancel</Button>
		<Button variant="primary" onclick={() => void doDelete()}>Delete sheet</Button>
	{/snippet}
</Dialog>

<Dialog open={sorting !== null} title="Sort range" onclose={() => (sorting = null)} width={440}>
	{#if sorting}
		{@const s = sorting}
		<form
			id="sheet-sort"
			class="form"
			onsubmit={(e) => {
				e.preventDefault();
				runSort();
			}}
		>
			<p class="muted">
				{colName(s.area.left)}{s.area.top + 1}:{colName(s.area.right)}{s.area.bottom + 1}
			</p>
			<label class="row">
				<span>Sort by column</span>
				<select bind:value={sorting.col}>
					{#each Array.from({ length: s.area.right - s.area.left + 1 }, (_, i) => s.area.left + i) as c (c)}
						<option value={c}>{colName(c)}</option>
					{/each}
				</select>
			</label>
			<label class="row">
				<span>Order</span>
				<select bind:value={sorting.order}>
					<option value="asc">A to Z, smallest first</option>
					<option value="desc">Z to A, largest first</option>
				</select>
			</label>
			<Checkbox bind:checked={sorting.header}>The first row is a header</Checkbox>
		</form>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (sorting = null)}>Cancel</Button>
		<Button variant="primary" type="submit" form="sheet-sort">Sort</Button>
	{/snippet}
</Dialog>

<Dialog
	open={filtering !== null}
	title="Filter column {filtering ? colName(filtering.col) : ''}"
	onclose={() => (filtering = null)}
	width={400}
>
	{#if filtering}
		{@const fl = filtering}
		<p class="muted">
			Rows below row {(filter?.header ?? 0) + 1} with an unticked value are hidden here. The file is saved
			without the filter.
		</p>
		<div class="values">
			<Checkbox
				checked={fl.hidden.size === 0}
				onchange={(e) =>
					(filtering = { ...fl, hidden: setOf(e.currentTarget.checked ? [] : fl.values) })}
				>Select all</Checkbox
			>
			{#each fl.values.slice(0, 500) as v (v)}
				<Checkbox
					checked={!fl.hidden.has(v)}
					onchange={(e) => {
						filtering = { ...fl, hidden: toggled(fl.hidden, v, !e.currentTarget.checked) };
					}}>{v === BLANK ? '(Blanks)' : v}</Checkbox
				>
			{/each}
			{#if fl.values.length > 500}<p class="muted">
					And {fl.values.length - 500} more values.
				</p>{/if}
			{#if fl.more}<p class="muted" data-testid="filter-more">
					This column has more than {DISTINCT_LIMIT.toLocaleString()} different values. Only those are
					offered; rows with any other value stay shown.
				</p>{/if}
		</div>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={clearFilter}>Remove filter</Button>
		<Button variant="primary" onclick={applyFilter}>Apply</Button>
	{/snippet}
</Dialog>

<Dialog
	open={fixedWarning !== null}
	title="Some ranges will not move"
	onclose={() => (fixedWarning = null)}
	width={480}
>
	<p>
		This file has {fixedRanges.join(', ').toLowerCase()} whose ranges stay where they are when rows or
		columns are inserted or deleted, so they may then point at the wrong cells. Formulas, merges and filters
		do follow.
	</p>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (fixedWarning = null)}>Cancel</Button>
		<Button
			variant="primary"
			onclick={() => {
				const run = fixedWarning;
				fixedWarning = null;
				warnedFixed = true;
				run?.();
			}}>Continue</Button
		>
	{/snippet}
</Dialog>

<Dialog
	open={mergeWarning !== null}
	title="Merge cells?"
	onclose={() => (mergeWarning = null)}
	width={440}
>
	<p>Merging keeps only the value of the top left cell. The others are emptied.</p>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (mergeWarning = null)}>Cancel</Button>
		<Button
			variant="primary"
			onclick={() => {
				const a = mergeWarning;
				mergeWarning = null;
				if (a) void apply((ed) => ed.merge(current, a));
			}}>Merge</Button
		>
	{/snippet}
</Dialog>

<Dialog
	open={converting !== null}
	title="Save as {converting ? SHEET_FORMAT_NAMES[converting.to] : ''}?"
	onclose={() => (converting = null)}
	width={480}
>
	<p>
		From now on this spreadsheet is saved as .{converting?.to}, and its name changes to match. The
		current version stays in Versions, so nothing is lost.
	</p>
	{#if converting && converting.lost.length > 0}
		<p class="warnline">Not carried over:</p>
		<ul class="warnline">
			{#each converting.lost as l (l)}<li>{l}</li>{/each}
		</ul>
	{/if}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (converting = null)}>Cancel</Button>
		<Button variant="primary" onclick={() => void confirmConvert()}>Convert</Button>
	{/snippet}
</Dialog>

<style>
	.screen {
		height: 100vh;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--surface-paper);
		color: var(--text-strong);
		overflow: hidden;
	}

	.top {
		flex: none;
		z-index: 10;
		background: var(--surface-page);
		border-bottom: 1px solid var(--border);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		padding: 10px 16px;
	}

	.ghost {
		min-width: 38px;
		height: 38px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
		text-decoration: none;
	}

	.ghost.sm {
		height: 32px;
		padding: 0 10px;
		font-size: 13px;
		color: var(--text-strong);
	}

	.ghost:hover {
		background: var(--surface-hover);
	}

	.star {
		min-width: 32px;
		height: 32px;
		color: var(--star-off);
	}

	.star.on {
		color: var(--star);
	}

	.badge {
		width: 36px;
		height: 36px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 10px;
		background: var(--sheets-soft);
		color: var(--sheets);
	}

	.title {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 260px;
	}

	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.name {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.fmt {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--tag-green);
		background: var(--tag-green-soft);
		border-radius: 6px;
		padding: 2px 7px;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 12px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.meta > span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		overflow: hidden;
	}

	.crumbs a {
		color: var(--text-muted);
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.crumbs a:hover {
		color: var(--accent);
	}

	.meta .bad {
		color: var(--danger-ink);
	}

	.retry {
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
		padding: 0;
	}

	.actions {
		margin-left: auto;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.viewbar {
		display: flex;
		gap: 4px;
		padding: 4px 16px 8px;
	}

	.fbar {
		display: flex;
		align-items: center;
		border-top: 1px solid var(--divider);
		background: var(--surface-paper);
	}

	.namebox {
		width: 96px;
		height: 38px;
		box-sizing: border-box;
		border: 0;
		border-right: 1px solid var(--divider);
		text-align: center;
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 500;
		background: transparent;
		color: var(--text-strong);
		outline-color: var(--sheets);
	}

	.fx {
		width: 40px;
		display: grid;
		place-items: center;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 13px;
		font-style: italic;
	}

	.formula {
		flex: 1;
		min-width: 0;
		height: 38px;
		box-sizing: border-box;
		border: 0;
		padding: 0 12px 0 0;
		font-family: var(--font-mono);
		font-size: 13px;
		background: transparent;
		color: var(--text-strong);
		outline-color: var(--sheets);
	}

	.inputerror {
		margin: 0;
		padding: 6px 16px;
		font-size: 13px;
		color: var(--danger-ink);
		background: var(--danger-soft);
	}

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: stretch;
	}

	.main {
		flex: 1 1 600px;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.note,
	.loading {
		margin: 12px 16px 0;
	}

	.loading {
		color: var(--text-muted);
	}

	.notice {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin: 12px 16px 0;
		padding: 9px 10px 9px 14px;
		border: 1px solid var(--border-strong);
		border-radius: 12px;
		background: var(--surface-page);
		color: var(--text-soft);
		font-size: 13px;
	}

	.notice > :global(svg) {
		flex: none;
		color: var(--sheets);
	}

	.notice-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.notice .ghost {
		min-width: 32px;
		height: 32px;
	}

	.gridwrap {
		flex: 1;
		min-height: 200px;
		margin-top: 12px;
		border-top: 1px solid var(--border-strong);
	}

	.sidewrap {
		display: flex;
		flex: 0 1 320px;
		min-height: 0;
		overflow-y: auto;
	}

	.sidewrap > :global(*) {
		flex: 1;
	}

	.scrim {
		display: none;
	}

	.foot {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px 18px;
		padding: 6px 12px;
		background: var(--surface-page);
		border-top: 1px solid var(--border);
		font-size: 12px;
		color: var(--text-muted);
		min-width: 0;
	}

	.status {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px 18px;
		white-space: nowrap;
		min-width: 0;
	}

	.zoom {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.zoom .ghost {
		min-width: 30px;
		height: 30px;
	}

	.pct {
		min-width: 44px;
		text-align: center;
		font-family: var(--font-mono);
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.form .row {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.form select {
		height: 40px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
	}

	.muted {
		color: var(--text-muted);
		font-size: 13px;
	}

	.values {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-height: 50vh;
		overflow-y: auto;
	}

	.warnline {
		color: var(--warn-ink);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.printout {
		display: none;
	}

	@media (max-width: 720px) {
		.head {
			flex-wrap: nowrap;
			gap: 8px;
			padding: 8px 12px;
		}

		.badge {
			display: none;
		}

		.title {
			flex: 1 1 0;
		}

		.namebox {
			width: 72px;
		}

		.star {
			min-width: 26px;
			height: 26px;
		}

		.scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 30;
			border: 0;
			padding: 0;
			background: rgb(8 8 10 / 0.4);
		}

		.sidewrap {
			position: fixed;
			top: 0;
			bottom: 0;
			right: 0;
			z-index: 31;
			width: min(320px, 86vw);
			background: var(--surface-page);
			box-shadow: var(--shadow-lg);
		}

		.foot {
			flex-wrap: wrap;
		}

		.status {
			margin-left: 0;
			flex-wrap: wrap;
		}
	}

	@media print {
		.screen {
			display: none !important;
		}

		.printout {
			display: table;
			border-collapse: collapse;
			font-family: var(--font-sans);
			font-size: 10pt;
			color: #000;
		}

		.printout td {
			border: 1px solid #bbb;
			padding: 2px 6px;
			white-space: pre-wrap;
		}
	}
</style>
