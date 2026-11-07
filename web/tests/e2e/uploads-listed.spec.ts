/** Uploads the server holds that nothing on this device knows of: listed, with a way out. */
import { expect, test } from '@playwright/test';
import { fileBox, inPage, openDrive, reopenDrive, row, upload } from '../drive';
import { startServer, type Mode, type Server } from '../server';

const box = await fileBox();

test.afterAll(() => box.remove());

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('one left elsewhere shows in the panel and can be aborted', async ({ page }) => {
			test.setTimeout(120_000);
			await openDrive(page, server, mode);
			await upload(page, await box.add('kept.txt', Buffer.from('some bytes')));

			const root = await inPage<{ id: string; key_generation: number }>(page, 'GET', '/nodes/root');
			const { nodes } = await inPage<{
				nodes: { id: string; suite: string; key_generation: number }[];
			}>(page, 'GET', `/nodes/${root.id}/children`);
			const frame = 1024;
			const stored = frame + (mode === 'e2e' ? 41 : 0);
			await inPage(page, 'POST', '/uploads', {
				node_id: nodes[0].id,
				version_id: 'c'.repeat(32),
				suite: nodes[0].suite,
				frame_size: frame,
				frame_count: 1,
				stored_size: stored,
				key_generation: nodes[0].key_generation
			});

			await page.reload();
			await reopenDrive(page);
			const stray = page.getByTestId('stray-upload');
			await expect(stray).toContainText('kept.txt');
			await expect(stray).toContainText('0 of 1 parts');
			await stray.getByRole('button', { name: 'Abort' }).click();
			await expect(stray).toHaveCount(0);
			await expect(row(page, 'kept.txt')).toBeVisible();
			const left = await inPage<{ uploads: unknown[] }>(page, 'GET', '/uploads');
			expect(left.uploads).toEqual([]);
		});
	});
}
