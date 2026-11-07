/**
 * Signing in through an identity provider, in both modes, against a provider in this
 * process. The provider's word gets a session and nothing else: with keys, an account
 * makes them here and unlocks with a passphrase the provider never sees.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
	accountMenu,
	ADMIN,
	confirmRecoveryKey,
	createInvite,
	expectHome,
	expectLocked,
	expectSignedOut,
	NEW_PASSPHRASE,
	PASSPHRASE,
	runWizard,
	setUpServer,
	signIn
} from '../flows';
import { startProvider, type FakeProvider } from '../oidc-provider';
import { captureRequests } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import { continueWithProvider, enrol, fillSignInStep, friendly, UNLOCK, unlockWith } from '../sso';

const fresh = async (browser: Browser) => (await browser.newContext()).newPage();

test.describe.serial('with keys', () => {
	let server: Server;
	let provider: FakeProvider;
	let page: Page;
	let words: string[];
	let sent: string[];

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(120_000);
		server = await startServer({ mode: 'e2e' });
		provider = await startProvider({
			sub: 'alice-sub',
			email: 'alice@example.com',
			email_verified: true,
			preferred_username: 'alice'
		});
		const admin = await fresh(browser);
		await setUpServer(admin, server, { mode: 'e2e', signIn: fillSignInStep(provider) });
		await admin.context().close();
		page = await fresh(browser);
		sent = captureRequests(page);
	});

	test.afterAll(async () => {
		await server.stop();
		await provider.stop();
	});

	test('a first sign-in does nothing before it has keys', async () => {
		test.setTimeout(120_000);
		await page.goto(server.url);
		await continueWithProvider(page);
		await expect(page.getByRole('heading', { name: 'Choose an unlock passphrase' })).toBeVisible();
		// No token anywhere in the address, and no other page will have it.
		expect(new URL(page.url()).search).toBe('');
		await page.goto(`${server.url}/settings`);
		await expect(page.getByRole('heading', { name: 'Choose an unlock passphrase' })).toBeVisible();

		words = await enrol(page);
		expect(words).toHaveLength(24);
		expect(sent.join('\n')).not.toContain('/auth/login');
	});

	test('settings say how it signs in, and leave out what does not apply', async () => {
		await page.goto(`${server.url}/settings`);
		const method = page.getByTestId('sign-in-method');
		await expect(method).toHaveAttribute('data-method', 'sso');
		await expect(method).toContainText('identity provider');
		await expect(page.getByRole('region', { name: 'Passphrase' })).toContainText(
			'Change unlock passphrase'
		);
		await expect(page.getByRole('region', { name: 'Recovery key' })).toBeVisible();
		await expect(page.getByText('Two-factor sign-in', { exact: true })).toHaveCount(0);
	});

	test('locks and unlocks with the passphrase, which no login ever carries', async () => {
		test.setTimeout(120_000);
		await page.goto(server.url);
		await expectHome(page);
		await accountMenu(page, 'Lock');
		await expectLocked(page);
		await page.getByLabel(/^Unlock passphrase/).fill('not the right passphrase');
		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect(friendly(page)).toContainText('not correct', { timeout: 30_000 });
		await unlockWith(page);
		await expectHome(page);
		expect(sent.join('\n')).not.toContain('/auth/login');
	});

	test('a new sign-in on the same account unlocks, and does not enrol again', async () => {
		test.setTimeout(120_000);
		await accountMenu(page, 'Sign out');
		await expectSignedOut(page);
		await continueWithProvider(page);
		await unlockWith(page);
		await expectHome(page);
	});

	test('the recovery words open it in the provider’s session, and replace themselves', async () => {
		test.setTimeout(180_000);
		await accountMenu(page, 'Sign out');
		await expectSignedOut(page);
		await continueWithProvider(page);
		await expectLocked(page);
		await page.getByRole('link', { name: 'Forgot your passphrase?' }).click();
		await expect(page.getByRole('heading', { name: 'Recover your account' })).toBeVisible();
		// It knows who is asking.
		await expect(page.getByLabel(/^Username/)).toHaveCount(0);
		await expect(async () => {
			await page.getByLabel(/^Recovery key/).fill(words.join(' '));
			await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 1000 });
		}).toPass({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page.getByRole('heading', { name: 'Set a new passphrase' })).toBeVisible();
		await page.getByLabel(/^New unlock passphrase/).fill(NEW_PASSPHRASE);
		await page.getByLabel(/^Confirm new unlock passphrase/).fill(NEW_PASSPHRASE);
		await page.getByRole('button', { name: 'Continue' }).click();
		const next = await confirmRecoveryKey(page);
		expect(next).not.toEqual(words);
		await page.getByRole('button', { name: 'Finish' }).click();
		await expectHome(page);
		expect(sent.join('\n')).not.toContain('/auth/login');

		await accountMenu(page, 'Lock');
		await unlockWith(page, UNLOCK);
		await expect(friendly(page)).toContainText('not correct', { timeout: 30_000 });
		await page.getByLabel(/^Unlock passphrase/).fill(NEW_PASSPHRASE);
		await page.getByRole('button', { name: 'Unlock' }).click();
		await expectHome(page);
	});

	test('the unlock passphrase signs nobody in', async ({ browser }) => {
		test.setTimeout(60_000);
		const other = await fresh(browser);
		await other.goto(`${server.url}/signin`);
		await other.getByLabel(/^Username/).fill('alice');
		await other.getByLabel(/^Passphrase/).fill(NEW_PASSPHRASE);
		await other.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(friendly(other)).toContainText('Wrong username or passphrase', {
			timeout: 30_000
		});
		await other.context().close();
	});
});

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`who gets in, in mode ${mode}`, () => {
		let server: Server;
		let provider: FakeProvider;

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(120_000);
			server = await startServer({ mode });
			provider = await startProvider();
			const admin = await fresh(browser);
			await runWizard(admin, server, {
				mode,
				email: 'admin@example.com',
				signIn: fillSignInStep(provider, { invitedOnly: true })
			});
			await admin.context().close();
		});

		test.afterAll(async () => {
			await server.stop();
			await provider.stop();
		});

		const atSignIn = async (browser: Browser) => {
			const page = await fresh(browser);
			await page.goto(`${server.url}/signin`);
			await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
			return page;
		};

		const expectRefused = async (page: Page, text: string) => {
			await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
			await expect(friendly(page)).toContainText(text);
			await expect.poll(() => new URL(page.url()).search).toBe('');
		};

		test('someone with no invite is told so', async ({ browser }) => {
			const page = await atSignIn(browser);
			provider.who = { sub: 'nobody', email: 'nobody@example.com', email_verified: true };
			await continueWithProvider(page);
			await expectRefused(page, 'only lets invited people in');
			await page.context().close();
		});

		test('a cancelled sign-in says so', async ({ browser }) => {
			const page = await atSignIn(browser);
			provider.denyNext = true;
			await continueWithProvider(page);
			await expectRefused(page, 'cancelled or refused');
			await page.context().close();
		});

		test('a provider that fails says so, and details stay out of the page', async ({ browser }) => {
			const page = await atSignIn(browser);
			provider.refuseTokens = true;
			await continueWithProvider(page);
			await expectRefused(page, 'could not complete the sign-in');
			await expect(friendly(page)).not.toContainText('invalid_client');
			provider.refuseTokens = false;
			await page.context().close();
		});

		test('someone else’s link says nothing to this browser', async ({ browser }) => {
			const page = await fresh(browser);
			await page.goto(`${server.url}/auth/oidc/callback?code=x&state=y`);
			await expectRefused(page, 'took too long or started somewhere else');
			await page.context().close();
		});

		test('an address the provider has not verified links to nothing', async ({ browser }) => {
			const page = await atSignIn(browser);
			provider.who = { sub: 'imposter', email: 'admin@example.com', email_verified: false };
			await continueWithProvider(page);
			await expectRefused(page, 'has not verified your email');
			await page.context().close();
		});

		test('a code it does not know shows nothing of itself', async ({ browser }) => {
			const page = await fresh(browser);
			await page.goto(`${server.url}/signin?sso_error=%3Cb%3Ehello%3C/b%3E`);
			await expectRefused(page, 'Something went wrong');
			await expect(friendly(page)).not.toContainText('hello');
			await page.context().close();
		});

		test('an invite link lets them in through the provider', async ({ browser }) => {
			test.setTimeout(180_000);
			const admin = await fresh(browser);
			await admin.goto(`${server.url}/signin`);
			await signIn(admin);
			const link = await createInvite(admin);
			await admin.context().close();

			const guest = await fresh(browser);
			const sent = captureRequests(guest);
			provider.who = {
				sub: 'guest-sub',
				email: 'guest@example.com',
				email_verified: true,
				preferred_username: 'guest'
			};
			await guest.goto(link);
			await expect(guest.getByRole('heading', { name: 'Create your account' })).toBeVisible();
			await continueWithProvider(guest);
			if (mode === 'e2e') await enrol(guest);
			await expectHome(guest);
			const token = new URL(link).hash.slice(1);
			const urls = sent.map((one) => one.split('\n')[0]);
			expect(urls.filter((url) => url.includes(token))).toEqual([]);
			expect(provider.authorizations.at(-1)?.toString()).not.toContain(token);
			await guest.context().close();
		});

		test('a used invite is refused in words', async ({ browser }) => {
			const page = await fresh(browser);
			await page.goto(`${server.url}/invite#not-a-real-token`);
			await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
			await continueWithProvider(page);
			await expect(friendly(page)).toContainText('not valid');
			await page.context().close();
		});

		test('the first admin still signs in with a passphrase', async ({ browser }) => {
			test.setTimeout(60_000);
			const page = await atSignIn(browser);
			await signIn(page, ADMIN, PASSPHRASE);
			await page.context().close();
		});
	});
}

test.describe.serial('with no keys', () => {
	let server: Server;
	let provider: FakeProvider;
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		test.setTimeout(120_000);
		server = await startServer({ mode: 'none' });
		provider = await startProvider({
			sub: 'dora-sub',
			email: 'dora@example.com',
			email_verified: true,
			preferred_username: 'dora'
		});
		const admin = await fresh(browser);
		await runWizard(admin, server, { mode: 'none', signIn: fillSignInStep(provider) });
		await admin.context().close();
		page = await fresh(browser);
	});

	test.afterAll(async () => {
		await server.stop();
		await provider.stop();
	});

	test('a sign-in goes straight in, with no passphrase and nothing to lock', async () => {
		await page.goto(`${server.url}/signin`);
		await continueWithProvider(page);
		await expectHome(page);
		await page.getByTestId('account-menu').click();
		await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Lock' })).toHaveCount(0);
		await page.keyboard.press('Escape');
	});

	test('settings leave out what it does not have', async () => {
		await page.goto(`${server.url}/settings`);
		await expect(page.getByTestId('sign-in-method')).toHaveAttribute('data-method', 'sso');
		await expect(page.getByRole('region', { name: 'Passphrase' })).toHaveCount(0);
		await expect(page.getByRole('region', { name: 'Recovery key' })).toHaveCount(0);
		await expect(page.getByText('Two-factor sign-in', { exact: true })).toHaveCount(0);
	});

	test('a recent sign-in stands in for a credential', async () => {
		await page.goto(`${server.url}/settings`);
		await page.getByRole('tab', { name: 'Devices' }).click();
		await expect(page.getByTestId('reauth-note')).toBeVisible();
		await page.getByLabel(/^Device name/).fill('tablet');
		await page.getByRole('button', { name: 'Create token' }).click();
		await expect(page.getByText('Copy this token now')).toBeVisible();
	});

	test('an old one goes to sign in again, and back to the same page', async () => {
		test.setTimeout(60_000);
		await page.goto(`${server.url}/settings`);
		await page.getByRole('tab', { name: 'Devices' }).click();
		await page.route(
			'**/api/v1/me/tokens',
			async (route) => {
				if (route.request().method() !== 'POST') return route.fallback();
				await route.fulfill({
					status: 401,
					contentType: 'application/json',
					body: JSON.stringify({ code: 'reauth_required' })
				});
			},
			{ times: 2 }
		);
		await page.getByLabel(/^Device name/).fill('phone');
		const before = provider.authorizations.length;
		await page.getByRole('button', { name: 'Create token' }).click();
		await expect(page.getByText('You signed in again.')).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');
		expect(provider.authorizations.length).toBe(before + 1);
		expect(provider.authorizations.at(-1)?.get('prompt')).toBe('login');
		await page.unroute('**/api/v1/me/tokens');

		await page.getByRole('tab', { name: 'Devices' }).click();
		await page.getByLabel(/^Device name/).fill('phone');
		await page.getByRole('button', { name: 'Create token' }).click();
		await expect(page.getByText('Copy this token now')).toBeVisible();
	});

	test('a local account beside it keeps its passphrase', async ({ browser }) => {
		test.setTimeout(60_000);
		const admin = await fresh(browser);
		await admin.goto(`${server.url}/signin`);
		await signIn(admin);
		await admin.goto(`${server.url}/settings`);
		await expect(admin.getByTestId('sign-in-method')).toHaveAttribute('data-method', 'local');
		await expect(admin.getByRole('region', { name: 'Passphrase' })).toBeVisible();
		await admin.context().close();
	});
});
