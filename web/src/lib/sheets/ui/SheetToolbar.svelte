<!--
  The formatting toolbar of the Sheets board: undo and redo, number format and
  font size, currency and percent, bold, italic, strike, text and fill colour,
  borders, merge, alignment, wrap, sort, filter and functions. It shows the
  active cell's style and says what was asked; the screen does it.
-->
<script lang="ts">
	import { Icon, Menu, type IconName, type MenuItem } from '$lib/components';
	import type { CellStyle, HAlign } from '$lib/formats/workbook';
	import { FUNCTIONS } from '$lib/formula/functions';

	export type BorderKind = 'all' | 'outer' | 'top' | 'bottom' | 'left' | 'right' | 'none';

	interface Props {
		style: CellStyle;
		/** The selection is a merged cell. */
		merged: boolean;
		filterOn: boolean;
		panel: boolean;
		canUndo: boolean;
		canRedo: boolean;
		onundo: () => void;
		onredo: () => void;
		onnumfmt: (code: string) => void;
		onfontsize: (pt: number) => void;
		onmark: (mark: 'bold' | 'italic' | 'strike') => void;
		oncolor: (which: 'text' | 'fill', color: string | null) => void;
		onborder: (kind: BorderKind) => void;
		onmerge: () => void;
		onalign: (h: HAlign) => void;
		onwrap: () => void;
		onsort: () => void;
		onfilter: () => void;
		onfunction: (name: string) => void;
		ontogglepanel: () => void;
	}

	let {
		style,
		merged,
		filterOn,
		panel,
		canUndo,
		canRedo,
		onundo,
		onredo,
		onnumfmt,
		onfontsize,
		onmark,
		oncolor,
		onborder,
		onmerge,
		onalign,
		onwrap,
		onsort,
		onfilter,
		onfunction,
		ontogglepanel
	}: Props = $props();

	const NUMBER_FORMATS = [
		{ code: 'General', label: 'Automatic' },
		{ code: '#,##0.00', label: 'Number' },
		{ code: '"$"#,##0.00', label: 'Currency' },
		{ code: '0.00%', label: 'Percent' },
		{ code: 'm/d/yyyy', label: 'Date' },
		{ code: 'h:mm:ss', label: 'Time' },
		{ code: '@', label: 'Text' }
	];
	const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
	const TEXT_COLORS: MenuItem[] = [
		{ id: '', label: 'Automatic' },
		{ id: '#c00000', label: 'Red' },
		{ id: '#2e4fe0', label: 'Blue' },
		{ id: '#17643a', label: 'Green' },
		{ id: '#c55a11', label: 'Orange' },
		{ id: '#7030a0', label: 'Purple' },
		{ id: '#626268', label: 'Grey' }
	];
	const FILLS: MenuItem[] = [
		{ id: '', label: 'No fill' },
		{ id: '#fff2cc', label: 'Yellow' },
		{ id: '#e2efda', label: 'Green' },
		{ id: '#ddebf7', label: 'Blue' },
		{ id: '#fce4d6', label: 'Orange' },
		{ id: '#ededed', label: 'Grey' },
		{ id: '#ffc7ce', label: 'Red' }
	];
	const BORDERS: MenuItem[] = [
		{ id: 'all', label: 'All borders', icon: 'borders' },
		{ id: 'outer', label: 'Outside borders' },
		{ id: 'top', label: 'Top border' },
		{ id: 'bottom', label: 'Bottom border' },
		{ id: 'left', label: 'Left border' },
		{ id: 'right', label: 'Right border' },
		{ id: 'none', label: 'No borders', icon: 'close' }
	];
	const FUNCTION_ITEMS: MenuItem[] = Object.keys(FUNCTIONS)
		.sort()
		.map((n) => ({ id: n, label: n }));

	const fmt = $derived(NUMBER_FORMATS.find((f) => f.code === style.numFmt)?.code ?? 'custom');
	const size = $derived(style.font.size ?? 11);
	const h = $derived(style.align.h ?? 'general');

	const marks: { id: 'bold' | 'italic' | 'strike'; label: string; icon: IconName }[] = [
		{ id: 'bold', label: 'Bold', icon: 'bold' },
		{ id: 'italic', label: 'Italic', icon: 'italic' },
		{ id: 'strike', label: 'Strikethrough', icon: 'strike' }
	];
	const aligns: { id: HAlign; label: string; icon: IconName }[] = [
		{ id: 'left', label: 'Align left', icon: 'align-left' },
		{ id: 'center', label: 'Align center', icon: 'align-center' },
		{ id: 'right', label: 'Align right', icon: 'align-right' }
	];
	const uid = $props.id();
</script>

<div class="toolbar" role="toolbar" aria-label="Formatting">
	<button
		type="button"
		class="tb"
		aria-label="Undo"
		title="Undo (Ctrl+Z)"
		disabled={!canUndo}
		onclick={onundo}><Icon name="undo" size={17} /></button
	>
	<button
		type="button"
		class="tb"
		aria-label="Redo"
		title="Redo (Ctrl+Y)"
		disabled={!canRedo}
		onclick={onredo}><Icon name="redo" size={17} /></button
	>
	<span class="sep" aria-hidden="true"></span>

	<label for="{uid}-fmt" class="sr">Number format</label>
	<select
		id="{uid}-fmt"
		class="pick"
		value={fmt}
		onchange={(e) => {
			const v = e.currentTarget.value;
			e.currentTarget.value = fmt;
			if (v !== 'custom') onnumfmt(v);
		}}
	>
		{#each NUMBER_FORMATS as f (f.code)}<option value={f.code}>{f.label}</option>{/each}
		{#if fmt === 'custom'}<option value="custom" disabled>Custom</option>{/if}
	</select>
	<label for="{uid}-size" class="sr">Font size</label>
	<select
		id="{uid}-size"
		class="pick size"
		value={String(size)}
		onchange={(e) => onfontsize(Number(e.currentTarget.value))}
	>
		{#if !SIZES.includes(size)}<option value={String(size)}>{size}</option>{/if}
		{#each SIZES as s (s)}<option value={String(s)}>{s}</option>{/each}
	</select>
	<span class="sep" aria-hidden="true"></span>

	<button
		type="button"
		class="tb"
		aria-label="Format as currency"
		title="Format as currency"
		onclick={() => onnumfmt('"$"#,##0.00')}><Icon name="currency" size={17} /></button
	>
	<button
		type="button"
		class="tb"
		aria-label="Format as percent"
		title="Format as percent"
		onclick={() => onnumfmt('0.00%')}><Icon name="percent" size={17} /></button
	>
	<span class="sep" aria-hidden="true"></span>

	{#each marks as m (m.id)}
		<button
			type="button"
			class="tb"
			class:on={!!style.font[m.id]}
			aria-label={m.label}
			title={m.label}
			aria-pressed={!!style.font[m.id]}
			onclick={() => onmark(m.id)}><Icon name={m.icon} size={17} /></button
		>
	{/each}
	<Menu
		label="Text color"
		floating
		items={TEXT_COLORS}
		width={180}
		onselect={(id) => oncolor('text', id || null)}
	>
		{#snippet trigger(attrs)}
			<button type="button" class="tb" title="Text color" aria-label="Text color" {...attrs}>
				<Icon name="text-color" size={17} />
				<span class="bar" style:background={style.font.color ?? 'var(--text-strong)'}></span>
			</button>
		{/snippet}
	</Menu>
	<Menu
		label="Fill color"
		floating
		items={FILLS}
		width={180}
		onselect={(id) => oncolor('fill', id || null)}
	>
		{#snippet trigger(attrs)}
			<button type="button" class="tb" title="Fill color" aria-label="Fill color" {...attrs}>
				<Icon name="fill-color" size={17} />
				<span class="bar" style:background={style.fill ?? 'var(--tag-green-soft)'}></span>
			</button>
		{/snippet}
	</Menu>
	<span class="sep" aria-hidden="true"></span>

	<Menu
		label="Borders"
		floating
		items={BORDERS}
		width={200}
		onselect={(id) => onborder(id as BorderKind)}
	>
		{#snippet trigger(attrs)}
			<button type="button" class="tb" title="Borders" aria-label="Borders" {...attrs}
				><Icon name="borders" size={17} /></button
			>
		{/snippet}
	</Menu>
	<button
		type="button"
		class="tb"
		class:on={merged}
		aria-label="Merge cells"
		title={merged ? 'Unmerge cells' : 'Merge cells'}
		aria-pressed={merged}
		onclick={onmerge}><Icon name="merge" size={17} /></button
	>
	<span class="sep" aria-hidden="true"></span>

	{#each aligns as a (a.id)}
		<button
			type="button"
			class="tb"
			class:on={h === a.id}
			aria-label={a.label}
			title={a.label}
			aria-pressed={h === a.id}
			onclick={() => onalign(h === a.id ? 'general' : a.id)}
			><Icon name={a.icon} size={17} /></button
		>
	{/each}
	<button
		type="button"
		class="tb"
		class:on={!!style.align.wrap}
		aria-label="Wrap text"
		title="Wrap text"
		aria-pressed={!!style.align.wrap}
		onclick={onwrap}><Icon name="wrap" size={17} /></button
	>
	<span class="sep" aria-hidden="true"></span>

	<button type="button" class="tb" aria-label="Sort" title="Sort" onclick={onsort}
		><Icon name="sort-lines" size={17} /></button
	>
	<button
		type="button"
		class="tb"
		class:on={filterOn}
		aria-label="Filter"
		title="Filter"
		aria-pressed={filterOn}
		onclick={onfilter}><Icon name="funnel" size={17} /></button
	>
	<Menu
		label="Insert function"
		heading="Functions"
		floating
		items={FUNCTION_ITEMS}
		width={200}
		onselect={onfunction}
	>
		{#snippet trigger(attrs)}
			<button
				type="button"
				class="tb"
				title="Insert function"
				aria-label="Insert function"
				{...attrs}><Icon name="function" size={17} /></button
			>
		{/snippet}
	</Menu>

	<span class="end">
		<button
			type="button"
			class="tb"
			class:on={panel}
			aria-label="Toggle details panel"
			title="Details"
			aria-pressed={panel}
			onclick={ontogglepanel}><Icon name="panel" size={17} /></button
		>
	</span>
</div>

<style>
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 6px 16px 8px;
		color: var(--text-soft);
	}

	.tb {
		position: relative;
		min-width: 34px;
		height: 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 6px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
		transition:
			background 0.12s,
			color 0.12s;
	}

	.tb:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.tb:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.tb.on {
		background: var(--tag-green-soft);
		color: var(--tag-green);
	}

	.bar {
		position: absolute;
		left: 9px;
		right: 9px;
		bottom: 5px;
		height: 3px;
		border-radius: 2px;
	}

	.sep {
		width: 1px;
		height: 22px;
		margin: 0 4px;
		background: var(--border-strong);
	}

	.pick {
		height: 34px;
		width: 120px;
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-size: 13px;
	}

	.pick.size {
		width: 64px;
	}

	.end {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
	}

	@media (max-width: 720px) {
		.toolbar {
			flex-wrap: nowrap;
			overflow-x: auto;
			overscroll-behavior-x: contain;
			scrollbar-width: none;
			padding: 6px 12px;
		}

		.toolbar::-webkit-scrollbar {
			display: none;
		}

		.toolbar > :global(*) {
			flex-shrink: 0;
		}

		.end {
			margin-left: 0;
		}
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
