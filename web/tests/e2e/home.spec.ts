import { expect, test } from '@playwright/test';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer();
});

test.afterAll(async () => {
	await server.stop();
});

test('the home page shows the health response under the CSP', async ({ page }) => {
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

	await expect(page.getByTestId('health-version')).toHaveText('dev');
	await expect(page.getByTestId('health-setup')).toHaveText('Not started');
	expect(violations).toEqual([]);
	expect(external).toEqual([]);
});

test('the theme choice is stored under yondrive-theme', async ({ page }) => {
	await page.goto(server.url);
	await page.getByRole('radio', { name: 'Dark' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	expect(await page.evaluate(() => localStorage.getItem('yondrive-theme'))).toBe('dark');

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
