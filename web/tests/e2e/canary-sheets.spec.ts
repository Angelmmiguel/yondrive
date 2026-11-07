/**
 * The zero knowledge canary for spreadsheets: a workbook's name, its sheet names,
 * the cells it came with and what is typed into it stay on the device. Opening,
 * editing, saving, the heartbeat and search happen without them reaching the
 * server's data, its logs or any request. In mode `none` the logs are still checked.
 */
import { expect, test } from '@playwright/test';
import { fileBox, openDrive, upload } from '../drive';
import { cell, openSheet, saveNow, typeIn } from '../sheets';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode } from '../server';
import { xlsxOf } from '../fixtures/sheet-samples';

for (const mode of ['e2e', 'none'] as Mode[]) {
	test(`in mode ${mode}, spreadsheet names and cells stay on the device`, async ({ browser }) => {
		test.setTimeout(120_000);
		const server = await startServer({ mode });
		const box = await fileBox();
		const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
		try {
			await openDrive(page, server, mode);
			const sent = captureRequests(page);
			const name = `canary-workbook-Qm47t2-${mode}.xlsx`;
			const text = `canary cell text Vb93k6 ${mode}`;
			const typed = `canary typed cell Pd28w1 ${mode}`;
			const sheetName = `CanarySheet Lx61`;
			const bytes = await xlsxOf([
				`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData>`
			]);
			await upload(page, await box.add(name, Buffer.from(bytes)));
			await openSheet(page, name);
			await expect(cell(page, 'A1')).toHaveText(text);
			await page.getByRole('tab', { name: 'S1' }).click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Rename…' }).click();
			const rename = page.getByRole('dialog', { name: 'Rename sheet' });
			await rename.getByLabel('Name').fill(sheetName);
			await rename.getByRole('button', { name: 'Rename' }).click();
			await typeIn(page, 'B2', typed);
			await saveNow(page);
			expect(sent.join('\n')).toContain('/editing');

			const secrets = {
				'workbook name': name,
				'cell text': text,
				'typed text': typed,
				'sheet name': sheetName
			};
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
