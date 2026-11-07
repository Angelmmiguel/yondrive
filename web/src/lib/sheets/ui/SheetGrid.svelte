<!--
  The grid of the Sheets board: column and row headers, frozen panes, and only
  the cells in view, drawn from blocks fetched from the worker as the view moves.
  It owns selecting (mouse, touch and keyboard), editing in place, the clipboard
  and resizing by dragging a header's edge; what an edit does is the screen's.

  The scroller is an empty area as large as the shown part of the sheet; a stage
  stuck to its top left draws four panes whose contents are moved by the scroll
  offsets, so scrolling moves a transform, and cells are made and dropped only
  when the view crosses a band of rows or columns.
-->
<script module lang="ts">
	import type { Area } from '$lib/formula/address';
	import type { Copied } from './clipboard';

	/** What was last copied or cut here, to paste formulas rather than their values. */
	let clip: Copied | null = null;

	export interface Draft {
		text: string;
		how: import('./keys').EditHow;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { colName, MAX_COLS, MAX_ROWS } from '$lib/formula/address';
	import { Icon, type MenuItem } from '$lib/components';
	import type { CellStyle } from '$lib/formats/workbook';
	import type { CellView, SheetMeta } from '../service';
	import type { WindowCache } from './cache';
	import { htmlTableRows, isOwnCopy, parseTsv, shiftFormulaText, toTsv } from './clipboard';
	import ContextMenu from './ContextMenu.svelte';
	import { Axis, colPx, colSizes, rowPx, rowSizes } from './geometry';
	import { textOf } from './history';
	import { inputOf as cellInput } from '../input';
	import { editorKey, gridKey, type EditHow } from './keys';
	import {
		areaOf,
		cellCount,
		cycle,
		inArea,
		jump,
		mergeAt,
		moved,
		overlaps,
		single,
		withMerges,
		type Pos,
		type Selection
	} from './selection';
	import { cellLook, drawnText } from './style';

	interface Props {
		/** The file's id, which the clipboard memory is kept for. */
		file: string;
		meta: SheetMeta;
		styles: readonly CellStyle[];
		cache: WindowCache;
		/** Bumped by the screen when cells went stale. */
		rev: number;
		load: (area: Area) => Promise<CellView[]>;
		editable: boolean;
		zoom: number;
		hiddenRows: ReadonlySet<number>;
		/** Columns with a filter, marked in their header. */
		filtered: ReadonlySet<number>;
		sel: Selection;
		draft: Draft | null;
		/** Puts typed text into cells; false keeps the editor open. */
		onedit: (edits: { row: number; col: number; text: string }[]) => Promise<boolean>;
		onclear: (area: Area) => void;
		onpaste: (at: Pos, rows: string[][], cut: Area | null) => void;
		oncommand: (cmd: 'undo' | 'redo' | 'bold' | 'italic' | 'strike' | 'save') => void;
		onresize: (axis: 'width' | 'height', from: number, to: number, px: number) => void;
		onmenu: (id: string) => void;
		onfilter: (col: number, at: { x: number; y: number }) => void;
		onblocked: (view: CellView) => void;
		onmessage: (text: string) => void;
	}

	let {
		file,
		meta,
		styles,
		cache,
		rev,
		load,
		editable,
		zoom,
		hiddenRows,
		filtered,
		sel = $bindable(),
		draft = $bindable(),
		onedit,
		onclear,
		onpaste,
		oncommand,
		onresize,
		onmenu,
		onfilter,
		onblocked,
		onmessage
	}: Props = $props();

	const uid = $props.id();
	const CH = 24;
	const BAND_ROWS = 8;
	const BAND_COLS = 4;
	const COPY_LIMIT = 200_000;

	let viewport = $state<HTMLElement>();
	let editor = $state<HTMLTextAreaElement>();
	let clientW = $state(800);
	let clientH = $state(600);
	let sx = $state(0);
	let sy = $state(0);
	/** Bumped when fetched cells arrive. */
	let arrived = $state(0);
	let growRows = $state(0);
	let growCols = $state(0);
	let resizing = $state<{ axis: 'width' | 'height'; index: number; px: number } | null>(null);
	let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
	let marquee = $state<Area | null>(null);
	let said = $state('');

	const z = $derived(zoom / 100);
	const area = $derived(withMerges(areaOf(sel), meta.merges));
	const fullRows = $derived(area.left === 0 && area.right >= MAX_COLS - 1);
	const fullCols = $derived(area.top === 0 && area.bottom >= MAX_ROWS - 1);

	const shownRows = $derived(
		Math.min(
			MAX_ROWS,
			Math.max(1000, meta.rows + 200, sel.active.row + 50, fullCols ? 0 : sel.focus.row + 50) +
				growRows
		)
	);
	const shownCols = $derived(
		Math.min(
			MAX_COLS,
			Math.max(26, meta.cols + 8, sel.active.col + 10, fullRows ? 0 : sel.focus.col + 10) + growCols
		)
	);
	const RH = $derived(Math.max(46, String(shownRows).length * 8 + 14));

	const rowStyles = $derived(
		new Map(meta.rowInfo.filter(([, i]) => i.style !== undefined).map(([r, i]) => [r, i.style!]))
	);
	const colStyles = $derived(meta.colInfo.filter((c) => c.style !== undefined));

	// Built from the file's sizes only; a drag lays its one size over them on each move.
	const baseRowAxis = $derived(
		new Axis(
			Math.round(rowPx(meta.defaultRowHeight) * z),
			shownRows,
			rowSizes(meta.rowInfo, z, hiddenRows)
		)
	);
	const baseColAxis = $derived(
		new Axis(
			Math.round(colPx(meta.defaultColWidth) * z),
			shownCols,
			colSizes(meta.colInfo, z, shownCols)
		)
	);
	const rowAxis = $derived(
		resizing?.axis === 'height' ? baseRowAxis.withSize(resizing.index, resizing.px) : baseRowAxis
	);
	const colAxis = $derived(
		resizing?.axis === 'width' ? baseColAxis.withSize(resizing.index, resizing.px) : baseColAxis
	);

	const fr = $derived(Math.min(meta.frozen?.rows ?? 0, shownRows));
	const fc = $derived(Math.min(meta.frozen?.cols ?? 0, shownCols));
	const frozenH = $derived(rowAxis.offsetOf(fr));
	const frozenW = $derived(colAxis.offsetOf(fc));

	const rowStart = $derived(
		Math.max(fr, Math.floor(rowAxis.indexAt(frozenH + sy) / BAND_ROWS) * BAND_ROWS - BAND_ROWS)
	);
	const rowEnd = $derived(
		Math.min(
			shownRows - 1,
			(Math.floor(rowAxis.indexAt(frozenH + sy + clientH) / BAND_ROWS) + 2) * BAND_ROWS
		)
	);
	const colStart = $derived(
		Math.max(fc, Math.floor(colAxis.indexAt(frozenW + sx) / BAND_COLS) * BAND_COLS - BAND_COLS)
	);
	const colEnd = $derived(
		Math.min(
			shownCols - 1,
			(Math.floor(colAxis.indexAt(frozenW + sx + clientW) / BAND_COLS) + 2) * BAND_COLS
		)
	);

	function span(from: number, to: number, axis: Axis): number[] {
		const out: number[] = [];
		for (let i = from; i <= to; i++) if (!axis.hidden(i)) out.push(i);
		return out;
	}

	const rowsMain = $derived(span(rowStart, rowEnd, rowAxis));
	const colsMain = $derived(span(colStart, colEnd, colAxis));
	const rowsFrozen = $derived(span(0, fr - 1, rowAxis));
	const colsFrozen = $derived(span(0, fc - 1, colAxis));

	// Fetch what the view needs, a little beyond it.
	$effect(() => {
		void rev;
		const want = [
			{ top: rowStart, left: colStart, bottom: rowEnd, right: colEnd },
			...(fr > 0 ? [{ top: 0, left: colStart, bottom: fr - 1, right: colEnd }] : []),
			...(fc > 0 ? [{ top: rowStart, left: 0, bottom: rowEnd, right: fc - 1 }] : []),
			...(fr > 0 && fc > 0 ? [{ top: 0, left: 0, bottom: fr - 1, right: fc - 1 }] : [])
		];
		const c = cache;
		for (const w of want) {
			for (const block of c.missing(w)) {
				load(block.area).then(
					(cells) => {
						if (c.fill(block, cells)) arrived++;
					},
					() => c.failed(block)
				);
			}
		}
	});

	interface Look {
		text: string;
		css: string;
		border: string;
		align: string;
		wrap: boolean;
		view?: CellView;
		/** Columns of empty neighbours the text runs over. */
		spill: number;
	}

	function emptyStyle(r: number, c: number): number {
		return rowStyles.get(r) ?? colStyles.find((x) => c >= x.min && c <= x.max)?.style ?? 0;
	}

	function lookOf(r: number, c: number, lastCol: number): Look {
		void arrived;
		void rev;
		const v = cache.get(r, c);
		const s = styles[v ? v.style : emptyStyle(r, c)];
		const look = cellLook(s, v?.value);
		let spill = 0;
		if (v && typeof v.value === 'string' && look.align === 'left' && !look.wrap && v.text !== '') {
			while (spill < 8 && c + spill + 1 <= lastCol) {
				const next = c + spill + 1;
				const nv = cache.get(r, next);
				if (!cache.loaded(r, next) || (nv && nv.text !== '') || covered(r, next)) break;
				spill++;
			}
		}
		return { text: drawnText(v?.text ?? '', look.wrap), ...look, view: v, spill };
	}

	function flagsOf(v: CellView | undefined): string {
		if (!v) return '';
		if (v.cycle) return 'This cell is part of a circular reference, so it shows #REF!.';
		if (v.readOnly)
			return v.unsupported?.length
				? `Kept as it was in the file and not editable here: ${v.unsupported.join(', ')} is not calculated by this app.`
				: 'Kept as it was in the file and not editable here.';
		if (v.stale)
			return 'Shows the value saved in the file: it depends on a formula this app does not calculate.';
		return '';
	}

	const cid = (r: number, c: number) => `${uid}-${r}-${c}`;

	/** Merges that show in a pane's rows and columns. */
	function mergesIn(rows: number[], cols: number[]): Area[] {
		if (rows.length === 0 || cols.length === 0) return [];
		const a = {
			top: rows[0],
			bottom: rows[rows.length - 1],
			left: cols[0],
			right: cols[cols.length - 1]
		};
		return viewMerges.filter((m) => overlaps(m, a));
	}

	/** The merges near the view, so that each cell drawn looks through a few rather than all. */
	const viewMerges = $derived(
		meta.merges.length === 0
			? []
			: meta.merges.filter((m) =>
					overlaps(m, {
						top: fr > 0 ? 0 : rowStart,
						bottom: rowEnd,
						left: fc > 0 ? 0 : colStart,
						right: colEnd
					})
				)
	);

	const covered = (r: number, c: number) =>
		viewMerges.length > 0 && mergeAt(viewMerges, r, c) !== undefined;

	const selectedRow = (r: number) => r >= area.top && r <= area.bottom;
	const selectedCol = (c: number) => c >= area.left && c <= area.right;

	function rect(a: Area) {
		return {
			left: colAxis.offsetOf(a.left),
			top: rowAxis.offsetOf(a.top),
			width: colAxis.offsetOf(Math.min(a.right, shownCols - 1) + 1) - colAxis.offsetOf(a.left),
			height: rowAxis.offsetOf(Math.min(a.bottom, shownRows - 1) + 1) - rowAxis.offsetOf(a.top)
		};
	}

	const activeArea = $derived(
		mergeAt(meta.merges, sel.active.row, sel.active.col) ?? {
			top: sel.active.row,
			left: sel.active.col,
			bottom: sel.active.row,
			right: sel.active.col
		}
	);

	/** Where the active cell is on the stage, for the editor. */
	const activeBox = $derived.by(() => {
		const r = rect(activeArea);
		return {
			left: RH + r.left - (activeArea.left >= fc ? sx : 0),
			top: CH + r.top - (activeArea.top >= fr ? sy : 0),
			width: r.width,
			height: r.height
		};
	});

	// --- Scrolling ---------------------------------------------------------------

	let frame = 0;
	function onscroll() {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (!viewport) return;
			sx = viewport.scrollLeft;
			sy = viewport.scrollTop;
			// Near the end of what is shown: show more.
			if (sy + 2 * clientH > CH + rowAxis.total && shownRows < MAX_ROWS) growRows += 1000;
			if (sx + 2 * clientW > RH + colAxis.total && shownCols < MAX_COLS) growCols += 26;
		});
	}

	$effect(() => {
		const v = viewport;
		if (!v) return;
		const ro = new ResizeObserver(() => {
			clientW = v.clientWidth;
			clientH = v.clientHeight;
		});
		ro.observe(v);
		return () => ro.disconnect();
	});

	/** Scrolls so that a cell is in view, unless it is in a frozen pane. */
	export function reveal(p: Pos) {
		const v = viewport;
		if (!v) return;
		const viewW = clientW - RH - frozenW;
		const viewH = clientH - CH - frozenH;
		if (p.col >= fc) {
			const x = colAxis.offsetOf(p.col) - frozenW;
			const w = colAxis.sizeOf(p.col);
			if (x < v.scrollLeft) v.scrollLeft = x;
			else if (x + w > v.scrollLeft + viewW) v.scrollLeft = x + w - viewW;
		}
		if (p.row >= fr) {
			const y = rowAxis.offsetOf(p.row) - frozenH;
			const h = rowAxis.sizeOf(p.row);
			if (y < v.scrollTop) v.scrollTop = y;
			else if (y + h > v.scrollTop + viewH) v.scrollTop = y + h - viewH;
		}
	}

	export function focus() {
		viewport?.focus({ preventScroll: true });
	}

	// --- Selection and keys ------------------------------------------------------

	const bounds = $derived({
		rows: shownRows,
		cols: shownCols,
		rowShown: (r: number) => !rowAxis.hidden(r),
		colShown: (c: number) => !colAxis.hidden(c),
		merges: meta.merges
	});

	function select(next: Selection) {
		sel = next;
		void tick().then(() => reveal(next.focus));
	}

	function moveTo(p: Pos, extend: boolean) {
		if (extend) select({ anchor: sel.anchor, focus: p, active: sel.active });
		else select(single(p));
	}

	/** Enter and Tab: through the selection when it is more than one cell, otherwise one cell on. */
	function advance(dRow: number, dCol: number) {
		const a = areaOf(sel);
		if (a.top !== a.bottom || a.left !== a.right) {
			sel = cycle(sel, dRow, dCol);
			void tick().then(() => reveal(sel.active));
		} else moveTo(moved(sel.active, dRow, dCol, bounds), false);
	}

	const filledOf = (cells: CellView[], axis: 'row' | 'col') =>
		cells
			.filter((c) => c.value !== null && c.value !== '')
			.map((c) => (axis === 'row' ? c.row : c.col))
			.sort((a, b) => a - b);

	async function jumpTo(dir: 'up' | 'down' | 'left' | 'right', extend: boolean) {
		const from = extend ? sel.focus : sel.active;
		const vertical = dir === 'up' || dir === 'down';
		const step = dir === 'down' || dir === 'right' ? 1 : -1;
		const last = vertical ? shownRows - 1 : shownCols - 1;
		const reach = vertical ? Math.max(meta.rows, from.row + 1) : Math.max(meta.cols, from.col + 1);
		const cells = vertical
			? await load({ top: 0, left: from.col, bottom: reach, right: from.col })
			: await load({ top: from.row, left: 0, bottom: from.row, right: reach });
		const at = jump(
			vertical ? from.row : from.col,
			step,
			filledOf(cells, vertical ? 'row' : 'col'),
			last
		);
		moveTo(vertical ? { row: at, col: from.col } : { row: from.row, col: at }, extend);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.target !== viewport) return;
		if (draft) {
			// Editing has begun and its box has not taken the focus yet: keys go to it.
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				draft = { ...draft, text: draft.text + e.key };
			} else oneditorkey(e);
			return;
		}
		const a = gridKey(e);
		if (!a) return;
		e.preventDefault();
		switch (a.type) {
			case 'move':
				moveTo(moved(a.extend ? sel.focus : sel.active, a.dRow, a.dCol, bounds), a.extend);
				break;
			case 'page': {
				const rows = Math.max(1, Math.floor((clientH - CH - frozenH) / rowAxis.size) - 1);
				const from = a.extend ? sel.focus : sel.active;
				moveTo(moved(from, a.dir * rows, 0, bounds), a.extend);
				break;
			}
			case 'jump':
				void jumpTo(a.dir, a.extend);
				break;
			case 'home': {
				const from = a.extend ? sel.focus : sel.active;
				moveTo(a.sheet ? { row: 0, col: 0 } : { row: from.row, col: 0 }, a.extend);
				break;
			}
			case 'end': {
				const from = a.extend ? sel.focus : sel.active;
				const col = Math.max(0, meta.cols - 1);
				moveTo(
					a.sheet ? { row: Math.max(0, meta.rows - 1), col } : { row: from.row, col },
					a.extend
				);
				break;
			}
			case 'selectAll': {
				const used = {
					anchor: { row: 0, col: 0 },
					focus: { row: Math.max(0, meta.rows - 1), col: Math.max(0, meta.cols - 1) },
					active: sel.active
				};
				const a0 = areaOf(sel);
				const already =
					a0.top === 0 &&
					a0.left === 0 &&
					a0.bottom === used.focus.row &&
					a0.right === used.focus.col;
				sel = already
					? {
							anchor: { row: 0, col: 0 },
							focus: { row: MAX_ROWS - 1, col: MAX_COLS - 1 },
							active: sel.active
						}
					: {
							...used,
							active: inArea(areaOf(used), sel.active.row, sel.active.col)
								? sel.active
								: { row: 0, col: 0 }
						};
				break;
			}
			case 'edit':
				startEdit('edit');
				break;
			case 'next':
				advance(a.dRow, a.dCol);
				break;
			case 'clear':
				if (editable) onclear(clipped(area));
				break;
			case 'escape':
				marquee = null;
				break;
			case 'type':
				startEdit('replace', a.text);
				break;
			case 'undo':
			case 'redo':
			case 'save':
				oncommand(a.type);
				break;
			case 'format':
				oncommand(a.mark);
				break;
		}
	}

	// --- Editing -----------------------------------------------------------------

	/** What the formula bar and F2 show for a cell: what would be typed to get it. */
	export function inputOf(v: CellView | null | undefined): string {
		return v ? cellInput(v, styles[v.style]?.numFmt) : '';
	}

	export async function startEdit(how: EditHow, typed?: string) {
		if (!editable) {
			onmessage('This file is open for viewing.');
			return;
		}
		const p = sel.active;
		let v = cache.get(p.row, p.col);
		if (!cache.loaded(p.row, p.col)) {
			const got = await load({ top: p.row, left: p.col, bottom: p.row, right: p.col });
			v = got[0];
		}
		if (v?.readOnly) {
			onblocked(v);
			return;
		}
		reveal(p);
		draft = { text: typed ?? inputOf(v), how };
		await tick();
		editor?.focus({ preventScroll: true });
		const end = draft?.text.length ?? 0;
		editor?.setSelectionRange(end, end);
	}

	/** Finishes editing: the text goes into the cell, then the selection moves. False if it was refused. */
	export async function commit(dRow = 0, dCol = 0, fill = false): Promise<boolean> {
		const d = draft;
		if (!d) return true;
		const a = areaOf(sel);
		const targets: Pos[] = [];
		if (fill && cellCount(a) <= 10_000) {
			for (let r = a.top; r <= a.bottom; r++)
				for (let c = a.left; c <= a.right; c++)
					if (!covered(r, c) || mergeAt(meta.merges, r, c)?.top === r)
						targets.push({ row: r, col: c });
		} else targets.push(sel.active);
		// An edit left as it was, such as the formula bar focused and left, changes nothing.
		const same =
			d.how === 'edit' &&
			targets.length === 1 &&
			d.text === inputOf(cache.get(sel.active.row, sel.active.col));
		const ok = same || (await onedit(targets.map((p) => ({ ...p, text: d.text }))));
		if (!ok) {
			editor?.focus({ preventScroll: true });
			return false;
		}
		draft = null;
		if (dRow !== 0 || dCol !== 0) advance(dRow, dCol);
		focus();
		return true;
	}

	export function cancel() {
		draft = null;
		focus();
	}

	function oneditorkey(e: KeyboardEvent) {
		if (!draft) return;
		const a = editorKey(e, draft.how);
		if (!a) return;
		e.preventDefault();
		e.stopPropagation();
		if (a.type === 'cancel') cancel();
		else if (a.type === 'newline') {
			const t = e.currentTarget;
			if (t instanceof HTMLTextAreaElement) {
				t.setRangeText('\n', t.selectionStart, t.selectionEnd, 'end');
				draft = { ...draft, text: t.value };
			} else draft = { ...draft, text: `${draft.text}\n` };
		} else if (a.type === 'fill') void commit(0, 0, true);
		else void commit(a.dRow, a.dCol);
	}

	// --- Pointer -----------------------------------------------------------------

	type Hit = { row: number; col: number; edge: null | { axis: 'width' | 'height'; index: number } };

	function hit(e: { clientX: number; clientY: number }): Hit | null {
		const v = viewport;
		if (!v) return null;
		const box = v.getBoundingClientRect();
		const x = e.clientX - box.left;
		const y = e.clientY - box.top;
		const cx = x - RH;
		const cy = y - CH;
		const col = cx < 0 ? -1 : colAxis.indexAt(cx < frozenW ? cx : cx + sx);
		const row = cy < 0 ? -1 : rowAxis.indexAt(cy < frozenH ? cy : cy + sy);
		let edge: Hit['edge'] = null;
		if (cy < 0 && col >= 0) {
			const right = RH + colAxis.offsetOf(col + 1) - (col >= fc ? sx : 0);
			const left = RH + colAxis.offsetOf(col) - (col >= fc ? sx : 0);
			if (Math.abs(x - right) <= 4) edge = { axis: 'width', index: col };
			else if (Math.abs(x - left) <= 4 && col > 0)
				edge = { axis: 'width', index: colAxis.nextShown(col, -1) };
		} else if (cx < 0 && row >= 0) {
			const bottom = CH + rowAxis.offsetOf(row + 1) - (row >= fr ? sy : 0);
			const top = CH + rowAxis.offsetOf(row) - (row >= fr ? sy : 0);
			if (Math.abs(y - bottom) <= 3) edge = { axis: 'height', index: row };
			else if (Math.abs(y - top) <= 3 && row > 0)
				edge = { axis: 'height', index: rowAxis.nextShown(row, -1) };
		}
		return { row, col, edge };
	}

	let drag: { kind: 'cells' | 'rows' | 'cols'; pointer: number } | null = null;
	let sizing: { axis: 'width' | 'height'; index: number; start: number; from: number } | null =
		null;
	let touch: { x: number; y: number; at: number; hit: Hit } | null = null;
	let lastTap = { at: 0, row: -1, col: -1 };

	function cellOf(h: Hit): Pos {
		return { row: Math.max(0, h.row), col: Math.max(0, h.col) };
	}

	async function pointTo(h: Hit, extend: boolean) {
		if (draft) {
			if (!(await commit())) return;
		}
		if (h.row < 0 && h.col < 0) {
			select({
				anchor: { row: 0, col: 0 },
				focus: { row: MAX_ROWS - 1, col: MAX_COLS - 1 },
				active: sel.active
			});
			return;
		}
		if (h.row < 0) {
			sel = {
				anchor: { row: 0, col: extend ? sel.anchor.col : h.col },
				focus: { row: MAX_ROWS - 1, col: h.col },
				active: extend ? sel.active : { row: 0, col: h.col }
			};
			return;
		}
		if (h.col < 0) {
			sel = {
				anchor: { row: extend ? sel.anchor.row : h.row, col: 0 },
				focus: { row: h.row, col: MAX_COLS - 1 },
				active: extend ? sel.active : { row: h.row, col: 0 }
			};
			return;
		}
		const p = cellOf(h);
		const m = mergeAt(meta.merges, p.row, p.col);
		const at = m ? { row: m.top, col: m.left } : p;
		if (extend) sel = { anchor: sel.anchor, focus: p, active: sel.active };
		else sel = single(at);
	}

	function onpointerdown(e: PointerEvent) {
		if (e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).closest('.hbtn'))
			return;
		const h = hit(e);
		if (!h) return;
		if (e.pointerType === 'touch') {
			touch = { x: e.clientX, y: e.clientY, at: Date.now(), hit: h };
			return;
		}
		if (e.button !== 0) {
			if (e.button === 2 && h.row >= 0 && h.col >= 0 && !inArea(area, h.row, h.col))
				void pointTo(h, false);
			return;
		}
		e.preventDefault();
		focus();
		if (h.edge && editable) {
			sizing = {
				axis: h.edge.axis,
				index: h.edge.index,
				start: h.edge.axis === 'width' ? e.clientX : e.clientY,
				from: h.edge.axis === 'width' ? colAxis.sizeOf(h.edge.index) : rowAxis.sizeOf(h.edge.index)
			};
			resizing = { axis: sizing.axis, index: sizing.index, px: sizing.from };
			viewport?.setPointerCapture(e.pointerId);
			return;
		}
		void pointTo(h, e.shiftKey);
		drag = { kind: h.row < 0 ? 'cols' : h.col < 0 ? 'rows' : 'cells', pointer: e.pointerId };
		viewport?.setPointerCapture(e.pointerId);
	}

	function onpointermove(e: PointerEvent) {
		if (sizing && resizing) {
			const d = (sizing.axis === 'width' ? e.clientX : e.clientY) - sizing.start;
			resizing = {
				...resizing,
				px: Math.max(sizing.axis === 'width' ? 8 : 6, Math.round(sizing.from + d))
			};
			return;
		}
		if (!drag || drag.pointer !== e.pointerId) {
			const h = e.pointerType === 'mouse' ? hit(e) : null;
			if (viewport)
				viewport.style.cursor =
					h?.edge && editable ? (h.edge.axis === 'width' ? 'col-resize' : 'row-resize') : '';
			return;
		}
		const v = viewport;
		if (!v) return;
		const box = v.getBoundingClientRect();
		// Past an edge: scroll that way.
		if (e.clientY > box.bottom - 8) v.scrollTop += 24;
		else if (e.clientY < box.top + CH + frozenH && sy > 0 && drag.kind !== 'cols')
			v.scrollTop -= 24;
		if (e.clientX > box.right - 8) v.scrollLeft += 32;
		else if (e.clientX < box.left + RH + frozenW && sx > 0 && drag.kind !== 'rows')
			v.scrollLeft -= 32;
		const h = hit({
			clientX: Math.min(Math.max(e.clientX, box.left + RH + 1), box.right - 2),
			clientY: Math.min(Math.max(e.clientY, box.top + CH + 1), box.bottom - 2)
		});
		if (!h) return;
		if (drag.kind === 'cols') sel = { ...sel, focus: { row: MAX_ROWS - 1, col: h.col } };
		else if (drag.kind === 'rows') sel = { ...sel, focus: { row: h.row, col: MAX_COLS - 1 } };
		else sel = { ...sel, focus: cellOf(h) };
	}

	function onpointerup(e: PointerEvent) {
		if (sizing && resizing) {
			const { axis, index, px } = resizing;
			const moved = px !== sizing.from;
			sizing = null;
			// The new size stays drawn until the sheet's layout is read again.
			if (moved) {
				const whole =
					axis === 'width' ? fullCols && selectedCol(index) : fullRows && selectedRow(index);
				const from = whole ? (axis === 'width' ? area.left : area.top) : index;
				const to = whole ? (axis === 'width' ? area.right : area.bottom) : index;
				onresize(
					axis,
					from,
					Math.min(to, axis === 'width' ? shownCols - 1 : shownRows - 1),
					px / z
				);
			} else resizing = null;
			return;
		}
		if (drag && drag.pointer === e.pointerId) {
			drag = null;
			return;
		}
		if (touch && e.pointerType === 'touch') {
			const t = touch;
			touch = null;
			if (Math.abs(e.clientX - t.x) > 10 || Math.abs(e.clientY - t.y) > 10) return;
			const now = Date.now();
			const p = cellOf(t.hit);
			const again = now - lastTap.at < 400 && lastTap.row === p.row && lastTap.col === p.col;
			lastTap = { at: now, row: p.row, col: p.col };
			void pointTo(t.hit, false).then(() => {
				if (again && !draft && t.hit.row >= 0 && t.hit.col >= 0) void startEdit('edit');
			});
		}
	}

	/** Drawn sizes are dropped once the layout read back carries the new one. */
	$effect(() => {
		void meta;
		if (!sizing) resizing = null;
	});

	function ondblclick(e: MouseEvent) {
		if (draft || e.target instanceof HTMLTextAreaElement) return;
		const h = hit(e);
		if (!h || h.row < 0 || h.col < 0 || h.edge) return;
		void startEdit('edit');
	}

	function oncontextmenu(e: MouseEvent) {
		const h = hit(e);
		if (!h) return;
		e.preventDefault();
		const rows = h.col < 0 || fullRows;
		const cols = h.row < 0 || fullCols;
		const nRows = area.bottom - area.top + 1;
		const nCols = area.right - area.left + 1;
		const items: MenuItem[] = [
			{ id: 'cut', label: 'Cut', icon: 'close', disabled: !editable },
			{ id: 'copy', label: 'Copy', icon: 'copy' },
			{ id: 'paste', label: 'Paste', icon: 'download', disabled: !editable }
		];
		if (editable) {
			if (!cols)
				items.push(
					{ id: 'row-above', label: 'Insert row above', icon: 'plus' },
					{ id: 'row-below', label: 'Insert row below', icon: 'plus' },
					{
						id: 'row-delete',
						label: nRows > 1 && rows ? `Delete ${nRows} rows` : 'Delete row',
						icon: 'trash'
					}
				);
			if (!rows)
				items.push(
					{ id: 'col-left', label: 'Insert column left', icon: 'plus' },
					{ id: 'col-right', label: 'Insert column right', icon: 'plus' },
					{
						id: 'col-delete',
						label: nCols > 1 && cols ? `Delete ${nCols} columns` : 'Delete column',
						icon: 'trash'
					}
				);
			items.push({ id: 'clear', label: 'Clear contents', icon: 'close' });
		}
		menu = { x: e.clientX, y: e.clientY, items };
	}

	function chooseMenu(id: string) {
		if (id === 'copy' || id === 'cut') {
			copyOut(id === 'cut');
		} else if (id === 'paste') {
			void pasteFromMenu();
		} else if (id === 'clear') onclear(clipped(area));
		else onmenu(id);
	}

	// --- Clipboard ---------------------------------------------------------------

	/** The selection cut to what has content, for copying and clearing whole rows or columns. */
	function clipped(a: Area): Area {
		return {
			top: a.top,
			left: a.left,
			bottom: Math.max(a.top, Math.min(a.bottom, meta.rows - 1)),
			right: Math.max(a.left, Math.min(a.right, meta.cols - 1))
		};
	}

	function grids(a: Area, get: (r: number, c: number) => CellView | undefined) {
		const shown: string[][] = [];
		const raw: string[][] = [];
		for (let r = a.top; r <= a.bottom; r++) {
			if (rowAxis.hidden(r)) continue;
			const s: string[] = [];
			const w: string[] = [];
			for (let c = a.left; c <= a.right; c++) {
				const v = get(r, c);
				s.push(v?.text ?? '');
				// A formula not calculated here could not be pasted: its value goes instead.
				w.push(v?.readOnly ? v.text : textOf(v));
			}
			shown.push(s);
			raw.push(w);
		}
		return { shown, raw };
	}

	function remember(a: Area, cut: boolean, g: { shown: string[][]; raw: string[][] }) {
		const tsv = toTsv(g.shown);
		clip = {
			tsv,
			raw: g.raw,
			origin: { row: a.top, col: a.left },
			area: a,
			file,
			sheet: meta.id,
			cut
		};
		marquee = a;
		return tsv;
	}

	function allLoaded(a: Area): boolean {
		for (let r = a.top; r <= a.bottom; r += 32)
			for (let c = a.left; c <= a.right; c += 8) if (!cache.loaded(r, c)) return false;
		return cache.loaded(a.bottom, a.right);
	}

	/** Copies the selection: at once when its cells are here, else after fetching them. */
	function copyOut(cut: boolean, e?: ClipboardEvent) {
		const a = clipped(area);
		if (cellCount(a) > COPY_LIMIT) {
			onmessage('That is too much to copy at once. Select fewer cells.');
			e?.preventDefault();
			return;
		}
		if (e?.clipboardData && allLoaded(a)) {
			const tsv = remember(
				a,
				cut,
				grids(a, (r, c) => cache.get(r, c))
			);
			e.clipboardData.setData('text/plain', tsv);
			e.preventDefault();
			return;
		}
		e?.preventDefault();
		void load(a).then((cells) => {
			const at = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]));
			const tsv = remember(
				a,
				cut,
				grids(a, (r, c) => at.get(`${r}:${c}`))
			);
			navigator.clipboard?.writeText(tsv).catch(() => {
				onmessage(
					'Copied for pasting here. Other apps did not get it: the browser refused the clipboard.'
				);
			});
		});
	}

	function oncopy(e: ClipboardEvent) {
		if (e.target !== viewport) return;
		copyOut(false, e);
	}

	function oncut(e: ClipboardEvent) {
		if (e.target !== viewport) return;
		if (!editable) return;
		copyOut(true, e);
	}

	function pasteRows(text: string, html: string) {
		const at = sel.active;
		if (isOwnCopy(clip, { file, sheet: meta.id }, text, html)) {
			const c = clip;
			const dr = at.row - c.origin.row;
			const dc = at.col - c.origin.col;
			const rows = c.cut ? c.raw : c.raw.map((r) => r.map((t) => shiftFormulaText(t, dr, dc)));
			if (c.cut) {
				clip = null;
				marquee = null;
			}
			onpaste(at, rows, c.cut ? c.area : null);
			return;
		}
		const rows = (html && htmlTableRows(html)) || parseTsv(text);
		if (rows.length === 0) return;
		onpaste(at, rows, null);
	}

	function onpasteevent(e: ClipboardEvent) {
		if (e.target !== viewport) return;
		e.preventDefault();
		if (!editable) return;
		pasteRows(
			e.clipboardData?.getData('text/plain') ?? '',
			e.clipboardData?.getData('text/html') ?? ''
		);
	}

	async function pasteFromMenu() {
		let text = '';
		try {
			text = (await navigator.clipboard?.readText()) ?? '';
		} catch {
			if (!clip) {
				onmessage('The browser did not allow reading the clipboard. Use Ctrl+V to paste.');
				return;
			}
		}
		pasteRows(text, '');
	}

	// --- Announcements -----------------------------------------------------------

	$effect(() => {
		void arrived;
		const p = sel.active;
		const v = cache.get(p.row, p.col);
		const name = `${colName(p.col)}${p.row + 1}`;
		const a = areaOf(sel);
		const many =
			cellCount(a) > 1 ? `, ${a.bottom - a.top + 1} by ${a.right - a.left + 1} selected` : '';
		const what = v?.text ? `${v.text}${v.formula ? `, formula ${v.formula}` : ''}` : 'empty';
		const flag = flagsOf(v);
		said = `${name}, ${what}${flag ? `. ${flag}` : ''}${many}`;
	});

	const activeId = $derived(cid(activeArea.top, activeArea.left));
</script>

{#snippet cells(rows: number[], cols: number[])}
	{@const lastCol = cols[cols.length - 1] ?? 0}
	{#each rows as r (r)}
		<div
			class="row"
			role="row"
			aria-rowindex={r + 1}
			style:top="{rowAxis.offsetOf(r)}px"
			style:height="{rowAxis.sizeOf(r)}px"
		>
			{#each cols as c (c)}
				{#if !covered(r, c)}
					{@const d = lookOf(r, c, lastCol)}
					{@const flag = flagsOf(d.view)}
					<div
						id={cid(r, c)}
						role="gridcell"
						aria-colindex={c + 1}
						aria-selected={inArea(area, r, c)}
						aria-readonly={d.view?.readOnly ? true : undefined}
						class="cell {d.align}"
						class:wrap={d.wrap}
						class:spill={d.spill > 0}
						class:ro={d.view?.readOnly}
						class:stale={d.view?.stale}
						class:cycle={d.view?.cycle}
						style="left:{colAxis.offsetOf(c)}px;width:{colAxis.offsetOf(c + 1 + d.spill) -
							colAxis.offsetOf(c)}px;{d.css}"
						title={flag || undefined}
					>
						{#if d.border}<span class="bd" style={d.border}></span>{/if}
						<span class="txt">{d.text}</span>
					</div>
				{/if}
			{/each}
		</div>
	{/each}
{/snippet}

{#snippet merged(list: Area[])}
	{#each list as m (`${m.top}:${m.left}`)}
		{@const d = lookOf(m.top, m.left, m.left)}
		{@const box = rect(m)}
		{@const flag = flagsOf(d.view)}
		<div
			id={cid(m.top, m.left)}
			role="gridcell"
			aria-rowindex={m.top + 1}
			aria-colindex={m.left + 1}
			aria-rowspan={m.bottom - m.top + 1}
			aria-colspan={m.right - m.left + 1}
			aria-selected={inArea(area, m.top, m.left)}
			class="cell merge {d.align}"
			class:wrap={d.wrap}
			class:ro={d.view?.readOnly}
			class:stale={d.view?.stale}
			style="left:{box.left}px;top:{box.top}px;width:{box.width}px;height:{box.height}px;{d.css}"
			title={flag || undefined}
		>
			{#if d.border}<span class="bd" style={d.border}></span>{/if}
			<span class="txt">{d.text}</span>
		</div>
	{/each}
{/snippet}

{#snippet overlay()}
	{@const s = rect({
		...area,
		bottom: Math.min(area.bottom, shownRows - 1),
		right: Math.min(area.right, shownCols - 1)
	})}
	{@const a = rect(activeArea)}
	<div
		class="sel"
		style="left:{s.left}px;top:{s.top}px;width:{s.width}px;height:{s.height}px"
	></div>
	<div
		class="active"
		style="left:{a.left}px;top:{a.top}px;width:{a.width}px;height:{a.height}px"
	></div>
	{#if marquee}
		{@const q = rect(marquee)}
		<div
			class="marquee"
			style="left:{q.left}px;top:{q.top}px;width:{q.width}px;height:{q.height}px"
		></div>
	{/if}
{/snippet}

{#snippet colHeads(cols: number[])}
	{#each cols as c (c)}
		<span
			class="hd col"
			class:on={selectedCol(c)}
			class:all={fullCols && selectedCol(c)}
			style:left="{colAxis.offsetOf(c)}px"
			style:width="{colAxis.sizeOf(c)}px"
		>
			{colName(c)}
			{#if filtered.has(c)}
				<button
					type="button"
					class="hbtn"
					aria-label="Filter on column {colName(c)}"
					onclick={(e) => {
						const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
						onfilter(c, { x: b.left, y: b.bottom + 4 });
					}}><Icon name="filter" size={12} /></button
				>
			{/if}
		</span>
	{/each}
{/snippet}

{#snippet rowHeads(rows: number[])}
	{#each rows as r (r)}
		<span
			class="hd rowh"
			class:on={selectedRow(r)}
			class:all={fullRows && selectedRow(r)}
			style:top="{rowAxis.offsetOf(r)}px"
			style:height="{rowAxis.sizeOf(r)}px">{r + 1}</span
		>
	{/each}
{/snippet}

<div
	bind:this={viewport}
	class="viewport"
	role="grid"
	tabindex="0"
	aria-label="{meta.name}: cells"
	aria-rowcount={shownRows}
	aria-colcount={shownCols}
	aria-multiselectable="true"
	aria-readonly={!editable}
	aria-activedescendant={draft ? undefined : activeId}
	aria-describedby="{uid}-said"
	style:--z={z}
	{onscroll}
	{onkeydown}
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	onpointercancel={() => ((drag = null), (touch = null))}
	{ondblclick}
	{oncontextmenu}
	{oncopy}
	{oncut}
	onpaste={onpasteevent}
>
	<div
		class="sizer"
		style:width="{RH + colAxis.total}px"
		style:height="{CH + rowAxis.total}px"
	></div>
	<div class="stage" style:width="{clientW}px" style:height="{clientH}px">
		<!-- Panes: frozen corner, frozen rows, frozen columns, and the rest. -->
		<div class="pane" style="left:{RH + frozenW}px;top:{CH + frozenH}px;right:0;bottom:0">
			<div class="inner" style:transform="translate({-(frozenW + sx)}px, {-(frozenH + sy)}px)">
				{@render cells(rowsMain, colsMain)}
				{@render merged(mergesIn(rowsMain, colsMain))}
				{@render overlay()}
			</div>
		</div>
		{#if fr > 0}
			<div class="pane" style="left:{RH + frozenW}px;top:{CH}px;right:0;height:{frozenH}px">
				<div class="inner" style:transform="translate({-(frozenW + sx)}px, 0)">
					{@render cells(rowsFrozen, colsMain)}
					{@render merged(mergesIn(rowsFrozen, colsMain))}
					{@render overlay()}
				</div>
			</div>
		{/if}
		{#if fc > 0}
			<div class="pane" style="left:{RH}px;top:{CH + frozenH}px;width:{frozenW}px;bottom:0">
				<div class="inner" style:transform="translate(0, {-(frozenH + sy)}px)">
					{@render cells(rowsMain, colsFrozen)}
					{@render merged(mergesIn(rowsMain, colsFrozen))}
					{@render overlay()}
				</div>
			</div>
		{/if}
		{#if fr > 0 && fc > 0}
			<div class="pane" style="left:{RH}px;top:{CH}px;width:{frozenW}px;height:{frozenH}px">
				<div class="inner">
					{@render cells(rowsFrozen, colsFrozen)}
					{@render merged(mergesIn(rowsFrozen, colsFrozen))}
					{@render overlay()}
				</div>
			</div>
		{/if}

		<!-- Headers. -->
		<div class="heads cols" aria-hidden="true" style="left:{RH + frozenW}px;height:{CH}px">
			<div class="inner" style:transform="translate({-(frozenW + sx)}px, 0)">
				{@render colHeads(colsMain)}
			</div>
		</div>
		{#if fc > 0}
			<div
				class="heads cols"
				aria-hidden="true"
				style="left:{RH}px;width:{frozenW}px;height:{CH}px"
			>
				<div class="inner">{@render colHeads(colsFrozen)}</div>
			</div>
		{/if}
		<div class="heads rows" aria-hidden="true" style="top:{CH + frozenH}px;width:{RH}px">
			<div class="inner" style:transform="translate(0, {-(frozenH + sy)}px)">
				{@render rowHeads(rowsMain)}
			</div>
		</div>
		{#if fr > 0}
			<div class="heads rows" aria-hidden="true" style="top:{CH}px;width:{RH}px;height:{frozenH}px">
				<div class="inner">{@render rowHeads(rowsFrozen)}</div>
			</div>
		{/if}
		<div class="corner" aria-hidden="true" style:width="{RH}px" style:height="{CH}px"></div>
		{#if fr > 0}
			<div class="freeze h" style:top="{CH + frozenH - 1}px"></div>
		{/if}
		{#if fc > 0}
			<div class="freeze v" style:left="{RH + frozenW - 1}px"></div>
		{/if}

		{#if draft}
			<textarea
				bind:this={editor}
				bind:value={draft.text}
				class="editor"
				aria-label="Edit cell {colName(sel.active.col)}{sel.active.row + 1}"
				spellcheck="false"
				autocomplete="off"
				style="left:{activeBox.left}px;top:{activeBox.top}px;min-width:{activeBox.width}px;min-height:{activeBox.height}px"
				onkeydown={oneditorkey}></textarea>
		{/if}
	</div>
</div>
<p id="{uid}-said" class="sr" aria-live="polite">{said}</p>

{#if menu}
	<ContextMenu
		label="Cell actions"
		items={menu.items}
		at={menu}
		onselect={chooseMenu}
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	.viewport {
		position: relative;
		overflow: auto;
		width: 100%;
		height: 100%;
		outline: none;
		background: var(--surface-paper);
		overscroll-behavior: contain;
		font-size: calc(13px * var(--z));
		font-variant-numeric: tabular-nums;
		color: var(--text-strong);
	}

	.viewport:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.sizer {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}

	.stage {
		position: sticky;
		top: 0;
		left: 0;
		overflow: hidden;
		user-select: none;
		-webkit-user-select: none;
	}

	.pane,
	.heads {
		position: absolute;
		overflow: hidden;
	}

	.heads.cols {
		top: 0;
		right: 0;
		background: var(--surface-sunken);
		border-bottom: 1px solid var(--border-strong);
		box-sizing: border-box;
	}

	.heads.rows {
		left: 0;
		bottom: 0;
		background: var(--surface-sunken);
		border-right: 1px solid var(--border-strong);
		box-sizing: border-box;
	}

	.corner {
		position: absolute;
		left: 0;
		top: 0;
		background: var(--surface-sunken);
		border-right: 1px solid var(--border-strong);
		border-bottom: 1px solid var(--border-strong);
		box-sizing: border-box;
	}

	.inner {
		position: absolute;
		left: 0;
		top: 0;
		will-change: transform;
	}

	/* The row numbers span the header's width; the strip has no width of its own. */
	.heads.rows .inner {
		right: 0;
	}

	.row {
		position: absolute;
		left: 0;
	}

	.hd {
		position: absolute;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		white-space: nowrap;
	}

	.hd.col {
		top: 0;
		height: 24px;
		border-right: 1px solid var(--border-strong);
	}

	.hd.rowh {
		left: 0;
		right: 0;
		border-bottom: 1px solid var(--divider);
	}

	.hd.on {
		background: var(--tag-green-soft);
		color: var(--tag-green);
		font-weight: 600;
	}

	.hd.all {
		background: var(--sheets);
		color: var(--surface-paper);
	}

	.hbtn {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: var(--surface);
		color: var(--sheets);
		cursor: pointer;
		pointer-events: auto;
	}

	.cell {
		position: absolute;
		top: 0;
		height: 100%;
		box-sizing: border-box;
		display: flex;
		align-items: flex-end;
		padding: 0 calc(4px * var(--z)) calc(2px * var(--z));
		border-right: 1px solid var(--divider);
		border-bottom: 1px solid var(--divider);
		overflow: hidden;
		white-space: pre;
		line-height: 1.25;
		cursor: cell;
	}

	.cell.spill,
	.cell.merge {
		z-index: 1;
		background: var(--surface-paper);
	}

	.cell.right {
		justify-content: flex-end;
	}

	.cell.center {
		justify-content: center;
	}

	.cell.wrap {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.txt {
		min-width: 0;
		overflow: hidden;
	}

	.cell:not(.wrap) .txt {
		text-overflow: clip;
	}

	.bd {
		position: absolute;
		inset: -1px 0 0 -1px;
		pointer-events: none;
	}

	/* Not editable here: a dashed corner and muted text, with the reason in the tooltip. */
	.cell.ro {
		color: var(--text-soft);
		background-image: linear-gradient(135deg, var(--warn-line) 0 5px, transparent 5px);
	}

	.cell.stale {
		background-image: linear-gradient(135deg, var(--info) 0 5px, transparent 5px);
		font-style: italic;
	}

	.cell.cycle {
		color: var(--danger-ink);
		background-image: linear-gradient(135deg, var(--danger) 0 5px, transparent 5px);
	}

	.sel {
		position: absolute;
		z-index: 2;
		background: color-mix(in srgb, var(--sheets) 10%, transparent);
		border: 1px solid var(--sheets);
		box-sizing: border-box;
		pointer-events: none;
	}

	.active {
		position: absolute;
		z-index: 3;
		box-sizing: border-box;
		border: 2px solid var(--sheets);
		pointer-events: none;
	}

	.marquee {
		position: absolute;
		z-index: 3;
		box-sizing: border-box;
		border: 2px dashed var(--sheets);
		pointer-events: none;
	}

	.freeze {
		position: absolute;
		z-index: 4;
		background: var(--border-strong);
		pointer-events: none;
	}

	.freeze.h {
		left: 0;
		right: 0;
		height: 2px;
	}

	.freeze.v {
		top: 0;
		bottom: 0;
		width: 2px;
	}

	.editor {
		position: absolute;
		z-index: 10;
		box-sizing: border-box;
		max-width: 60vw;
		max-height: 50vh;
		margin: 0;
		padding: calc(2px * var(--z)) calc(4px * var(--z));
		border: 2px solid var(--sheets);
		border-radius: 0;
		background: var(--surface-paper);
		color: var(--text-strong);
		font: inherit;
		font-size: calc(13px * var(--z));
		line-height: 1.25;
		resize: none;
		outline: none;
		box-shadow: var(--shadow-lg);
		field-sizing: content;
		white-space: pre;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		margin: 0;
	}
</style>
