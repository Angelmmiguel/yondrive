/** What the search specs do through the app. */
import { expect, type Page } from '@playwright/test';
import { myFiles } from './drive';

/** Opens the palette from the keyboard, with this typed. */
export async function openSearch(page: Page, text = ''): Promise<void> {
	await page.keyboard.press('ControlOrMeta+k');
	const input = page.getByRole('combobox', { name: 'Search for' });
	await expect(input).toBeFocused();
	if (text !== '') await input.fill(text);
}

/**
 * Goes to My files and waits until the page change is over: the address has changed and
 * the router has had its turn with the focus, which it resets once the new page is drawn.
 */
export async function settleAtMyFiles(page: Page): Promise<void> {
	await myFiles(page);
	await expect(page).toHaveURL(/\/files\/root$/);
	await page.evaluate(
		() =>
			new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
	);
}

export const hits = (page: Page) => page.getByTestId('search-hit');

/** Waits for what the palette lists, as the index catches up. Closes it again unless told. */
export async function expectFound(page: Page, text: string, names: string[]): Promise<void> {
	await expect(async () => {
		if (await page.getByTestId('search-palette').isVisible()) await page.keyboard.press('Escape');
		await openSearch(page, text);
		if (names.length === 0) {
			await expect(page.getByTestId('search-empty')).toBeVisible({ timeout: 1000 });
		}
		await expect(hits(page).locator('.name')).toHaveText(names, { timeout: 1000 });
	}).toPass({ timeout: 45_000 });
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('search-palette')).toHaveCount(0);
}

/** Waits until segments went to the server, by how the status reads and what was sent. */
export async function expectIndexed(page: Page): Promise<void> {
	await openSearch(page);
	await expect(page.getByTestId('search-status')).toHaveAttribute('data-phase', 'ready', {
		timeout: 45_000
	});
	await page.keyboard.press('Escape');
}
