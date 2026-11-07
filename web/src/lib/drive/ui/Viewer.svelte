<!--
  Shows a file inside the app, once its version has been verified. Images are drawn
  from a Blob of a safe type, text as text, and PDFs through pdf.js. SVG and HTML
  never get here: see viewers/kinds.ts.
-->
<script lang="ts">
	import { Button, Dialog, ProgressBar } from '$lib/components';
	import { drive } from '$lib/state/drive.svelte';
	import { describeDriveError } from '../errors';
	import { decodeText, safeImageType, VIEW_LIMITS, viewerFor } from '../viewers/kinds';
	import { inferType } from '../kinds';
	import PdfView from './PdfView.svelte';

	const node = $derived(drive.viewing);
	const kind = $derived(node === null ? null : viewerFor(node));

	let url = $state<string | null>(null);
	let text = $state<string | null>(null);
	let pdf = $state.raw<Uint8Array<ArrayBuffer> | null>(null);
	let progress = $state(0);
	let total = $state(0);
	let error = $state('');
	let release: (() => void) | null = null;

	$effect(() => {
		const opening = node;
		const viewer = kind;
		if (opening === null || viewer === null) return;
		let stale = false;
		url = null;
		text = null;
		pdf = null;
		error = '';
		progress = 0;
		total = 0;

		void (async () => {
			const core = drive.core;
			if (core === null) return;
			try {
				const version = await core.openVersion(opening);
				if (stale) return;
				if (viewer === 'audio' || viewer === 'video') {
					const media = await core.mediaUrl(opening, version);
					if (stale) {
						media.release();
						return;
					}
					release = media.release;
					url = media.url;
					return;
				}
				const blob = await core.readBlob(opening, version, {
					limit: VIEW_LIMITS[viewer],
					type: viewer === 'image' ? safeImageType(opening) : 'application/octet-stream',
					onProgress: (done, all) => {
						progress = done;
						total = all;
					}
				});
				if (stale) return;
				if (viewer === 'image') {
					const objectUrl = URL.createObjectURL(blob);
					release = () => URL.revokeObjectURL(objectUrl);
					url = objectUrl;
				} else if (viewer === 'text') {
					text = decodeText(new Uint8Array(await blob.arrayBuffer()));
				} else {
					pdf = new Uint8Array(await blob.arrayBuffer());
				}
			} catch (e) {
				if (!stale) error = describeDriveError(e);
			}
		})();

		return () => {
			stale = true;
			release?.();
			release = null;
		};
	});

	const close = () => (drive.viewing = null);
	const loading = $derived(error === '' && url === null && text === null && pdf === null);
</script>

{#if node}
	<Dialog open title={node.name} width={1100} onclose={close}>
		<div class="stage" data-testid="viewer">
			{#if error}
				<p class="problem" role="alert">{error}</p>
			{:else if loading}
				<div class="loading">
					<ProgressBar
						label="Opening {node.name}"
						value={total > 0 ? progress : undefined}
						max={Math.max(total, 1)}
					/>
				</div>
			{:else if kind === 'image' && url}
				<img src={url} alt={node.name} />
			{:else if kind === 'video' && url}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={url} controls preload="metadata"></video>
			{:else if kind === 'audio' && url}
				<audio src={url} controls preload="metadata"></audio>
			{:else if kind === 'text' && text !== null}
				<pre data-testid="viewer-text">{text}</pre>
			{:else if kind === 'pdf' && pdf}
				<PdfView data={pdf} name={node.name} />
			{/if}
		</div>
		{#snippet footer()}
			<span class="type">{inferType(node.name, node.type)}</span>
			<Button icon="download" onclick={() => node && drive.download(node)}>Download</Button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.stage {
		display: flex;
		justify-content: center;
		min-height: 200px;
		max-height: 72dvh;
		overflow: auto;
		background: var(--surface-canvas);
		border-radius: 12px;
	}

	img,
	video {
		max-width: 100%;
		max-height: 72dvh;
		object-fit: contain;
		margin: auto;
	}

	audio {
		width: min(520px, 100%);
		margin: auto;
	}

	pre {
		width: 100%;
		margin: 0;
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 13px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--text-body);
	}

	.loading {
		width: min(360px, 80%);
		margin: auto;
	}

	.problem {
		max-width: 520px;
		margin: auto;
		padding: 24px;
		color: var(--danger-ink);
		text-align: center;
	}

	.type {
		margin-right: auto;
		align-self: center;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
