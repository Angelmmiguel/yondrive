/** Decodes one image and scales it down. A worker for each, ended right after. */
import { fitWithin } from '../thumbs/generate';

export interface ThumbRequest {
	file: Blob;
	edge: number;
}

export interface ThumbReply {
	image: ArrayBuffer | null;
}

self.onmessage = async (event: MessageEvent<ThumbRequest>) => {
	let image: ArrayBuffer | null = null;
	try {
		const bitmap = await createImageBitmap(event.data.file);
		const { width, height } = fitWithin(bitmap.width, bitmap.height, event.data.edge);
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (context !== null) {
			context.drawImage(bitmap, 0, 0, width, height);
			const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
			image = await blob.arrayBuffer();
		}
		bitmap.close();
	} catch {
		image = null;
	}
	const reply: ThumbReply = { image };
	self.postMessage(reply, { transfer: image === null ? [] : [image] });
};
