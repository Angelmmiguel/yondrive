/**
 * Adding a device by code, in both modes, with a phone played from the test runner
 * on the app's own crypto: the code on screen is what the page says it is, both
 * screens show the same six digits, the phone opens what the browser sealed and
 * reads the account with its token, and in end-to-end mode opens the identity keys
 * with the master key it received. A phone that signs in with the passphrase
 * instead gets its token with the account. Revoking signs a device out. The
 * canary: the browser's key from the code, the token secret and the master key
 * never reach the server, its disk or its logs.
 *
 * The code's expiry is not played here, as these servers run on the real clock:
 * the Go tests and the flow's unit tests move the clock instead.
 */
import { expect, test } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { decodeBase64, encodeBase64 } from '../../src/lib/crypto/encoding';
import { openIdentity, unwrapMasterKey } from '../../src/lib/crypto/keys';
import { generatePairingKeys, pairingCode } from '../../src/lib/crypto/pairing';
import { SUITE_E2E, SUITE_NONE } from '../../src/lib/crypto/sealer';
import { codeLink, openAddDevice, Phone, scanCode, signInDevice } from '../pairing';
import { captureRequests, findIn, scanDir } from '../scan';
import { PASSPHRASE, setUpServer, signIn } from '../flows';
import { startServer, type Mode, type Server } from '../server';

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Whether any file under `dir` holds these bytes as they are. */
async function rawIn(dir: string, bytes: Uint8Array): Promise<boolean> {
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (
			entry.isFile() &&
			(await readFile(join(entry.parentPath, entry.name))).includes(Buffer.from(bytes))
		) {
			return true;
		}
	}
	return false;
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`adding a device in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('pairs a phone by code, which then reads the account, until revoked', async ({
			page,
			browser
		}) => {
			test.setTimeout(180_000);
			const sent = captureRequests(page);
			await setUpServer(page, server, { mode });
			await signIn(page);

			const dialog = await openAddDevice(page, server);
			const link = await codeLink(dialog);
			expect(link.startsWith(`${server.url}/pair#1.`)).toBe(true);
			expect(await scanCode(browser, dialog)).toBe(link);
			await expect(dialog.getByText(/^Expires in [45]:\d\d$/)).toBeVisible();

			const phone = new Phone(link);
			expect(phone.origin).toBe(server.url);
			expect((await phone.claim("Angel's phone")).status).toBe(200);
			// A second phone, or someone who photographed the code, is too late.
			const late = await new Phone(link).claim('Thief');
			expect(late.status).toBe(409);
			expect(await late.json()).toEqual({ code: 'pairing_claimed' });

			await expect(dialog.getByRole('heading', { name: 'Is this your device?' })).toBeVisible();
			await expect(dialog.getByText("Angel's phone (iOS) wants to join")).toBeVisible();
			await expect(dialog.getByTestId('pairing-code')).toHaveText(spaced(phone.code));
			await dialog.getByRole('button', { name: 'Yes, add it' }).click();
			await expect(dialog.getByText("Angel's phone is paired")).toBeVisible();

			const payload = await phone.collect();
			const health = (await (await fetch(`${server.url}/api/v1/health`)).json()) as {
				mode: Mode;
			};
			expect(health.mode).toBe(mode);
			expect(payload.suite).toBe(mode === 'e2e' ? SUITE_E2E : SUITE_NONE);
			expect('master_key' in payload).toBe(mode === 'e2e');

			const me = await phone.call('/me', payload.token);
			expect(me.status).toBe(200);
			const account = (await me.json()) as {
				user: { username: string };
				keys?: {
					sealed_x25519: string;
					sealed_ed25519: string;
					public_keys: { x25519: string; ed25519: string };
				};
			};
			expect(account.user.username).toBe('admin');
			if (mode === 'e2e') {
				const keys = account.keys!;
				// Opening them checks the private keys against the public ones.
				openIdentity(
					{
						publicKeys: {
							x25519: decodeBase64(keys.public_keys.x25519),
							ed25519: decodeBase64(keys.public_keys.ed25519)
						},
						sealedX25519: decodeBase64(keys.sealed_x25519),
						sealedEd25519: decodeBase64(keys.sealed_ed25519)
					},
					decodeBase64(payload.master_key!)
				);
			}
			const listed = (await (await phone.call('/me/tokens', payload.token)).json()) as {
				name: string;
				origin: string;
				platform: string;
				current?: boolean;
			}[];
			expect(listed).toEqual([
				expect.objectContaining({
					name: "Angel's phone",
					origin: 'pairing',
					platform: 'ios',
					current: true
				})
			]);

			// The step's own button, after the dialog's corner one of the same name.
			await dialog.getByRole('button', { name: 'Close' }).last().click();
			const row = page.getByRole('listitem').filter({ hasText: "Angel's phone" });
			await expect(row).toContainText('iOS · Paired');

			// The canary, before the device is gone.
			const secrets: Record<string, string> = {
				'token secret': payload.token,
				'browser key': base64urlnopad.encode(phone.browserKey),
				'browser key, base64': encodeBase64(phone.browserKey),
				'browser key, hex': bytesToHex(phone.browserKey)
			};
			const raw: Record<string, Uint8Array> = { 'browser key': phone.browserKey };
			if (payload.master_key !== undefined) {
				const master = decodeBase64(payload.master_key);
				secrets['master key'] = payload.master_key;
				secrets['master key, hex'] = bytesToHex(master);
				raw['master key'] = master;
			}
			const requests = sent.join('\n');
			expect(requests).toContain('token_hash');
			expect(requests).toContain('sealed_payload');
			expect(findIn(Buffer.from(requests), secrets)).toEqual([]);
			expect(await scanDir(server.dataDir, secrets)).toEqual([]);
			for (const [name, bytes] of Object.entries(raw)) {
				expect(await rawIn(server.dataDir, bytes), name).toBe(false);
			}
			expect(server.logs()).toContain('listening');
			expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);

			await row.getByRole('button', { name: 'Revoke' }).click();
			await expect(row).toHaveCount(0);
			expect((await phone.call('/me', payload.token)).status).toBe(401);
		});

		test('a phone signs in with the passphrase, and shows in the list', async ({ page }) => {
			test.setTimeout(120_000);
			const { status, body, kek } = await signInDevice(server.url, 'admin', PASSPHRASE);
			expect(status).toBe(201);
			expect(body.token).toMatchObject({ origin: 'login', platform: 'android', current: true });
			const phone = {
				call: (path: string) =>
					fetch(`${server.url}/api/v1${path}`, {
						headers: { Authorization: `Bearer ${body.secret}` }
					})
			};
			expect((await phone.call('/me')).status).toBe(200);
			if (mode === 'e2e') {
				const wrapped = decodeBase64(body.account.keys!.wrapped_master_key);
				expect(unwrapMasterKey(wrapped, kek, 'passphrase')).toHaveLength(32);
			} else {
				expect(body.account.keys).toBeUndefined();
			}

			await page.goto(server.url);
			await signIn(page);
			await page.goto(`${server.url}/settings`);
			await page.getByRole('tab', { name: 'Devices' }).click();
			const row = page.getByRole('listitem').filter({ hasText: 'Angel’s tablet' });
			await expect(row).toContainText('Android · Signed in');
			await row.getByRole('button', { name: 'Revoke' }).click();
			await expect(row).toHaveCount(0);
			expect((await phone.call('/me')).status).toBe(401);
		});

		test('cancelling at the six digits ends the pairing', async ({ page }) => {
			await page.goto(server.url);
			await signIn(page);
			const dialog = await openAddDevice(page, server);
			const phone = new Phone(await codeLink(dialog));
			expect((await phone.claim('Tablet', 'android')).status).toBe(200);
			await expect(dialog.getByTestId('pairing-code')).toHaveText(spaced(phone.code));
			await dialog.getByRole('button', { name: 'No, cancel' }).click();
			await expect(dialog).toHaveCount(0);
			await expect.poll(async () => (await phone.poll()).status).toBe(404);
		});
	});
}

test('a server that swaps the device key shows the browser another code', async ({ page }) => {
	test.setTimeout(120_000);
	const server = await startServer({ mode: 'e2e' });
	try {
		await setUpServer(page, server, { mode: 'e2e' });
		await signIn(page);
		// The server stands between: it reports a key of its own choosing for the device.
		const planted = generatePairingKeys().publicKey;
		await page.route('**/api/v1/me/pairings/*', async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			const response = await route.fetch();
			const body = await response.json();
			if (body.device) body.device.public_key = encodeBase64(planted);
			await route.fulfill({ response, json: body });
		});
		const dialog = await openAddDevice(page, server);
		const phone = new Phone(await codeLink(dialog));
		expect((await phone.claim("Angel's phone")).status).toBe(200);

		const shown = dialog.getByTestId('pairing-code');
		await expect(shown).toHaveText(spaced(pairingCode(phone.browserKey, planted, phone.pairingId)));
		expect(await shown.textContent()).not.toBe(spaced(phone.code));
	} finally {
		await server.stop();
	}
});
