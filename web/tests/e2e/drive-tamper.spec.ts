/** A server that changes a stored byte is caught, wherever the file is read. */
import { expect, test, type Page, type Route } from '@playwright/test';
import { act, fileBox, multiFrame, openDrive, row, upload } from '../drive';
import { startServer, type Mode, type Server } from '../server';

const box = await fileBox();

test.afterAll(() => box.remove());

/** Answers with the real bytes but one. */
async function flipAByte(route: Route, at = 100) {
	const response = await route.fetch();
	const body = await response.body();
	if (body.length > at) body[at] ^= 1;
	await route.fulfill({ response, body });
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let page: Page;

		test.beforeAll(async ({ browser }) => {
			server = await startServer({ mode });
			page = await (await browser.newContext({ acceptDownloads: true })).newPage();
			await openDrive(page, server, mode);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('a viewer refuses a flipped byte, and shows nothing of the file', async () => {
			const secret = 'the bytes of this text must not be shown once they fail';
			const file = await box.add(`tamper-${mode}.txt`, Buffer.from(secret.repeat(10)));
			await upload(page, file);

			await page.route('**/api/v1/blobs/**', (route) => flipAByte(route));
			await act(page, file.name, 'Open');
			const viewer = page.getByTestId('viewer');
			await expect(viewer).toContainText('failed its integrity check');
			await expect(page.getByTestId('viewer-text')).toHaveCount(0);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
			await page.unroute('**/api/v1/blobs/**');

			await act(page, file.name, 'Open');
			await expect(page.getByTestId('viewer-text')).toContainText(secret);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		});

		test('a download through the service worker stops at the flipped frame', async () => {
			const file = await box.add(`tamper-${mode}.bin`, multiFrame(2.25));
			await upload(page, file);
			const context = page.context();

			// The second frame comes back changed. Requests of a service worker pass here.
			await context.route('**/api/v1/blobs/**', async (route) => {
				const range = route.request().headers()['range'] ?? '';
				if (range.startsWith('bytes=0-')) await route.continue();
				else await flipAByte(route);
			});
			const started = page.waitForEvent('download');
			await act(page, file.name, 'Download');
			const got = await started;

			expect(await got.failure()).not.toBeNull();
			await expect(page.getByText(/failed its integrity check/)).toBeVisible();
			await context.unroute('**/api/v1/blobs/**');
		});

		test('a changed list of hashes is refused before any frame is read', async () => {
			const secret = 'frame hashes are signed';
			const file = await box.add(`hashes-${mode}.txt`, Buffer.from(secret));
			await upload(page, file);

			// Other things read blobs in the background, such as the search index, so only
			// requests for the content blob of this version count.
			let contentBlob: string | null = null;
			await page.route('**/api/v1/nodes/*/versions/*', async (route) => {
				const response = await route.fetch();
				const version = await response.json();
				contentBlob = version.blob_id;
				const hashes = Buffer.from(version.frame_hashes, 'base64');
				hashes[0] ^= 1;
				version.frame_hashes = hashes.toString('base64');
				await route.fulfill({ response, json: version });
			});
			const fetched: string[] = [];
			await page.route('**/api/v1/blobs/**', (route) => {
				const id = new URL(route.request().url()).pathname.split('/').pop();
				if (id === contentBlob) fetched.push(route.request().url());
				return route.continue();
			});
			await act(page, file.name, 'Open');
			const viewer = page.getByTestId('viewer');
			await expect(viewer).toContainText('failed its integrity check');
			expect(contentBlob).not.toBeNull();
			expect(fetched).toEqual([]);
			await expect(page.getByTestId('viewer-text')).toHaveCount(0);
			await expect(viewer).not.toContainText(secret);
			await page.getByRole('button', { name: 'Close', exact: true }).click();
			await page.unrouteAll();
			await expect(row(page, file.name)).toBeVisible();
		});
	});
}
