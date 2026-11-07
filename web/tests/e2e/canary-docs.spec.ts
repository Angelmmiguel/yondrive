/**
 * The zero knowledge canary for documents: a document's name, the text it came
 * with and the text typed into it stay on the device. Reading, editing, saving,
 * the heartbeat and search all happen without them reaching the server's data,
 * its logs or any request. In mode `none` the logs are still checked.
 */
import { expect, test } from '@playwright/test';
import { fileBox, openDrive, upload } from '../drive';
import { editor, openDoc, saveNow, typeAfter } from '../docs';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode } from '../server';
import { writeDocument } from '../../src/lib/formats/document';

for (const mode of ['e2e', 'none'] as Mode[]) {
	test(`in mode ${mode}, document names and text stay on the device`, async ({ browser }) => {
		test.setTimeout(120_000);
		const server = await startServer({ mode });
		const box = await fileBox();
		const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
		try {
			await openDrive(page, server, mode);
			const sent = captureRequests(page);
			const name = `canary-document-Zr83m1-${mode}.docx`;
			const body = `canary document body Jw17q3 ${mode}`;
			const typed = ` canary typed words Hx52c8 ${mode}`;
			const bytes = await writeDocument('docx', {
				blocks: [
					{ type: 'paragraph', style: 'normal', content: [{ type: 'text', text: body, marks: {} }] }
				],
				images: {}
			});
			await upload(page, await box.add(name, Buffer.from(bytes)));
			await openDoc(page, name);
			await expect(editor(page)).toContainText(body);
			await typeAfter(page, body, typed);
			await saveNow(page);
			// The heartbeat has gone out at least once by now.
			expect(sent.join('\n')).toContain('/editing');

			const secrets = { 'document name': name, 'document text': body, 'typed text': typed.trim() };
			const logs = Buffer.from(server.logs());
			expect(findIn(logs, secrets)).toEqual([]);
			if (mode === 'e2e') {
				expect(findIn(Buffer.from(sent.join('\n')), secrets)).toEqual([]);
				expect(await scanDir(server.dataDir, secrets)).toEqual([]);
			}
		} finally {
			await page.context().close();
			await box.remove();
			await server.stop();
		}
	});
}
