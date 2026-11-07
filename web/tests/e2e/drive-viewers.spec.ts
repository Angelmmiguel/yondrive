/** What can be opened inside the app, and what is only ever downloaded. */
import { expect, test, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import {
	act,
	clickName,
	download,
	expectDriveReady,
	fileBox,
	openDrive,
	row,
	upload
} from '../drive';
import { expectLocked, PASSPHRASE, submitUnlock } from '../flows';
import { startServer, type Mode, type Server } from '../server';

const box = await fileBox();

/** Locks with the viewer still open: from another tab, as the dialog is modal here. */
async function accountMenuWithViewer(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByTestId('account-menu').click();
	await page.getByRole('menuitem', { name: 'Lock' }).click();
}

test.afterAll(() => box.remove());

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	let crc = 0xffffffff;
	for (const byte of body) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
	return out;
}

/** A real PNG of one colour, small enough to read. */
function png(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x55)]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** A real two-page PDF, written by hand. */
function pdf(): Buffer {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << >> >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << >> >>',
		'<< /Length 30 >>\nstream\n0 0 1 rg 20 20 200 100 re f\n\nendstream'
	];
	let out = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((object, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const start = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let page: Page;
		const violations: string[] = [];

		test.beforeAll(async ({ browser }) => {
			server = await startServer({ mode });
			page = await (await browser.newContext({ acceptDownloads: true })).newPage();
			page.on('console', (message) => {
				if (message.text().includes('Content Security Policy')) violations.push(message.text());
			});
			await openDrive(page, server, mode);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('an image opens from its name, and gets a sealed thumbnail', async () => {
			const file = await box.add(`photo-${mode}.png`, png(400, 200));
			await upload(page, file);
			await clickName(page, file.name);
			const image = page.getByTestId('viewer').getByRole('img', { name: file.name });
			await expect(image).toBeVisible();
			expect(await image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(400);
			await page.getByRole('button', { name: 'Close', exact: true }).click();

			const thumb = row(page, file.name).locator('img');
			await expect(thumb).toBeVisible();
			await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
			expect(violations).toEqual([]);
		});

		test('a PDF draws its pages through pdf.js, under the CSP', async () => {
			const file = await box.add(`paper-${mode}.pdf`, pdf());
			await upload(page, file);
			await act(page, file.name, 'Open');
			const pages = page.getByTestId('pdf-pages');
			await expect(pages).toHaveAttribute('data-pages', '2', { timeout: 30_000 });
			const first = pages.locator('canvas').first();
			await expect(first).toHaveAttribute('data-drawn', 'true', { timeout: 30_000 });

			// The page really was drawn: it holds the blue rectangle.
			const blue = await first.evaluate((canvas: HTMLCanvasElement) => {
				const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
				let count = 0;
				for (let i = 0; data && i < data.length; i += 4) {
					if (data[i + 2] > 200 && data[i] < 60) count += 1;
				}
				return count;
			});
			expect(blue).toBeGreaterThan(1000);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
			expect(violations).toEqual([]);
		});

		test('text shows as text, whatever is in it', async () => {
			const words = '<script>window.hacked = true</script><img src=x onerror=alert(1)>';
			const file = await box.add(`words-${mode}.txt`, Buffer.from(words));
			await upload(page, file);
			await act(page, file.name, 'Open');
			await expect(page.getByTestId('viewer-text')).toHaveText(words);
			expect(await page.evaluate(() => 'hacked' in window)).toBe(false);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		});

		test('audio plays through the service worker, with ranges', async () => {
			const samples = 8000;
			const wav = Buffer.alloc(44 + samples);
			wav.write('RIFF', 0, 'latin1');
			wav.writeUInt32LE(36 + samples, 4);
			wav.write('WAVEfmt ', 8, 'latin1');
			wav.writeUInt32LE(16, 16);
			wav.writeUInt16LE(1, 20);
			wav.writeUInt16LE(1, 22);
			wav.writeUInt32LE(8000, 24);
			wav.writeUInt32LE(8000, 28);
			wav.writeUInt16LE(1, 32);
			wav.writeUInt16LE(8, 34);
			wav.write('data', 36, 'latin1');
			wav.writeUInt32LE(samples, 40);
			wav.fill(0x80, 44);
			const file = await box.add(`sound-${mode}.wav`, wav);
			await upload(page, file);
			await act(page, file.name, 'Open');
			const audio = page.getByTestId('viewer').locator('audio');
			await expect(audio).toBeVisible();
			await expect(audio).toHaveAttribute('src', /^\/stream\//);
			await expect
				.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
				.toBeCloseTo(1, 1);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		});

		test('a service worker the browser stopped gets its key again from the page', async () => {
			await act(page, `sound-${mode}.wav`, 'Open');
			const audio = page.getByTestId('viewer').locator('audio');
			const source = (await audio.getAttribute('src')) as string;
			const cdp = await page.context().newCDPSession(page);
			await cdp.send('ServiceWorker.enable');
			await cdp.send('ServiceWorker.stopAllWorkers');

			const first = await page.evaluate(async (url) => {
				const res = await fetch(url, { headers: { Range: 'bytes=0-3' } });
				return { status: res.status, text: await res.text() };
			}, source);
			expect(first).toEqual({ status: 206, text: 'RIFF' });
			await cdp.detach();
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		});

		test('a lock takes the keys out of the service worker', async () => {
			test.skip(mode === 'none', 'there is nothing to lock in this mode');
			await act(page, `sound-${mode}.wav`, 'Open');
			const audio = page.getByTestId('viewer').locator('audio');
			const source = (await audio.getAttribute('src')) as string;
			const status = () =>
				page.evaluate(
					async (url) => (await fetch(url, { headers: { Range: 'bytes=0-1' } })).status,
					source
				);
			expect(await status()).toBe(206);

			await accountMenuWithViewer(page);
			await expectLocked(page);
			expect(await status()).toBe(404);

			await submitUnlock(page, PASSPHRASE);
			await expectDriveReady(page);
		});

		test('SVG and HTML are only ever downloaded', async () => {
			const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.hacked=1</script></svg>';
			const html = '<script>window.hacked=1</script>';
			const a = await box.add(`shape-${mode}.svg`, Buffer.from(svg));
			const b = await box.add(`page-${mode}.html`, Buffer.from(html));
			await upload(page, a, b);

			for (const file of [a, b]) {
				await page.getByRole('button', { name: `Actions for ${file.name}` }).click();
				await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toHaveCount(0);
				await page.keyboard.press('Escape');

				const started = page.waitForEvent('download');
				await clickName(page, file.name);
				const got = await started;
				expect(got.suggestedFilename()).toBe(file.name);
				await expect(page.getByTestId('viewer')).toHaveCount(0);
			}
			expect((await download(page, a.name)).toString()).toBe(svg);
			expect(await page.evaluate(() => 'hacked' in window)).toBe(false);
		});
	});
}
