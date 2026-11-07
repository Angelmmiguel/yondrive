/**
 * The zero knowledge canary: what a person types that only the device may know
 * must not reach the server, its database, its data directory or its logs. It
 * covers setup and sign-in now; files and their names join it with Drive.
 */
import { expect, test } from '@playwright/test';
import { captureRequests, findIn, scanDir } from '../scan';
import { accountMenu, expectLocked, runWizard, signIn, submitUnlock } from '../flows';
import { startServer, type Mode, type Server } from '../server';

const CANARY_PASSPHRASE = 'canary zebra quartz meadow violet 7319';
const CANARY_NAME = 'Canary Displayname Xq7Zp2';
const USERNAME = 'canaryuser';

/** The whole phrase, and every two adjacent words in the forms they could be joined. */
function wordSecrets(words: string[]): Record<string, string> {
	const secrets: Record<string, string> = {};
	if (words.length === 0) return secrets;
	secrets.phrase = words.join(' ');
	secrets['phrase without spaces'] = words.join('');
	words.slice(1).forEach((word, i) => {
		secrets[`words ${i + 1}-${i + 2}`] = `${words[i]} ${word}`;
	});
	return secrets;
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('the passphrase, the recovery words and the name stay on the device', async ({ page }) => {
			const sent = captureRequests(page);

			const words = await runWizard(page, server, {
				mode,
				username: USERNAME,
				passphrase: CANARY_PASSPHRASE,
				displayName: CANARY_NAME
			});
			await page.getByRole('button', { name: 'Go to sign in' }).click();
			await signIn(page, USERNAME, CANARY_PASSPHRASE);

			if (mode === 'e2e') {
				await accountMenu(page, 'Lock');
				await expectLocked(page);
				await submitUnlock(page, CANARY_PASSPHRASE);
				await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible({
					timeout: 30_000
				});
			}

			const secrets = {
				passphrase: CANARY_PASSPHRASE,
				name: CANARY_NAME,
				...wordSecrets(words)
			};

			// The name was really typed, and is really on the device.
			expect(await page.evaluate(() => localStorage.getItem('yondrive-display-name'))).toBe(
				CANARY_NAME
			);

			// Everything the browser sent. The scan sees what it should: the bodies
			// carry the username and an auth key, and the setup body was captured.
			const requests = sent.join('\n');
			expect(requests).toContain(USERNAME);
			expect(requests).toContain('auth_key');
			expect(requests).toContain('/api/v1/setup/complete');
			expect(findIn(Buffer.from(requests), secrets)).toEqual([]);

			// The data directory, the database and its write-ahead log. It can read
			// them: the username is there, in the clear, as the threat model says.
			expect(await scanDir(server.dataDir, { username: USERNAME })).not.toEqual([]);
			expect(await scanDir(server.dataDir, secrets)).toEqual([]);

			// What the server logged. It did log something, including the setup link.
			expect(server.logs()).toContain('listening');
			expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);
		});
	});
}
