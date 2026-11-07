/** What the single sign-on specs do through the app. */
import { expect, type Page } from '@playwright/test';
import { confirmRecoveryKey } from './flows';
import { CLIENT_ID, CLIENT_SECRET, type FakeProvider } from './oidc-provider';

export const UNLOCK = 'an unlock passphrase nobody else knows';

const DERIVE = 30_000;

/** Fills the wizard's sign-in step for this provider, with its connection tested. */
export function fillSignInStep(
	provider: FakeProvider,
	options: { localOff?: boolean; invitedOnly?: boolean; adminGroup?: string } = {}
) {
	return async (page: Page): Promise<void> => {
		await page.getByRole('switch', { name: 'Single sign-on' }).click();
		await page.getByRole('radio', { name: /Other/ }).click();
		await page.getByLabel(/^Button label/).fill('Fake ID');
		await page.getByLabel(/^Issuer URL/).fill(provider.issuer);
		await page.getByLabel(/^Client ID/).fill(CLIENT_ID);
		await page.getByLabel(/^Client secret/).fill(CLIENT_SECRET);
		await page.getByRole('switch', { name: 'Allow an insecure issuer' }).click();
		if (options.adminGroup) await page.getByLabel(/^Admin group/).fill(options.adminGroup);
		if (options.invitedOnly) {
			await page.getByLabel(/^New users from SSO/).selectOption('invited');
		}
		if (options.localOff) await page.getByRole('switch', { name: 'Local accounts' }).click();
		await page.getByRole('button', { name: 'Test connection' }).click();
		await expect(page.getByTestId('oidc-test-ok')).toContainText('Discovery OK');
	};
}

/** The sign-in page's button. Comes back on the home page, the enrol page or a locked one. */
export async function continueWithProvider(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Continue with Fake ID' }).click();
}

export async function expectEnrolment(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Choose an unlock passphrase' })).toBeVisible();
}

/** Chooses the passphrase and types the words back. Returns the words. */
export async function enrol(page: Page, passphrase: string = UNLOCK): Promise<string[]> {
	await expectEnrolment(page);
	await page.getByLabel(/^Unlock passphrase/).fill(passphrase);
	await page.getByLabel(/^Confirm unlock passphrase/).fill(passphrase);
	await page.getByRole('button', { name: 'Continue' }).click();
	const words = await confirmRecoveryKey(page);
	await page.getByRole('button', { name: 'Finish' }).click();
	await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible({ timeout: DERIVE });
	return words;
}

export async function unlockWith(page: Page, passphrase: string = UNLOCK): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
	await page.getByLabel(/^Unlock passphrase/).fill(passphrase);
	await page.getByRole('button', { name: 'Unlock' }).click();
}

export const friendly = (page: Page) => page.getByRole('alert');
