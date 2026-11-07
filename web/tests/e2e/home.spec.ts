import { expect, test } from '@playwright/test';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(async () => {
	await server.stop();
});

test('a server with no setup says to use the link from the logs, under the CSP', async ({
	page
}) => {
	const violations: string[] = [];
	page.on('console', (m) => {
		if (m.text().includes('Content Security Policy')) violations.push(m.text());
	});
	const external: string[] = [];
	page.on('request', (r) => {
		if (!r.url().startsWith(server.url) && !r.url().startsWith('data:')) external.push(r.url());
	});

	const response = await page.goto(server.url);
	expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
	expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

	await expect(page.getByRole('heading', { name: /waiting to be set up/ })).toBeVisible();
	await expect(page.getByText('first-run setup required')).toBeVisible();
	await expect(page).toHaveURL(/\/setup$/);
	expect(violations).toEqual([]);
	expect(external).toEqual([]);
});

test('a wrong setup token gets a clear refusal', async ({ page }) => {
	await page.goto(`${server.url}/setup#not-the-token`);
	await expect(page.getByRole('heading', { name: /does not work/ })).toBeVisible();
	await expect(page.getByRole('alert')).toContainText('not valid');
});

test('the theme choice is stored under yondrive-theme', async ({ page }) => {
	await page.goto(`${server.url}/styleguide`);
	await page.getByRole('radio', { name: 'Dark' }).first().click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	expect(await page.evaluate(() => localStorage.getItem('yondrive-theme'))).toBe('dark');

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
