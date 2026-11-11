/**
 * The zero knowledge canary for what happens after setup: changing the
 * passphrase, replacing the recovery key and minting a device token from
 * settings, and recovering an account with its words. None of the new
 * passphrases or words may reach the server in any form, nor may the old ones
 * reach it again.
 */
import { expect, test } from '@playwright/test';
import { captureRequests, findIn, scanDir } from '../scan';
import {
	accountMenu,
	confirmRecoveryKey,
	expectHome,
	expectSignedOut,
	setUpServer,
	signIn
} from '../flows';
import { startServer, type Mode, type Server } from '../server';

const FIRST_PASSPHRASE = 'canary otter plinth saffron 4821 first';
const SECOND_PASSPHRASE = 'canary heron cobalt umbra 9054 second';
const THIRD_PASSPHRASE = 'canary lynx marble ember 3377 third';
const USERNAME = 'canaryaccount';

/** The whole phrase, and every two adjacent words in the forms they could be joined. */
function wordSecrets(label: string, words: string[]): Record<string, string> {
	const secrets: Record<string, string> = {};
	if (words.length === 0) return secrets;
	secrets[`${label} phrase`] = words.join(' ');
	secrets[`${label} phrase without spaces`] = words.join('');
	words.slice(1).forEach((word, i) => {
		secrets[`${label} words ${i + 1}-${i + 2}`] = `${words[i]} ${word}`;
	});
	return secrets;
}

/** What the browser sent, what the disk holds and what the server logged, against `secrets`. */
async function expectNothingLeaked(
	server: Server,
	sent: string[],
	secrets: Record<string, string>
): Promise<void> {
	// The scans can see: bodies carry the username and an auth key, headers are in.
	const requests = sent.join('\n');
	expect(requests).toContain(USERNAME);
	expect(requests).toContain('auth_key');
	expect(requests).toContain('"content-type"');
	expect(findIn(Buffer.from(requests), secrets)).toEqual([]);

	expect(await scanDir(server.dataDir, { username: USERNAME })).not.toEqual([]);
	expect(await scanDir(server.dataDir, secrets)).toEqual([]);

	expect(server.logs()).toContain('listening');
	expect(findIn(Buffer.from(server.logs()), secrets)).toEqual([]);
}

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe(`settings in mode ${mode}`, () => {
		let server: Server;

		test.beforeAll(async () => {
			server = await startServer({ mode });
		});

		test.afterAll(async () => {
			await server.stop();
		});

		test('a new passphrase, a new recovery key and a device token stay on the device', async ({
			page
		}) => {
			test.setTimeout(180_000);
			const sent = captureRequests(page);
			const oldWords = await setUpServer(page, server, {
				mode,
				username: USERNAME,
				passphrase: FIRST_PASSPHRASE
			});
			await signIn(page, USERNAME, FIRST_PASSPHRASE);
			await page.goto(`${server.url}/settings`);

			const passphrase = page.getByRole('region', { name: 'Passphrase' });
			await passphrase.getByLabel(/^Current passphrase/).fill(FIRST_PASSPHRASE);
			await passphrase.getByLabel(/^New passphrase/).fill(SECOND_PASSPHRASE);
			await passphrase.getByLabel(/^Confirm new passphrase/).fill(SECOND_PASSPHRASE);
			await passphrase.getByRole('button', { name: 'Change passphrase' }).click();
			await expect(page.getByText('Passphrase changed.')).toBeVisible({ timeout: 30_000 });

			let newWords: string[] = [];
			if (mode === 'e2e') {
				const recovery = page.getByRole('region', { name: 'Recovery key' });
				await recovery.getByRole('button', { name: 'Make a new recovery key' }).click();
				newWords = await confirmRecoveryKey(page);
				await recovery.getByLabel(/^Current passphrase/).fill(SECOND_PASSPHRASE);
				await recovery.getByRole('button', { name: 'Replace recovery key' }).click();
				await expect(page.getByText('New recovery key saved.')).toBeVisible({ timeout: 30_000 });
			}

			await page.getByRole('tab', { name: 'Devices' }).click();
			await page.getByText('Need a token for a script?').click();
			await page.getByLabel(/^Device name/).fill('canary phone');
			await page.getByLabel(/^Passphrase/).fill(SECOND_PASSPHRASE);
			await page.getByRole('button', { name: 'Create token' }).click();
			await expect(page.getByText('Copy this token now')).toBeVisible({ timeout: 30_000 });

			// The change really happened: the old passphrase is dead.
			await accountMenu(page, 'Sign out');
			await expectSignedOut(page);
			await signIn(page, USERNAME, SECOND_PASSPHRASE);

			await expectNothingLeaked(server, sent, {
				first: FIRST_PASSPHRASE,
				second: SECOND_PASSPHRASE,
				...wordSecrets('old', oldWords),
				...wordSecrets('new', newWords)
			});
		});
	});
}

test.describe('recovery', () => {
	let server: Server;

	test.beforeAll(async () => {
		server = await startServer({ mode: 'e2e' });
	});

	test.afterAll(async () => {
		await server.stop();
	});

	test('the words and the passphrases typed at /recover stay on the device', async ({ page }) => {
		test.setTimeout(180_000);
		const sent = captureRequests(page);
		const oldWords = await setUpServer(page, server, {
			username: USERNAME,
			passphrase: FIRST_PASSPHRASE
		});

		await page.getByRole('link', { name: 'Forgot your passphrase?' }).click();
		// A fill before the page has hydrated is lost, so fill until it sticks.
		await expect(async () => {
			await page.getByLabel(/^Username/).fill(USERNAME);
			await page.getByLabel(/^Recovery key/).fill(oldWords.join(' '));
			await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 1_000 });
		}).toPass({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page.getByRole('heading', { name: 'Set a new passphrase' })).toBeVisible({
			timeout: 30_000
		});
		await page.getByLabel(/^New passphrase/).fill(THIRD_PASSPHRASE);
		await page.getByLabel(/^Confirm new passphrase/).fill(THIRD_PASSPHRASE);
		await page.getByRole('button', { name: 'Continue' }).click();
		const newWords = await confirmRecoveryKey(page);
		await page.getByRole('button', { name: 'Finish' }).click();
		await expectHome(page);

		await expectNothingLeaked(server, sent, {
			first: FIRST_PASSPHRASE,
			third: THIRD_PASSPHRASE,
			...wordSecrets('old', oldWords),
			...wordSecrets('new', newWords)
		});
	});
});
