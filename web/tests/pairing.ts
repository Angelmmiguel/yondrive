/**
 * A phone for the browser specs: it scans the code the web app shows, by reading
 * its link or by decoding the picture, and talks to the server from the test
 * runner as a native app would, with the app's own crypto.
 */
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { decodeBase64, encodeBase64 } from '../src/lib/crypto/encoding';
import { deriveRoot, expandRoot, parseKdfParams } from '../src/lib/crypto/kdf';
import type { KeyPair } from '../src/lib/crypto/keys';
import {
	generatePairingKeys,
	openPairingPayload,
	pairingCode,
	parsePairingLink,
	type PairingPayload
} from '../src/lib/crypto/pairing';
import { PASSPHRASE } from './flows';
import type { Server } from './server';

/** Opens Settings → Devices → Add a device and confirms the passphrase; returns the dialog. */
export async function openAddDevice(
	page: Page,
	server: Server,
	passphrase = PASSPHRASE
): Promise<Locator> {
	await page.goto(`${server.url}/settings`);
	await page.getByRole('tab', { name: 'Devices' }).click();
	await page.getByRole('button', { name: 'Add a device' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add a device' });
	await dialog.getByLabel(/^Your passphrase/).fill(passphrase);
	await dialog.getByRole('button', { name: 'Continue' }).click();
	await expect(dialog.getByRole('heading', { name: 'Scan with your phone' })).toBeVisible({
		timeout: 30_000
	});
	return dialog;
}

/** The link the code carries, as the page states it. */
export async function codeLink(dialog: Locator): Promise<string> {
	const link = await dialog.locator('svg[data-pairing-link]').getAttribute('data-pairing-link');
	expect(link).not.toBeNull();
	return link!;
}

/**
 * What a camera would read off the code on screen: a picture of it, decoded in a
 * page of its own, where nothing of the app's applies.
 */
export async function scanCode(browser: Browser, dialog: Locator): Promise<string> {
	const shot = await dialog.locator('svg[data-pairing-link]').screenshot();
	const blank = await browser.newPage();
	try {
		const { width, height, pixels } = await blank.evaluate(async (png) => {
			const image = new Image();
			image.src = `data:image/png;base64,${png}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext('2d')!;
			context.drawImage(image, 0, 0);
			const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
			return { width: canvas.width, height: canvas.height, pixels: Array.from(data) };
		}, shot.toString('base64'));
		const found = jsQR(Uint8ClampedArray.from(pixels), width, height);
		expect(found).not.toBeNull();
		return found!.data;
	} finally {
		await blank.close();
	}
}

/** A phone in the middle of pairing. */
export class Phone {
	readonly keys: KeyPair = generatePairingKeys();
	readonly origin: string;
	readonly pairingId: string;
	readonly browserKey: Uint8Array;

	constructor(link: string) {
		const parsed = parsePairingLink(link);
		expect(parsed).not.toBeNull();
		this.origin = parsed!.origin;
		this.pairingId = parsed!.pairingId;
		this.browserKey = parsed!.browserKey;
	}

	/** The six digits this phone shows once it has claimed the code. */
	get code(): string {
		return pairingCode(this.browserKey, this.keys.publicKey, this.pairingId);
	}

	/** Claims the code; returns the status of the answer. */
	async claim(name: string, platform = 'ios'): Promise<Response> {
		return fetch(`${this.origin}/api/v1/pairings/${this.pairingId}/claim`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: encodeBase64(this.keys.publicKey), name, platform })
		});
	}

	poll(): Promise<Response> {
		return fetch(`${this.origin}/api/v1/pairings/${this.pairingId}`);
	}

	/** Collects the sealed payload once the browser has confirmed, and opens it. */
	async collect(): Promise<PairingPayload> {
		let sealed = '';
		await expect
			.poll(async () => {
				const res = await this.poll();
				const body = (await res.json()) as { status?: string; sealed_payload?: string };
				sealed = body.sealed_payload ?? '';
				return body.status;
			})
			.toBe('confirmed');
		return openPairingPayload(this.keys, this.browserKey, this.pairingId, decodeBase64(sealed));
	}

	/** A request as the paired app makes it. */
	call(path: string, token: string): Promise<Response> {
		return fetch(`${this.origin}/api/v1${path}`, {
			headers: { Authorization: `Bearer ${token}` }
		});
	}
}

/**
 * A phone signing in with the username and passphrase, as a native app does: the
 * KDF runs here, and only the auth key leaves. Returns the answer's body, with the
 * KEK for opening the master key.
 */
export async function signInDevice(
	origin: string,
	username: string,
	passphrase: string
): Promise<{
	status: number;
	body: {
		account: { keys?: { wrapped_master_key: string } };
		token: { origin: string; platform?: string; current?: boolean };
		secret: string;
	};
	kek: Uint8Array;
}> {
	const kdf = await (
		await fetch(`${origin}/api/v1/auth/kdf?username=${encodeURIComponent(username)}`)
	).json();
	const root = deriveRoot(passphrase, parseKdfParams(kdf));
	const { kek, authKey } = expandRoot(root);
	const res = await fetch(`${origin}/api/v1/auth/device-login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username,
			auth_key: encodeBase64(authKey),
			device: { name: 'Angel’s tablet', platform: 'android' }
		})
	});
	return { status: res.status, body: await res.json(), kek };
}
