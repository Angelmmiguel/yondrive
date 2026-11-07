/**
 * pdf.js, loaded only when a PDF is opened, in a worker built with the app and
 * served from it, with eval off to stay inside the CSP.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

export const PDF_OPTIONS = {
	// Current pdf.js has no eval left to turn off; this stays so that an upgrade cannot bring it back.
	isEvalSupported: false,
	// Nothing is fetched: the data is handed over, and the optional wasm decoders are not embedded.
	useWorkerFetch: false,
	useWasm: false,
	stopAtErrors: false
} as const;

export interface LoadedPdf {
	document: PDFDocumentProxy;
	close(): void;
}

export async function loadPdf(data: Uint8Array<ArrayBuffer>): Promise<LoadedPdf> {
	const pdfjs = await import('pdfjs-dist');
	const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
	const port = pdfjs.PDFWorker.create({ port: worker });
	const task = pdfjs.getDocument({ ...PDF_OPTIONS, data, worker: port });
	try {
		const document = await task.promise;
		return {
			document,
			close() {
				void task.destroy();
				port.destroy();
				worker.terminate();
			}
		};
	} catch (e) {
		void task.destroy();
		worker.terminate();
		throw e;
	}
}
