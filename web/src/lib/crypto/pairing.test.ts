import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { seal, SealError } from './aead';
import { encodeBase64, encodeFields, utf8 } from './encoding';
import { expand } from './kdf';
import { generateMasterKey } from './keys';
import {
	encodePairingLink,
	generatePairingKeys,
	newTokenSecret,
	openPairingPayload,
	pairingCode,
	parsePairingLink,
	sealPairingPayload,
	tokenHash,
	type PairingPayload
} from './pairing';
import { SUITE_E2E, SUITE_NONE } from './sealer';

const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const otherId = '0123456789abcdef0123456789abcdef';

describe('pairing', () => {
	it('opens on the device what the browser sealed, in both suites', () => {
		const browser = generatePairingKeys();
		const device = generatePairingKeys();
		const payloads: PairingPayload[] = [
			{
				v: 1,
				suite: SUITE_E2E,
				token: newTokenSecret(),
				master_key: encodeBase64(generateMasterKey())
			},
			{ v: 1, suite: SUITE_NONE, token: newTokenSecret() }
		];
		for (const payload of payloads) {
			const sealed = sealPairingPayload(browser, device.publicKey, id, payload);
			expect(openPairingPayload(device, browser.publicKey, id, sealed)).toEqual(payload);
		}
	});

	it('does not open with another browser key, device key or pairing', () => {
		const browser = generatePairingKeys();
		const device = generatePairingKeys();
		const stranger = generatePairingKeys();
		const sealed = sealPairingPayload(browser, device.publicKey, id, {
			v: 1,
			suite: SUITE_NONE,
			token: 'secret'
		});
		expect(() => openPairingPayload(device, stranger.publicKey, id, sealed)).toThrow(SealError);
		expect(() => openPairingPayload(stranger, browser.publicKey, id, sealed)).toThrow(SealError);
		expect(() => openPairingPayload(device, browser.publicKey, otherId, sealed)).toThrow(SealError);
		expect(() => openPairingPayload(device, new Uint8Array(32), id, sealed)).toThrow(SealError);
	});

	it('refuses a payload whose version, suite or master key is wrong', () => {
		const browser = generatePairingKeys();
		const device = generatePairingKeys();
		const raw = (json: string) => {
			const shared = x25519.getSharedSecret(browser.privateKey, device.publicKey);
			const wrap = expand(
				shared,
				encodeFields('yondrive/pairing/key/v1', browser.publicKey, device.publicKey)
			);
			const aad = encodeFields(
				'yondrive/pairing/payload/v1',
				browser.publicKey,
				device.publicKey,
				utf8(id)
			);
			return seal(wrap, utf8(json), aad);
		};
		const master = encodeBase64(generateMasterKey());
		for (const json of [
			'{"v":2,"suite":"none","token":"t"}',
			'{"v":1,"suite":"rot13","token":"t"}',
			'{"v":1,"suite":"none","token":""}',
			`{"v":1,"suite":"none","token":"t","master_key":"${master}"}`,
			'{"v":1,"suite":"xchacha20poly1305-v1","token":"t"}',
			'{"v":1,"suite":"xchacha20poly1305-v1","token":"t","master_key":"AAAA"}',
			'not json',
			'null'
		]) {
			expect(() => openPairingPayload(device, browser.publicKey, id, raw(json)), json).toThrow(
				SealError
			);
		}
	});

	it('shows six digits that change with any input', () => {
		const b = generatePairingKeys().publicKey;
		const d = generatePairingKeys().publicKey;
		const code = pairingCode(b, d, id);
		expect(code).toMatch(/^\d{6}$/);
		expect(pairingCode(b, d, id)).toBe(code);
		const others = [
			pairingCode(generatePairingKeys().publicKey, d, id),
			pairingCode(b, generatePairingKeys().publicKey, id),
			pairingCode(b, d, otherId)
		];
		// One in a million may collide; three at once do not.
		expect(others.every((other) => other === code)).toBe(false);
	});

	it('draws 43-character token secrets and hashes them', () => {
		const secret = newTokenSecret();
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(newTokenSecret()).not.toBe(secret);
		expect(tokenHash(secret)).toHaveLength(32);
	});

	it('round-trips a link and refuses anything else', () => {
		const key = generatePairingKeys().publicKey;
		const link = encodePairingLink('https://drive.example.com', id, key);
		expect(link.length).toBeLessThan(140);
		expect(parsePairingLink(link)).toEqual({
			origin: 'https://drive.example.com',
			pairingId: id,
			browserKey: key
		});
		const fragment = link.split('#')[1];
		const zeros = 'A'.repeat(43);
		for (const bad of [
			`https://drive.example.com/pair#2.${fragment.slice(2)}`,
			`https://drive.example.com/pair#1.${id.toUpperCase()}.${fragment.split('.')[2]}`,
			`https://drive.example.com/pair#1.${id.slice(1)}.${fragment.split('.')[2]}`,
			`https://drive.example.com/pair#1.${id}.${fragment.split('.')[2].slice(1)}`,
			`https://drive.example.com/pair#1.${id}.${zeros}`,
			`https://drive.example.com/pair#${fragment}.x`,
			`https://drive.example.com/other#${fragment}`,
			`ftp://drive.example.com/pair#${fragment}`,
			'not a url'
		]) {
			expect(parsePairingLink(bad), bad).toBeNull();
		}
	});
});
