import { expect, test } from '@playwright/test';
import { expectHome, setUpServer, signIn } from '../flows';
import { startServer, type Server } from '../server';

let server: Server;

test.beforeAll(async () => {
	server = await startServer({ mode: 'none' });
});

test.afterAll(async () => {
	await server.stop();
});

test('the insecure banner follows isSecureContext, in setup and in the shell', async ({
	page,
	browser
}) => {
	const banner = page.getByText('This connection is not secure');
	const insecure = await (await browser.newContext()).newPage();
	await insecure.addInitScript(() => {
		Object.defineProperty(window, 'isSecureContext', { value: false });
	});
	const warned = insecure.getByText('This connection is not secure');

	await insecure.goto(`${server.url}/setup#${await server.setupToken()}`);
	await expect(warned).toBeVisible();

	await setUpServer(page, server, { mode: 'none' });
	await expect(banner).toHaveCount(0);
	await signIn(page);
	await expect(banner).toHaveCount(0);

	await insecure.goto(`${server.url}/signin`);
	await expect(warned).toBeVisible();
	await signIn(insecure);
	await expect(warned).toBeVisible();
});

test('the rail and sidebar collapse on a phone, with no page scrolling sideways', async ({
	browser
}) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
	const phone = await context.newPage();
	await phone.goto(server.url);
	await signIn(phone);

	const rail = phone.getByRole('navigation', { name: 'Apps' });
	const menu = phone.getByRole('button', { name: 'Menu' });
	await expect(menu).toBeVisible();
	await expect(rail).toBeHidden();

	await menu.click();
	await expect(rail).toBeVisible();
	await expect(phone.getByRole('link', { name: 'My files' })).toBeVisible();
	await phone.keyboard.press('Escape');
	await expect(rail).toBeHidden();

	await menu.click();
	await phone.getByRole('link', { name: 'Settings' }).click();
	await expect(phone.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(rail).toBeHidden();

	for (const path of ['/', '/settings', '/admin']) {
		await phone.goto(`${server.url}${path}`);
		await expect(phone.getByRole('button', { name: 'Menu' })).toBeVisible();
		const overflow = await phone.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, path).toBeLessThanOrEqual(0);
	}
	await context.close();
});

test('a desktop shows the rail and sidebar with no menu button', async ({ page }) => {
	await page.goto(server.url);
	await signIn(page);
	await expectHome(page);
	await expect(page.getByRole('navigation', { name: 'Apps' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
});
