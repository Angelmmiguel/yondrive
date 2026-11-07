<!--
  Shows a file, once something has been asked for its bytes: from a drive or from
  a public link, which is all the difference. Images are drawn from a Blob of a safe
  type, text as text, and PDFs through pdf.js. SVG and HTML never get here: see
  viewers/kinds.ts.
-->
<script lang="ts">
	import { ProgressBar } from '$lib/components';
	import { decodeText, safeImageType, VIEW_LIMITS, type ViewerKind } from '../viewers/kinds';
	import PdfView from './PdfView.svelte';

	/** Where the bytes come from. Each call verifies what it reads before giving it. */
	export interface ViewerSource {
		media(): Promise<{ url: string; release: () => void }>;
		blob(options: {
			limit: number;
			type: string;
			onProgress: (done: number, total: number) => void;
		}): Promise<Blob>;
	}

	interface Props {
		file: { name: string; type: string };
		kind: ViewerKind;
		source: ViewerSource;
		/** The sentence for what went wrong. */
		describe: (e: unknown) => string;
	}

	let { file, kind, source, describe }: Props = $props();

	let url = $state<string | null>(null);
	let text = $state<string | null>(null);
	let pdf = $state.raw<Uint8Array<ArrayBuffer> | null>(null);
	let progress = $state(0);
	let total = $state(0);
	let error = $state('');
	let release: (() => void) | null = null;

	$effect(() => {
		const from = source;
		const opening = file;
		const viewer = kind;
		let stale = false;
		url = null;
		text = null;
		pdf = null;
		error = '';
		progress = 0;
		total = 0;

		void (async () => {
			try {
				if (viewer === 'audio' || viewer === 'video') {
					const media = await from.media();
					if (stale) {
						media.release();
						return;
					}
					release = media.release;
					url = media.url;
					return;
				}
				const blob = await from.blob({
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
				if (!stale) error = describe(e);
			}
		})();

		return () => {
			stale = true;
			release?.();
			release = null;
		};
	});

	const loading = $derived(error === '' && url === null && text === null && pdf === null);
</script>

<div class="stage" data-testid="viewer">
	{#if error}
		<p class="problem" role="alert">{error}</p>
	{:else if loading}
		<div class="loading">
			<ProgressBar
				label="Opening {file.name}"
				value={total > 0 ? progress : undefined}
				max={Math.max(total, 1)}
			/>
		</div>
	{:else if kind === 'image' && url}
		<img src={url} alt={file.name} />
	{:else if kind === 'video' && url}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video src={url} controls preload="metadata"></video>
	{:else if kind === 'audio' && url}
		<audio src={url} controls preload="metadata"></audio>
	{:else if kind === 'text' && text !== null}
		<pre data-testid="viewer-text">{text}</pre>
	{:else if kind === 'pdf' && pdf}
		<PdfView data={pdf} name={file.name} />
	{/if}
</div>

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
</style>
