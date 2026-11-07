<!-- Find and replace over the document, with the matches highlighted by the editor. -->
<script lang="ts">
	import type { EditorView } from 'prosemirror-view';
	import { TextSelection } from 'prosemirror-state';
	import { Button, Icon } from '$lib/components';
	import { findKey } from '../plugins';
	import { replaceMatches } from '../find';

	interface Props {
		view: EditorView;
		rev: number;
		editable: boolean;
		onclose: () => void;
	}

	let { view, rev, editable, onclose }: Props = $props();
	let query = $state('');
	let replacement = $state('');
	let input = $state<HTMLInputElement>();

	const found = $derived.by(() => {
		void rev;
		return findKey.getState(view.state) ?? { query: '', matches: [], current: 0 };
	});

	$effect(() => {
		input?.focus();
		return () => {
			view.dispatch(view.state.tr.setMeta(findKey, { query: '', current: 0 }));
		};
	});

	function search(q: string) {
		query = q;
		view.dispatch(view.state.tr.setMeta(findKey, { query: q, current: 0 }));
		reveal(0);
	}

	function reveal(i: number) {
		const f = findKey.getState(view.state);
		const m = f?.matches[i];
		if (!m) return;
		const tr = view.state.tr.setMeta(findKey, { current: i });
		tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
		view.dispatch(tr);
	}

	function step(by: number) {
		const n = found.matches.length;
		if (n === 0) return;
		reveal((found.current + by + n) % n);
	}

	function replaceOne() {
		const m = found.matches[found.current];
		if (!m) return;
		view.dispatch(replaceMatches(view.state, [m], replacement));
		reveal(Math.min(found.current, found.matches.length - 1));
	}

	function replaceAll() {
		if (found.matches.length === 0) return;
		view.dispatch(replaceMatches(view.state, found.matches, replacement));
	}
</script>

<div class="find" role="search" aria-label="Find and replace">
	<label class="field">
		<span class="sr">Find</span>
		<input
			bind:this={input}
			value={query}
			placeholder="Find"
			oninput={(e) => search(e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					step(e.shiftKey ? -1 : 1);
				} else if (e.key === 'Escape') onclose();
			}}
		/>
	</label>
	<span class="count" aria-live="polite">
		{found.matches.length === 0
			? query
				? 'No matches'
				: ''
			: `${found.current + 1} of ${found.matches.length}`}
	</span>
	<button type="button" class="ib" aria-label="Previous match" onclick={() => step(-1)}
		><Icon name="chevron-down" size={16} /></button
	>
	<button type="button" class="ib next" aria-label="Next match" onclick={() => step(1)}
		><Icon name="chevron-down" size={16} /></button
	>
	{#if editable}
		<label class="field">
			<span class="sr">Replace with</span>
			<input bind:value={replacement} placeholder="Replace with" />
		</label>
		<Button size="sm" onclick={replaceOne} disabled={found.matches.length === 0}>Replace</Button>
		<Button size="sm" onclick={replaceAll} disabled={found.matches.length === 0}>Replace all</Button
		>
	{/if}
	<button type="button" class="ib" aria-label="Close find" onclick={onclose}
		><Icon name="close" size={16} /></button
	>
</div>

<style>
	.find {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 6px 16px 8px;
		border-top: 1px solid var(--divider);
	}

	input {
		height: 32px;
		width: 200px;
		max-width: 60vw;
		padding: 0 10px;
		border: 1px solid var(--border-field);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-strong);
		font: inherit;
		font-size: 13px;
	}

	.count {
		min-width: 70px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.ib {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--icon);
		cursor: pointer;
	}

	.ib:first-of-type :global(svg) {
		transform: rotate(180deg);
	}

	.ib.next :global(svg) {
		transform: none;
	}

	.ib:hover {
		background: var(--surface-hover);
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
