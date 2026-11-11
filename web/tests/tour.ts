/**
 * A walk through every screen of the app, the way a person would get to each,
 * stopping at each one for a check: the accessibility and phone specs share it,
 * so that a new screen added here is checked by both.
 */
import { expect, type Browser, type Page } from '@playwright/test';
import { act, clickName, fileBox, openFolder, upload } from './drive';
import { editor, fixture } from './docs';
import {
	accountMenu,
	confirmRecoveryKey,
	createInvite,
	fillAdmin,
	openWizard,
	chooseMode,
	PASSPHRASE,
	signIn,
	submitUnlock
} from './flows';
import { noteEditor, png, reopenNotes } from './notes';
import { openSearch } from './search';
import { grid } from './sheets';
import { makeLink, shareDialog, stranger } from './sharing';
import { startProvider } from './oidc-provider';
import { startServer, type Server } from './server';
import { continueWithProvider, expectEnrolment, fillSignInStep } from './sso';

/** A check made at one screen; `name` says which. */
export type Visit = (page: Page, name: string) => Promise<void>;

const DERIVE = 30_000;

const proceed = (page: Page) => page.getByRole('button', { name: 'Continue' }).click();

/** The drive is ready: its storage card is there, though a phone keeps it in the drawer. */
async function ready(page: Page): Promise<void> {
	await expect(page.getByTestId('storage')).toBeAttached({ timeout: DERIVE });
}

/** After a page load: unlocks if the tab has to, then waits for the drive. */
async function reopen(page: Page): Promise<void> {
	const unlock = page.getByRole('heading', { name: 'Unlock' });
	await expect(unlock.or(page.getByTestId('storage'))).toBeAttached({ timeout: DERIVE });
	if (await unlock.isVisible()) await submitUnlock(page, PASSPHRASE);
	await ready(page);
}

/** Opens a page in a context with the same viewport as `like`, for someone else. */
async function another(browser: Browser, like: Page): Promise<Page> {
	const size = like.viewportSize();
	const page = await stranger(browser);
	if (size) await page.setViewportSize(size);
	return page;
}

/** Every screen of an end-to-end server, from its setup on. */
export async function tour(browser: Browser, page: Page, visit: Visit): Promise<void> {
	const server = await startServer({ mode: 'e2e' });
	const box = await fileBox();
	try {
		await openWizard(page, server);
		await visit(page, 'setup: welcome');
		await proceed(page);
		await expect(page.getByRole('heading', { name: /how files are encrypted/ })).toBeVisible();
		await chooseMode(page, 'e2e');
		await visit(page, 'setup: mode');
		await proceed(page);
		await expect(page.getByRole('heading', { name: /first administrator/ })).toBeVisible();
		await fillAdmin(page);
		await visit(page, 'setup: administrator');
		await proceed(page);
		await expect(page.getByRole('heading', { name: 'Your recovery key' })).toBeVisible();
		await visit(page, 'setup: recovery key');
		await confirmRecoveryKey(page);
		await proceed(page);
		await expect(page.getByRole('heading', { name: 'How people sign in' })).toBeVisible();
		await visit(page, 'setup: sign-in');
		await proceed(page);
		await expect(page.getByRole('heading', { name: 'Review and finish' })).toBeVisible();
		await visit(page, 'setup: review');
		await page.getByRole('button', { name: 'Finish setup' }).click();
		await expect(page.getByRole('heading', { name: 'YonDrive is ready' })).toBeVisible({
			timeout: DERIVE
		});
		await visit(page, 'setup: done');
		await page.getByRole('button', { name: 'Go to sign in' }).click();
		await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
		await visit(page, 'sign in');
		await signIn(page);
		await ready(page);
		await visit(page, 'home, empty');

		await upload(
			page,
			await box.add('notes.txt', Buffer.from('Some words to read.\n')),
			await box.add('picture.png', png(64, 48)),
			await box.add('report.docx', await fixture('report.docx')),
			await box.add('book.xlsx', await fixture('book.xlsx'))
		);
		// From the tile on Home, which a phone shows; the sidebar's New is in its drawer.
		await page
			.getByRole('button', { name: /^New folder/ })
			.first()
			.click();
		const folder = page.getByRole('dialog', { name: 'New folder' });
		await folder.getByLabel('Name').fill('Projects');
		await folder.getByRole('button', { name: 'Create' }).click();
		await expect(folder).toHaveCount(0);
		await visit(page, 'home');
		await openFolder(page, 'Projects');
		await visit(page, 'folder');
		// By address rather than through the sidebar, which a phone keeps in a drawer.
		await page.goto(server.url);
		await reopen(page);

		await clickName(page, 'notes.txt');
		await expect(page.getByTestId('viewer-text')).toBeVisible({ timeout: DERIVE });
		await visit(page, 'viewer: text');
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await clickName(page, 'picture.png');
		await expect(page.getByTestId('viewer').getByRole('img')).toBeVisible({ timeout: DERIVE });
		await visit(page, 'viewer: image');
		await page.getByRole('button', { name: 'Close', exact: true }).click();

		await act(page, 'notes.txt', 'Share');
		const dialog = shareDialog(page, 'notes.txt');
		await expect(dialog).toBeVisible();
		await visit(page, 'share dialog: people');
		await dialog.getByRole('tab', { name: 'Public link' }).click();
		await visit(page, 'share dialog: public link');
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		const link = await makeLink(page, 'notes.txt', { password: 'open sesame with letters' });

		await act(page, 'notes.txt', 'Versions');
		await expect(page.getByRole('complementary', { name: 'Versions of notes.txt' })).toBeVisible();
		await visit(page, 'versions');
		await page.getByRole('button', { name: 'Close versions' }).click();

		await openSearch(page, 'notes');
		await visit(page, 'search palette');
		await page.keyboard.press('Escape');

		await clickName(page, 'report.docx');
		await expect(editor(page)).toBeVisible({ timeout: DERIVE });
		await visit(page, 'document editor');
		await page.goBack();
		await ready(page);

		await clickName(page, 'book.xlsx');
		await expect(grid(page)).toBeVisible({ timeout: DERIVE });
		await visit(page, 'sheet editor');
		await page.goBack();
		await ready(page);

		await act(page, 'Projects', 'Move to trash');
		await page.goto(`${server.url}/trash`);
		await reopen(page);
		await expect(page.getByText('Projects', { exact: true })).toBeVisible();
		await visit(page, 'trash');
		for (const [path, name] of [
			['/shared', 'shared with me'],
			['/shared/by-me', 'shared by me'],
			['/recent', 'recent'],
			['/favorites', 'favorites']
		]) {
			await page.goto(`${server.url}${path}`);
			await reopen(page);
			await visit(page, name);
		}

		await page.goto(`${server.url}/settings`);
		await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
			timeout: DERIVE
		});
		await visit(page, 'settings');
		await page.getByRole('tab', { name: 'Devices' }).click();
		await visit(page, 'settings: devices');
		await page.getByRole('button', { name: 'Add a device' }).click();
		const adding = page.getByRole('dialog', { name: 'Add a device' });
		await visit(page, 'add a device: passphrase');
		await adding.getByLabel(/^Your passphrase/).fill(PASSPHRASE);
		await adding.getByRole('button', { name: 'Continue' }).click();
		await expect(adding.getByRole('heading', { name: 'Scan with your phone' })).toBeVisible({
			timeout: DERIVE
		});
		await visit(page, 'add a device: code');
		await adding.getByRole('button', { name: 'Cancel' }).click();
		await expect(adding).toHaveCount(0);

		const invite = await createInvite(page);
		for (const tab of ['Users', 'Invites', 'Server', 'Sign-in', 'Audit']) {
			await page.getByRole('tab', { name: tab }).click();
			await visit(page, `admin: ${tab}`);
		}

		await page.goto(server.url);
		await reopen(page);
		await page.goto(`${server.url}/notes`);
		await reopenNotes(page);
		await page.getByLabel('Quick note').fill('Call the plumber');
		await page.getByLabel('Quick note').press('Enter');
		await expect(page.getByTestId('note-card')).toHaveCount(1);
		await visit(page, 'notes list');
		await page.getByTestId('note-card').first().click();
		await expect(noteEditor(page)).toBeVisible({ timeout: DERIVE });
		await visit(page, 'note editor');

		await page.goto(server.url);
		await reopen(page);
		await accountMenu(page, 'Lock');
		await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
		await visit(page, 'unlock');
		await submitUnlock(page, PASSPHRASE);
		await ready(page);

		const guest = await another(browser, page);
		await guest.goto(invite);
		await expect(guest.getByRole('heading', { name: 'Create your account' })).toBeVisible();
		await visit(guest, 'invite');
		await guest.goto(link);
		await expect(guest.getByLabel(/password/i).first()).toBeVisible({ timeout: DERIVE });
		await visit(guest, 'public link: password');
		await guest
			.getByLabel(/password/i)
			.first()
			.fill('open sesame with letters');
		await guest
			.getByLabel(/password/i)
			.first()
			.press('Enter');
		await expect(guest.getByText('notes.txt').first()).toBeVisible({ timeout: DERIVE });
		await visit(guest, 'public link: open');
		await guest.goto(`${server.url}/recover`);
		await expect(guest.getByRole('heading').first()).toBeVisible();
		await visit(guest, 'recover');
		await guest.goto(`${server.url}/pair#1.${'0'.repeat(32)}.${'A'.repeat(43)}`);
		await expect(guest.getByRole('heading', { name: 'Add this device' })).toBeVisible();
		await visit(guest, 'pair');
		await guest.context().close();
	} finally {
		await box.remove();
		await server.stop();
	}
}

/** The one screen only single sign-on reaches: a first sign-in choosing its passphrase. */
export async function tourEnrol(browser: Browser, page: Page, visit: Visit): Promise<void> {
	const server: Server = await startServer({ mode: 'e2e' });
	const provider = await startProvider({
		sub: 'alice-sub',
		email: 'alice@example.com',
		email_verified: true,
		preferred_username: 'alice'
	});
	try {
		const admin = await another(browser, page);
		await openWizard(admin, server);
		await proceed(admin);
		await chooseMode(admin, 'e2e');
		await proceed(admin);
		await fillAdmin(admin);
		await proceed(admin);
		await confirmRecoveryKey(admin);
		await proceed(admin);
		await fillSignInStep(provider)(admin);
		await visit(admin, 'setup: sign-in with a provider');
		await proceed(admin);
		await admin.getByRole('button', { name: 'Finish setup' }).click();
		await expect(admin.getByRole('heading', { name: 'YonDrive is ready' })).toBeVisible({
			timeout: DERIVE
		});
		await admin.context().close();
		await page.goto(server.url);
		await expect(page.getByRole('button', { name: 'Continue with Fake ID' })).toBeVisible();
		await visit(page, 'sign in with a provider');
		await continueWithProvider(page);
		await expectEnrolment(page);
		await visit(page, 'enrol');
	} finally {
		await server.stop();
		await provider.stop();
	}
}
