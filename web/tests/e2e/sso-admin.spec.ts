/** Setting up a provider in the wizard and looking after it from administration, in both modes. */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN, expectHome, PASSPHRASE, setUpServer, signIn } from '../flows';
import { CLIENT_ID, CLIENT_SECRET, startProvider, type FakeProvider } from '../oidc-provider';
import { captureRequests } from '../scan';
import { startServer, type Mode, type Server } from '../server';
import { enrol, friendly } from '../sso';

const fresh = async (browser: Browser) => (await browser.newContext()).newPage();

for (const mode of ['e2e', 'none'] as Mode[]) {
	test.describe.serial(`in mode ${mode}`, () => {
		let server: Server;
		let provider: FakeProvider;
		let admin: Page;

		test.beforeAll(async ({ browser }) => {
			server = await startServer({ mode });
			provider = await startProvider({
				sub: 'user-sub',
				email: 'user@example.com',
				email_verified: true,
				preferred_username: 'user'
			});
			admin = await fresh(browser);
		});

		test.afterAll(async () => {
			await server.stop();
			await provider.stop();
		});

		test('the wizard guides, tests and stores a provider', async () => {
			test.setTimeout(180_000);
			const sent = captureRequests(admin);
			await setUpServer(admin, server, {
				mode,
				signIn: async (page) => {
					const nav = page.getByRole('navigation', { name: 'Setup steps' });
					await expect(nav.getByRole('button')).toHaveText(
						mode === 'e2e'
							? [
									/Server/,
									/Encryption/,
									/Admin account/,
									/Recovery key/,
									/Sign-in methods/,
									/Review/
								]
							: [/Server/, /Encryption/, /Admin account/, /Sign-in methods/, /Review/]
					);
					// One way to sign in has to stay on.
					await page.getByRole('switch', { name: 'Local accounts' }).click();
					await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
					await page.getByRole('switch', { name: 'Local accounts' }).click();

					await page.getByRole('switch', { name: 'Single sign-on' }).click();
					await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

					// The guide follows the card, with the live redirect URI in it.
					const guide = page.getByRole('complementary', { name: 'Provider guide' });
					const redirect = `${server.url}/auth/oidc/callback`;
					await expect(page.getByTestId('redirect-uri')).toHaveValue(redirect);
					for (const [name, issuer] of [
						['Authelia', 'https://auth.example.com'],
						['Authentik', 'https://authentik.example.com/application/o/yondrive/'],
						['Keycloak', 'https://keycloak.example.com/realms/home'],
						['Pocket ID', 'https://id.example.com']
					]) {
						await page.getByRole('radio', { name: new RegExp(name) }).click();
						await expect(guide).toContainText(redirect);
						await expect(page.getByLabel(/^Issuer URL/)).toHaveValue(issuer);
						await expect(page.getByLabel(/^Button label/)).toHaveValue(name);
					}

					// A test that fails does so in words.
					await page.getByRole('radio', { name: /Other/ }).click();
					await page.getByLabel(/^Issuer URL/).fill(provider.issuer);
					await page.getByRole('button', { name: 'Test connection' }).click();
					await expect(friendly(page)).toContainText('not a usable issuer');

					await page.getByRole('switch', { name: 'Allow an insecure issuer' }).click();
					await page.getByLabel(/^Issuer URL/).fill(`${provider.issuer}/nope`);
					await page.getByRole('button', { name: 'Test connection' }).click();
					await expect(friendly(page)).toContainText('could not read');

					await page.getByLabel(/^Issuer URL/).fill(provider.issuer);
					await page.getByRole('button', { name: 'Test connection' }).click();
					await expect(page.getByTestId('oidc-test-ok')).toContainText(
						'authorize, token, userinfo and JWKS endpoints found'
					);

					await page.getByLabel(/^Button label/).fill('Fake ID');
					await page.getByLabel(/^Client ID/).fill(CLIENT_ID);
					await page.getByLabel(/^Client secret/).fill(CLIENT_SECRET);
				}
			});
			expect(sent.some((one) => one.startsWith('POST') && one.includes('/api/v1/oidc/test'))).toBe(
				true
			);
			await expect(admin.getByRole('button', { name: 'Continue with Fake ID' })).toBeVisible();
			await signIn(admin);
		});

		const atSignInTab = async () => {
			await admin.goto(`${server.url}/admin`);
			await admin.getByRole('tab', { name: 'Sign-in' }).click();
			await expect(admin.getByRole('region', { name: 'Sign-in settings' })).toBeVisible();
		};

		test('its settings show what was set, and never the secret', async () => {
			await atSignInTab();
			await expect(admin.getByLabel(/^Issuer URL/)).toHaveValue(provider.issuer);
			await expect(admin.getByLabel(/^Client secret/)).toHaveValue('');
			await expect(admin.getByText('Stored. Leave blank to keep it.')).toBeVisible();
			await expect(admin.getByTestId('redirect-uri')).toHaveValue(
				`${server.url}/auth/oidc/callback`
			);
			await admin.getByRole('button', { name: 'Test connection' }).click();
			await expect(admin.getByTestId('oidc-test-ok')).toContainText('Discovery OK');
		});

		test('a change needs the passphrase, and a blank secret keeps the stored one', async ({
			browser
		}) => {
			test.setTimeout(120_000);
			await atSignInTab();
			await admin.getByLabel(/^Button label/).fill('Renamed ID');
			await admin.getByLabel(/^Your passphrase/).fill('not the right passphrase at all');
			await admin.getByRole('button', { name: 'Save sign-in settings' }).click();
			await expect(friendly(admin)).toContainText('not correct', { timeout: 30_000 });

			await admin.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
			await admin.getByRole('button', { name: 'Save sign-in settings' }).click();
			await expect(admin.getByText('Sign-in settings saved.')).toBeVisible({ timeout: 30_000 });
			await expect(admin.getByLabel(/^Your passphrase/)).toHaveValue('');

			const visitor = await fresh(browser);
			await visitor.goto(`${server.url}/signin`);
			await expect(visitor.getByRole('button', { name: 'Continue with Renamed ID' })).toBeVisible();
			// The secret is still good: the token endpoint would refuse otherwise.
			await visitor.getByRole('button', { name: 'Continue with Renamed ID' }).click();
			if (mode === 'e2e') await enrol(visitor);
			await expectHome(visitor);
			await visitor.context().close();
		});

		test('users show who came from the provider, and an identity can be unlinked', async () => {
			test.setTimeout(60_000);
			await admin.goto(`${server.url}/admin`);
			const row = admin.getByTestId('users').locator('li').filter({ hasText: 'user' }).filter({
				hasText: 'Single sign-on'
			});
			await expect(row).toBeVisible();
			await expect(row.getByRole('button', { name: 'Reset password' })).toHaveCount(0);
			await row.getByRole('button', { name: 'Unlink identity' }).click();
			const dialog = admin.getByRole('dialog', { name: /Unlink/ });
			await dialog.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
			await dialog.getByRole('button', { name: 'Unlink' }).click();
			await expect(dialog).toHaveCount(0, { timeout: 30_000 });
			// It keeps only its provider, so it stays a single sign-on account, ready to link again.
			await expect(row).toBeVisible();
		});

		test('history asks for the passphrase only to shorten what matters', async () => {
			test.setTimeout(60_000);
			await atSignInTab();
			const history = admin.getByRole('region', { name: 'History' });
			await history.getByLabel(/^Change journal/).fill('30');
			await expect(history.getByLabel(/^Your passphrase/)).toHaveCount(0);
			await history.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(admin.getByText('Settings saved.')).toBeVisible();

			await history.getByLabel(/^Audit trail/).fill('10');
			await expect(history.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
			await history.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
			await history.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(history.getByLabel(/^Your passphrase/)).toHaveCount(0, { timeout: 30_000 });
			await expect(history.getByLabel(/^Audit trail/)).toHaveValue('10');
		});

		test('the audit tab pages through what happened', async () => {
			await admin.goto(`${server.url}/admin`);
			await admin.getByRole('tab', { name: 'Audit' }).click();
			const audit = admin.getByTestId('audit');
			await expect(audit).toContainText('sso_login_succeeded');
			await expect(audit).toContainText('sso_identity_unlinked');
			await expect(audit).toContainText(ADMIN);
			// Far from a page yet, so nothing to ask for.
			await expect(admin.getByRole('button', { name: 'Older entries' })).toHaveCount(0);
		});

		test('health shows the backup and the disk, and warns of an untrusted proxy', async () => {
			await admin.goto(`${server.url}/admin`);
			await admin.getByRole('tab', { name: 'Server' }).click();
			await expect(admin.getByTestId('last-backup')).toContainText('Never');
			await expect(admin.getByTestId('admin-health')).toContainText('Free disk');
			await expect(admin.getByText('not trusted')).toHaveCount(0);

			await admin.setExtraHTTPHeaders({ 'X-Forwarded-Proto': 'https' });
			await admin.reload();
			await admin.getByRole('tab', { name: 'Server' }).click();
			await expect(admin.getByText(/proxied by an address that is not trusted/)).toBeVisible();
			await admin.setExtraHTTPHeaders({});
		});

		test('local accounts can go off, and leave the first admin a way in', async ({ browser }) => {
			test.setTimeout(120_000);
			await atSignInTab();
			await admin.getByRole('switch', { name: 'Local accounts' }).click();
			await admin.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
			await admin.getByRole('button', { name: 'Save sign-in settings' }).click();
			await expect(admin.getByText('Sign-in settings saved.')).toBeVisible({ timeout: 30_000 });

			const visitor = await fresh(browser);
			await visitor.goto(`${server.url}/signin`);
			const provider_ = visitor.getByRole('button', { name: 'Continue with Renamed ID' });
			await expect(provider_).toBeVisible();
			await expect(visitor.getByLabel(/^Username/)).toHaveCount(0);
			await expect(visitor.getByRole('link', { name: 'Create an account' })).toHaveCount(0);
			await visitor.getByRole('button', { name: /Administrator/ }).click();
			await signIn(visitor);
			await visitor.context().close();
		});
	});
}
