<!--
  The framed table that holds FileRow items, with its column header. It scrolls
  sideways on a narrow screen instead of squeezing the columns.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { FILE_COLUMNS } from './fileColumns';

	interface Props {
		label: string;
		/** Sits at the head of the column of row checkboxes. */
		selectAll?: Snippet;
		children: Snippet;
	}

	let { label, selectAll, children }: Props = $props();
</script>

<div class="frame">
	<div class="table" role="table" aria-label={label} style:--cols={FILE_COLUMNS}>
		<div class="head" role="row">
			<span role="columnheader" class="check">{@render selectAll?.()}</span>
			<span role="columnheader">Name</span>
			<span role="columnheader">Tags</span>
			<span role="columnheader">Shared</span>
			<span role="columnheader">Modified</span>
			<span role="columnheader" class="end">Size</span>
			<span role="columnheader" class="sr">Favorite</span>
			<span role="columnheader" class="sr">Actions</span>
		</div>
		{@render children()}
	</div>
</div>

<style>
	.frame {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--surface);
	}

	.table {
		min-width: 880px;
	}

	.head {
		display: grid;
		grid-template-columns: var(--cols);
		align-items: center;
		gap: 12px;
		height: 40px;
		padding: 0 16px;
		border-bottom: 1px solid var(--divider);
		font-size: 12px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.end {
		text-align: right;
	}

	.check {
		display: flex;
		align-items: center;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
</style>
