<!-- The row of things to make on Home. -->
<script lang="ts">
	import { Icon, type IconName } from '$lib/components';

	interface Props {
		onnewfolder: () => void;
		onupload: () => void;
		onnewdoc?: () => void;
		onnewsheet?: () => void;
	}

	let { onnewfolder, onupload, onnewdoc, onnewsheet }: Props = $props();

	const creators: {
		label: string;
		hint: string;
		icon: IconName;
		run: () => void;
		app?: 'doc' | 'sheet';
	}[] = $derived([
		...(onnewdoc
			? [
					{
						label: 'New doc',
						hint: 'Write and format',
						icon: 'doc' as const,
						run: onnewdoc,
						app: 'doc' as const
					}
				]
			: []),
		...(onnewsheet
			? [
					{
						label: 'New sheet',
						hint: 'Numbers and formulas',
						icon: 'sheet' as const,
						run: onnewsheet,
						app: 'sheet' as const
					}
				]
			: []),
		{ label: 'New folder', hint: 'Organize files', icon: 'folder', run: onnewfolder },
		{ label: 'Upload', hint: 'Files or folders', icon: 'upload', run: onupload }
	]);
</script>

<section class="row" aria-label="Create">
	{#each creators as creator (creator.label)}
		<button type="button" class="tile" onclick={creator.run}>
			<span class="badge" class:doc={creator.app === 'doc'} class:sheet={creator.app === 'sheet'}
				><Icon name={creator.icon} size={20} /></span
			>
			<span class="text">
				<span class="label">{creator.label}</span>
				<span class="hint">{creator.hint}</span>
			</span>
		</button>
	{/each}
</section>

<style>
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 12px;
		max-width: 860px;
	}

	.tile {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 14px;
		background: var(--surface);
		color: var(--text-strong);
		text-align: left;
		cursor: pointer;
		transition:
			transform 0.18s ease,
			box-shadow 0.18s ease,
			border-color 0.18s;
	}

	.tile:hover {
		transform: translateY(-2px);
		border-color: var(--border-strong);
		box-shadow: var(--shadow-lg);
	}

	.badge {
		width: 38px;
		height: 38px;
		flex: none;
		display: grid;
		place-items: center;
		border-radius: 10px;
		background: var(--file-folder-soft);
		color: var(--file-folder);
	}

	.badge.doc {
		background: var(--drive-soft);
		color: var(--drive);
	}

	.badge.sheet {
		background: var(--sheets-soft);
		color: var(--sheets);
	}

	.text {
		display: flex;
		flex-direction: column;
	}

	.label {
		font-weight: 500;
	}

	.hint {
		font-size: 12px;
		color: var(--text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.tile {
			transition: none;
		}

		.tile:hover {
			transform: none;
		}
	}
</style>
