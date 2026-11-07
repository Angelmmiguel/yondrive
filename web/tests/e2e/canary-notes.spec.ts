/**
 * The zero knowledge canary for Notes: titles, text, tags, notebook names and
 * the titles links point at stay on the device. Making, linking, tagging,
 * saving, indexing and searching notes happen without any of them reaching the
 * server's data, its logs or any request. In mode `none` the logs are checked.
 */
import { expect, test } from '@playwright/test';
import { openDrive } from '../drive';
import {
	backToList,
	expectNew,
	newNotebook,
	noteEditor,
	notebookButton,
	openNotes,
	saveNow,
	setTitle,
	typeInNote
} from '../notes';
import { captureRequests, findIn, scanDir } from '../scan';
import { startServer, type Mode } from '../server';

for (const mode of ['e2e', 'none'] as Mode[]) {
	test(`in mode ${mode}, notes stay on the device`, async ({ browser }) => {
		test.setTimeout(120_000);
		const server = await startServer({ mode });
		const page = await (await browser.newContext()).newPage();
		try {
			await openDrive(page, server, mode);
			const sent = captureRequests(page);
			const notebook = `canary-notebook-Pq41x-${mode}`;
			const target = `canary-target-Lm29v-${mode}`;
			const title = `canary-title-Wd73k-${mode}`;
			const text = `canary note text Zt58r ${mode}`;
			const tag = `canarytagq${mode === 'e2e' ? 'e' : 'n'}83`;

			await openNotes(page);
			await newNotebook(page, notebook);
			await notebookButton(page, notebook).click();
			await page.getByRole('button', { name: 'New note', exact: true }).click();
			await expectNew(page);
			await setTitle(page, target);
			await typeInNote(page, 'The target.');
			await saveNow(page);

			await page.getByRole('button', { name: `New note in ${notebook}` }).click();
			await expectNew(page);
			await setTitle(page, title);
			await typeInNote(page, `${text} #${tag} see [[canary-target`);
			await page.getByRole('option', { name: new RegExp(target) }).click();
			await expect(noteEditor(page).locator('a.node-link')).toHaveText(target);
			await saveNow(page);
			await page.getByRole('button', { name: 'Add tag' }).click();
			await page.getByLabel('New tag').fill(`${tag}x`);
			await page.getByLabel('New tag').press('Enter');
			await expect(page.getByText(`#${tag}x`)).toBeVisible();
			await backToList(page);
			await page.getByLabel('Search notes').fill('Zt58r');
			await expect(page.getByTestId('note-card')).toHaveCount(1, { timeout: 20_000 });
			// The index of notes and of search is stored a few seconds after it changes.
			await page.waitForTimeout(6000);

			const secrets = {
				'notebook name': notebook,
				'note title': title,
				'link target title': target,
				'note text': text,
				tag,
				'search words': 'Zt58r'
			};
			expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);
			if (mode === 'e2e') {
				expect(findIn(Buffer.from(sent.join('\n')), secrets)).toEqual([]);
				expect(await scanDir(server.dataDir, secrets)).toEqual([]);
			}
		} finally {
			await page.context().close();
			await server.stop();
		}
	});
}
