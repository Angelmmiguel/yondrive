<!--
  The formatting toolbar of the editor board. It reads the editor's state on each
  change (`rev`) and runs commands on it; what the file's format cannot hold is
  not offered.
-->
<script lang="ts">
	import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
	import type { EditorView } from 'prosemirror-view';
	import { Icon, Menu, type IconName, type MenuItem } from '$lib/components';
	import type { Caps } from '$lib/formats/document';
	import type { BlockStyle } from '$lib/formats/model';
	import {
		currentParagraph,
		insertTable,
		isMarkActive,
		markValue,
		setAlign,
		setMarkValue,
		setStyle,
		tableCommands,
		toggleList,
		toggleMark
	} from '../commands';
	import { schema } from '../schema';

	interface Props {
		view: EditorView;
		/** Bumped on every transaction, so that what is shown follows the selection. */
		rev: number;
		caps: Caps;
		outline: boolean;
		panel: boolean;
		onlink: () => void;
		onimage: () => void;
		onfind: () => void;
		ontoggleoutline: () => void;
		ontogglepanel: () => void;
	}

	let {
		view,
		rev,
		caps,
		outline,
		panel,
		onlink,
		onimage,
		onfind,
		ontoggleoutline,
		ontogglepanel
	}: Props = $props();

	const state = $derived.by(() => {
		void rev;
		return view.state;
	});
	const para = $derived(currentParagraph(state));
	const inTable = $derived(tableCommands.isInTable(state));

	const STYLES: { id: BlockStyle; label: string }[] = [
		{ id: 'normal', label: 'Normal text' },
		{ id: 'title', label: 'Title' },
		{ id: 'h1', label: 'Heading 1' },
		{ id: 'h2', label: 'Heading 2' },
		{ id: 'h3', label: 'Heading 3' },
		{ id: 'h4', label: 'Heading 4' },
		{ id: 'quote', label: 'Quote' },
		{ id: 'code', label: 'Code' }
	];
	const FONTS = ['Source Serif 4', 'Geist', 'Georgia', 'Arial', 'Times New Roman', 'Courier New'];
	const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48];
	const COLORS: MenuItem[] = [
		{ id: '', label: 'Automatic' },
		{ id: '#c00000', label: 'Red' },
		{ id: '#2e4fe0', label: 'Blue' },
		{ id: '#17643a', label: 'Green' },
		{ id: '#c55a11', label: 'Orange' },
		{ id: '#7030a0', label: 'Purple' },
		{ id: '#626268', label: 'Grey' }
	];
	const HIGHLIGHTS: MenuItem[] = [
		{ id: '', label: 'None' },
		{ id: '#ffff00', label: 'Yellow' },
		{ id: '#00ff00', label: 'Green' },
		{ id: '#00ffff', label: 'Cyan' },
		{ id: '#ff00ff', label: 'Pink' }
	];

	const font = $derived(
		(markValue(state, schema.marks.font)?.attrs.family as string | undefined) ?? ''
	);
	const size = $derived(
		String((markValue(state, schema.marks.size)?.attrs.pt as number | undefined) ?? '')
	);
	const color = $derived(
		(markValue(state, schema.marks.color)?.attrs.value as string | undefined) ?? ''
	);
	const highlight = $derived(
		(markValue(state, schema.marks.highlight)?.attrs.value as string | undefined) ?? ''
	);

	function run(command: (s: typeof view.state, d?: typeof view.dispatch) => boolean) {
		command(view.state, view.dispatch);
		view.focus();
	}

	interface Tool {
		id: string;
		label: string;
		icon: IconName;
		on: boolean;
		show: boolean;
		run: () => void;
	}

	const markTool = (
		name: 'bold' | 'italic' | 'underline' | 'strike' | 'code',
		label: string,
		icon: IconName
	): Tool => ({
		id: name,
		label,
		icon,
		on: isMarkActive(state, schema.marks[name]),
		show: caps.marks.has(name),
		run: () => run(toggleMark(schema.marks[name]))
	});

	const groups = $derived.by<Tool[][]>(() => [
		[
			markTool('bold', 'Bold', 'bold'),
			markTool('italic', 'Italic', 'italic'),
			markTool('underline', 'Underline', 'underline'),
			markTool('strike', 'Strikethrough', 'strike'),
			markTool('code', 'Inline code', 'code')
		],
		[
			{
				id: 'bullet',
				label: 'Bulleted list',
				icon: 'list-bullet',
				on: para?.list?.kind === 'bullet',
				show: caps.lists,
				run: () => run(toggleList('bullet'))
			},
			{
				id: 'number',
				label: 'Numbered list',
				icon: 'list-number',
				on: para?.list?.kind === 'number',
				show: caps.lists,
				run: () => run(toggleList('number'))
			},
			{
				id: 'check',
				label: 'Checklist',
				icon: 'list-check',
				on: para?.list?.kind === 'check',
				show: caps.lists,
				run: () => run(toggleList('check'))
			}
		],
		[
			{
				id: 'left',
				label: 'Align left',
				icon: 'align-left',
				on: !para?.align || para.align === 'left',
				show: caps.align,
				run: () => run(setAlign('left'))
			},
			{
				id: 'center',
				label: 'Align center',
				icon: 'align-center',
				on: para?.align === 'center',
				show: caps.align,
				run: () => run(setAlign('center'))
			},
			{
				id: 'right',
				label: 'Align right',
				icon: 'align-right',
				on: para?.align === 'right',
				show: caps.align,
				run: () => run(setAlign('right'))
			},
			{
				id: 'justify',
				label: 'Justify',
				icon: 'align-justify',
				on: para?.align === 'justify',
				show: caps.align,
				run: () => run(setAlign('justify'))
			}
		],
		[
			{
				id: 'link',
				label: 'Insert link',
				icon: 'link',
				on: isMarkActive(state, schema.marks.link),
				show: caps.marks.has('link'),
				run: onlink
			},
			{
				id: 'image',
				label: 'Insert image',
				icon: 'image',
				on: false,
				show: caps.images,
				run: onimage
			},
			{
				id: 'table',
				label: 'Insert table',
				icon: 'table',
				on: false,
				show: caps.tables && !inTable,
				run: () => run(insertTable())
			}
		]
	]);

	const TABLE_ITEMS: MenuItem[] = [
		{ id: 'row', label: 'Add row below' },
		{ id: 'col', label: 'Add column right' },
		{ id: 'delrow', label: 'Delete row' },
		{ id: 'delcol', label: 'Delete column' },
		{ id: 'deltable', label: 'Delete table' }
	];

	function tableAction(id: string) {
		const c = {
			row: tableCommands.addRowAfter,
			col: tableCommands.addColumnAfter,
			delrow: tableCommands.deleteRow,
			delcol: tableCommands.deleteColumn,
			deltable: tableCommands.deleteTable
		}[id];
		if (c) run(c);
	}

	const styles = $derived(STYLES.filter((s) => caps.styles.has(s.id)));
</script>

<div class="toolbar" role="toolbar" aria-label="Formatting">
	<button
		type="button"
		class="tb"
		aria-label="Undo"
		title="Undo"
		disabled={undoDepth(state) === 0}
		onclick={() => run(undo)}
	>
		<Icon name="undo" />
	</button>
	<button
		type="button"
		class="tb"
		aria-label="Redo"
		title="Redo"
		disabled={redoDepth(state) === 0}
		onclick={() => run(redo)}
	>
		<Icon name="redo" />
	</button>
	<span class="sep" aria-hidden="true"></span>

	{#if styles.length > 1}
		<label class="sr" for="doc-style">Paragraph style</label>
		<select
			id="doc-style"
			class="pick"
			value={para?.style ?? 'normal'}
			onchange={(e) => run(setStyle(e.currentTarget.value as BlockStyle))}
		>
			{#each styles as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
			{#if para && !styles.some((s) => s.id === para.style)}<option value={para.style}
					>{para.style}</option
				>{/if}
		</select>
	{/if}
	{#if caps.marks.has('font')}
		<label class="sr" for="doc-font">Font</label>
		<select
			id="doc-font"
			class="pick font"
			value={font}
			onchange={(e) =>
				run(
					setMarkValue(
						schema.marks.font,
						e.currentTarget.value ? { family: e.currentTarget.value } : null
					)
				)}
		>
			<option value="">Default font</option>
			{#each FONTS as f (f)}<option value={f}>{f}</option>{/each}
			{#if font && !FONTS.includes(font)}<option value={font}>{font}</option>{/if}
		</select>
	{/if}
	{#if caps.marks.has('size')}
		<label class="sr" for="doc-size">Font size</label>
		<select
			id="doc-size"
			class="pick size"
			value={size}
			onchange={(e) =>
				run(
					setMarkValue(
						schema.marks.size,
						e.currentTarget.value ? { pt: Number(e.currentTarget.value) } : null
					)
				)}
		>
			<option value="">Size</option>
			{#each SIZES as s (s)}<option value={String(s)}>{s}</option>{/each}
			{#if size && !SIZES.includes(Number(size))}<option value={size}>{size}</option>{/if}
		</select>
	{/if}

	{#each groups as group, g (g)}
		{#if group.some((t) => t.show)}
			<span class="sep" aria-hidden="true"></span>
			{#each group.filter((t) => t.show) as tool (tool.id)}
				<button
					type="button"
					class="tb"
					class:on={tool.on}
					aria-label={tool.label}
					title={tool.label}
					aria-pressed={tool.on}
					onclick={tool.run}
				>
					<Icon name={tool.icon} />
				</button>
			{/each}
		{/if}
		{#if g === 0 && (caps.marks.has('color') || caps.marks.has('highlight'))}
			<span class="sep" aria-hidden="true"></span>
			{#if caps.marks.has('color')}
				<Menu
					label="Text color"
					items={COLORS}
					width={180}
					onselect={(id) => run(setMarkValue(schema.marks.color, id ? { value: id } : null))}
				>
					{#snippet trigger(attrs)}
						<button type="button" class="tb" title="Text color" aria-label="Text color" {...attrs}>
							<Icon name="text-color" />
							<span class="bar" style:background={color || 'var(--accent)'}></span>
						</button>
					{/snippet}
				</Menu>
			{/if}
			{#if caps.marks.has('highlight')}
				<Menu
					label="Highlight"
					items={HIGHLIGHTS}
					width={160}
					onselect={(id) => run(setMarkValue(schema.marks.highlight, id ? { value: id } : null))}
				>
					{#snippet trigger(attrs)}
						<button type="button" class="tb" title="Highlight" aria-label="Highlight" {...attrs}>
							<Icon name="highlight" />
							<span class="bar" style:background={highlight || '#f5d35b'}></span>
						</button>
					{/snippet}
				</Menu>
			{/if}
		{/if}
	{/each}

	{#if inTable}
		<span class="sep" aria-hidden="true"></span>
		<Menu label="Table" items={TABLE_ITEMS} width={200} onselect={tableAction}>
			{#snippet trigger(attrs)}
				<button type="button" class="tb wide" {...attrs}><Icon name="table" /> Table</button>
			{/snippet}
		</Menu>
	{/if}

	<span class="end">
		<button
			type="button"
			class="tb"
			aria-label="Find and replace"
			title="Find and replace"
			onclick={onfind}
		>
			<Icon name="search" />
		</button>
		<button
			type="button"
			class="tb"
			class:on={outline}
			aria-label="Toggle outline"
			title="Outline"
			aria-pressed={outline}
			onclick={ontoggleoutline}
		>
			<Icon name="outline" />
		</button>
		<button
			type="button"
			class="tb"
			class:on={panel}
			aria-label="Toggle details panel"
			title="Details"
			aria-pressed={panel}
			onclick={ontogglepanel}
		>
			<Icon name="panel" />
		</button>
	</span>
</div>

<style>
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 6px 16px 8px;
	}

	.tb {
		position: relative;
		min-width: 34px;
		height: 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
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

	.tb.wide {
		padding: 0 10px;
		color: var(--text-strong);
	}

	.tb:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.tb:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.tb.on {
		background: var(--accent-soft);
		color: var(--accent-ink);
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
		max-width: 150px;
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-size: 13px;
	}

	.pick.size {
		max-width: 76px;
	}

	.end {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 2px;
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
