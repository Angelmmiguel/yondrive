/** Without a secure context there is no service worker, and the Blob fallback does the work. */
import { expect, test, type Page } from '@playwright/test';
import { clickName, download, expectDriveReady, fileBox, multiFrame, upload } from '../drive';
import { setUpServer, signIn } from '../flows';
import { startServer, type Mode, type Server } from '../server';

const box = await fileBox();

test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let page: Page;

		test.beforeAll(async ({ browser }) => {
			server = await startServer({ mode });
			const context = await browser.newContext({
				acceptDownloads: true,
				serviceWorkers: 'block'
			});
			page = await context.newPage();
			await page.addInitScript(() => {
				Object.defineProperty(window, 'isSecureContext', { value: false });
			});
			await setUpServer(page, server, { mode });
			await signIn(page);
			await expectDriveReady(page);
		});

		test.afterAll(async () => {
			await page.context().close();
			await server.stop();
		});

		test('uploads, and downloads the identical bytes through memory, saying so', async () => {
			await expect(page.getByText('This connection is not secure')).toBeVisible();
			const registrations = await page.evaluate(
				async () => (await navigator.serviceWorker.getRegistrations()).length
			);
			expect(registrations).toBe(0);

			const file = await box.add(`plain-${mode}.bin`, multiFrame(1.25));
			await upload(page, file);

			let stream = false;
			page.on('request', (request) => {
				if (new URL(request.url()).pathname.startsWith('/stream/')) stream = true;
			});
			const notice = page.getByText(/held in memory while it downloads/);
			const bytes = download(page, file.name);
			await expect(notice).toBeVisible();
			expect((await bytes).equals(file.bytes)).toBe(true);
			expect(stream).toBe(false);
			await expect(notice).toHaveCount(0);
		});

		test('still opens a viewer', async () => {
			const file = await box.add(`plain-${mode}.txt`, Buffer.from('plain words'));
			await upload(page, file);
			await clickName(page, file.name);
			await expect(page.getByTestId('viewer-text')).toHaveText('plain words');
			await page.getByRole('button', { name: 'Close', exact: true }).click();
		});
	});
}
