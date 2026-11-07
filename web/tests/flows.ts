/**
 * What the specs do through the app, the way a person would. Argon2id runs at its
 * production cost here, so the timeouts leave room for it.
 */
import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import type { Mode, Server } from './server';

export const PASSPHRASE = 'correct horse battery staple';
export const NEW_PASSPHRASE = 'quiet lanterns drift over amber fields';
export const ADMIN = 'admin';

const DERIVE = 30_000;

/** Reads the words on screen and types back the three it asks for. */
export async function confirmRecoveryKey(page: Page): Promise<string[]> {
	const list = page.getByTestId('recovery-words');
	await expect(list).toBeVisible();
	const words = (await list.locator('li span:last-child').allTextContents()).map((w) => w.trim());
	expect(words).toHaveLength(24);
	const asked = page.getByLabel(/^Word \d+/);
	await expect(asked).toHaveCount(3);
	for (const input of await asked.all()) {
		const id = await input.getAttribute('id');
		const label = await page.locator(`label[for="${id}"]`).innerText();
		const position = Number(/Word (\d+)/.exec(label)?.[1]);
		await input.fill(words[position - 1]);
	}
	await expect(page.getByText('That matches.')).toBeVisible();
	return words;
}

export interface WizardOptions {
	mode?: Mode;
	username?: string;
	passphrase?: string;
	displayName?: string;
	email?: string;
	totp?: boolean;
}

export async function openWizard(page: Page, server: Server): Promise<void> {
	await page.goto(`${server.url}/setup#${await server.setupToken()}`);
	await expect(page.getByRole('heading', { name: 'Set up your server' })).toBeVisible();
}

export async function chooseMode(page: Page, mode: Mode): Promise<void> {
	await page.getByRole('radio', { name: mode === 'e2e' ? /End-to-end/ : /No encryption/ }).click();
}

export async function fillAdmin(page: Page, options: WizardOptions = {}): Promise<void> {
	const passphrase = options.passphrase ?? PASSPHRASE;
	if (options.displayName) await page.getByLabel(/^Your name/).fill(options.displayName);
	await page.getByLabel(/^Username/).fill(options.username ?? ADMIN);
	if (options.email) await page.getByLabel(/^Email/).fill(options.email);
	await page.getByLabel(/^Passphrase/).fill(passphrase);
	await page.getByLabel(/^Confirm passphrase/).fill(passphrase);
	if (options.totp) await page.getByRole('switch').click();
}

const proceed = (page: Page) => page.getByRole('button', { name: 'Continue' }).click();

/** The whole wizard, up to the done screen. Returns the recovery words, if there are any. */
export async function runWizard(
	page: Page,
	server: Server,
	options: WizardOptions = {}
): Promise<string[]> {
	const mode = options.mode ?? server.mode;
	await openWizard(page, server);
	await proceed(page);
	await expect(page.getByRole('heading', { name: /how files are encrypted/ })).toBeVisible();
	await chooseMode(page, mode);
	await proceed(page);
	await expect(page.getByRole('heading', { name: /first administrator/ })).toBeVisible();
	await fillAdmin(page, options);
	await proceed(page);
	let words: string[] = [];
	if (mode === 'e2e') {
		await expect(page.getByRole('heading', { name: 'Your recovery key' })).toBeVisible();
		words = await confirmRecoveryKey(page);
		await proceed(page);
	}
	await expect(page.getByRole('heading', { name: 'Review and finish' })).toBeVisible();
	await page.getByRole('button', { name: 'Finish setup' }).click();
	await expect(page.getByRole('heading', { name: 'YonDrive is ready' })).toBeVisible({
		timeout: DERIVE
	});
	return words;
}

/** The wizard, and on to the sign-in screen. */
export async function setUpServer(
	page: Page,
	server: Server,
	options: WizardOptions = {}
): Promise<string[]> {
	const words = await runWizard(page, server, options);
	await page.getByRole('button', { name: 'Go to sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	return words;
}

export async function submitSignIn(
	page: Page,
	username: string,
	passphrase: string
): Promise<void> {
	await page.getByLabel(/^Username/).fill(username);
	await page.getByLabel(/^Passphrase/).fill(passphrase);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function expectHome(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible({ timeout: DERIVE });
}

export async function signIn(
	page: Page,
	username: string = ADMIN,
	passphrase: string = PASSPHRASE
): Promise<void> {
	await submitSignIn(page, username, passphrase);
	await expectHome(page);
}

/** Picks an entry of the account menu at the top of the app. */
export async function accountMenu(page: Page, item: string): Promise<void> {
	await page.locator('button[aria-haspopup="menu"]').click();
	await page.getByRole('menuitem', { name: item }).click();
}

export async function expectSignedOut(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

export async function expectLocked(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
}

export async function submitUnlock(page: Page, passphrase: string): Promise<void> {
	await page.getByLabel(/^Passphrase/).fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
}

/** Creates an invite in the admin screen and returns its link. */
export async function createInvite(page: Page): Promise<string> {
	await page.goto(new URL('/admin', page.url()).href);
	await page.getByRole('tab', { name: 'Invites' }).click();
	await page.getByRole('button', { name: 'Create invite' }).click();
	const link = page.getByTestId('invite-link').locator('pre');
	await expect(link).toBeVisible();
	return (await link.innerText()).trim();
}

/** Registers from a link, up to the screen that says the account is ready. */
export async function register(
	page: Page,
	link: string,
	username: string,
	passphrase: string = PASSPHRASE,
	encrypted = true
): Promise<string[]> {
	await page.goto(link);
	await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
	await page.getByLabel(/^Username/).fill(username);
	await page.getByLabel(/^Passphrase/).fill(passphrase);
	await page.getByLabel(/^Confirm passphrase/).fill(passphrase);
	let words: string[] = [];
	if (encrypted) {
		await page.getByRole('button', { name: 'Continue' }).click();
		words = await confirmRecoveryKey(page);
	}
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page.getByRole('heading', { name: 'Your account is ready' })).toBeVisible({
		timeout: DERIVE
	});
	return words;
}

/** RFC 6238 with the server's parameters, `steps` periods from now. */
export function totpCode(secret: string, steps = 0): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const c of secret.replace(/=+$/, '').toUpperCase()) {
		bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
	}
	const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps));
	const mac = createHmac('sha1', key).update(counter).digest();
	const at = mac[mac.length - 1] & 0xf;
	return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
