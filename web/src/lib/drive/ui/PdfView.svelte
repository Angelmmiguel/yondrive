<!-- A PDF, one canvas a page, each drawn when it scrolls near. -->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { PDFDocumentProxy } from 'pdfjs-dist';
	import { describeDriveError } from '../errors';
	import { loadPdf, type LoadedPdf } from '../viewers/pdf';

	interface Props {
		data: Uint8Array<ArrayBuffer>;
		name: string;
	}

	let { data, name }: Props = $props();

	let loaded = $state.raw<LoadedPdf | null>(null);
	let pages = $state<number[]>([]);
	let error = $state('');
	let gone = false;

	onMount(async () => {
		try {
			const pdf = await loadPdf(data);
			if (gone) {
				pdf.close();
				return;
			}
			loaded = pdf;
			pages = Array.from({ length: pdf.document.numPages }, (_, i) => i + 1);
		} catch (e) {
			error =
				e instanceof Error && e.name === 'InvalidPDFException'
					? 'This does not look like a PDF.'
					: describeDriveError(e);
		}
	});

	onDestroy(() => {
		gone = true;
		loaded?.close();
	});

	async function draw(canvas: HTMLCanvasElement, document: PDFDocumentProxy, number: number) {
		const page = await document.getPage(number);
		const width = canvas.parentElement?.clientWidth ?? 800;
		const natural = page.getViewport({ scale: 1 });
		const scale = (Math.min(width, 1000) / natural.width) * (window.devicePixelRatio || 1);
		const viewport = page.getViewport({ scale });
		canvas.width = viewport.width;
		canvas.height = viewport.height;
		canvas.style.width = '100%';
		await page.render({ canvas, viewport }).promise;
		canvas.dataset.drawn = 'true';
	}

	function lazyPage(canvas: HTMLCanvasElement, number: number) {
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting) || loaded === null) return;
				observer.disconnect();
				void draw(canvas, loaded.document, number).catch(() => {});
			},
			{ rootMargin: '400px' }
		);
		observer.observe(canvas);
		return { destroy: () => observer.disconnect() };
	}
</script>

{#if error}
	<p class="problem" role="alert">{error}</p>
{:else}
	<div class="pages" data-testid="pdf-pages" data-pages={pages.length}>
		{#each pages as number (number)}
			<canvas use:lazyPage={number} aria-label="Page {number} of {name}" width="800" height="1000"
			></canvas>
		{/each}
	</div>
{/if}

<style>
	.pages {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 12px;
	}

	canvas {
		max-width: 1000px;
		width: 100%;
		background: white;
		box-shadow: var(--shadow-sm);
	}

	.problem {
		margin: auto;
		padding: 24px;
		color: var(--danger-ink);
	}
</style>
