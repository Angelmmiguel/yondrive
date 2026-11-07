/** Reads and writes documents off the page: a hostile file can only stall this worker. */
import {
	readDocument,
	writeDocument,
	type DocFormat,
	type SaveFormat
} from '$lib/formats/document';
import type { DocModel } from '$lib/formats/model';

export type FormatsRequest =
	| { seq: number; op: 'read'; bytes: Uint8Array; format: DocFormat }
	| {
			seq: number;
			op: 'write';
			format: SaveFormat;
			model: DocModel;
			original?: { bytes: Uint8Array; format: DocFormat };
	  };

export type FormatsReply = { seq: number; result: unknown } | { seq: number; error: string };

self.onmessage = async (event: MessageEvent<FormatsRequest>) => {
	const req = event.data;
	try {
		const result =
			req.op === 'read'
				? await readDocument(req.bytes, req.format)
				: await writeDocument(req.format, req.model, req.original);
		(self as unknown as Worker).postMessage({ seq: req.seq, result } satisfies FormatsReply);
	} catch (e) {
		const error = e instanceof Error ? e.message : 'failed';
		(self as unknown as Worker).postMessage({ seq: req.seq, error } satisfies FormatsReply);
	}
};
