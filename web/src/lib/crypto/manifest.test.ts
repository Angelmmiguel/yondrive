import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { SealError } from './aead';
import { generateIdentity } from './keys';
import { signVersion, verifyVersion, versionMessage, type VersionManifest } from './manifest';
import { ZeroKeyError } from './random';

const author = generateIdentity().ed25519;
const manifest: VersionManifest = {
	nodeId: 'n1',
	versionId: 'v1',
	suite: 'xchacha20poly1305-v1',
	size: 5000,
	frameSize: 1024,
	frameCount: 5,
	contentHash: new Uint8Array(32).fill(9)
};
const signature = signVersion(manifest, author.privateKey);

function verifyCode(m: VersionManifest, sig: Uint8Array, key: Uint8Array): string | null {
	try {
		verifyVersion(m, sig, key);
		return null;
	} catch (e) {
		if (e instanceof SealError) return e.code;
		throw e;
	}
}

describe('signVersion and verifyVersion', () => {
	it('accepts what was signed', () => {
		expect(verifyCode(manifest, signature, author.publicKey)).toBeNull();
	});

	it.each([
		['node', { nodeId: 'n2' }],
		['version', { versionId: 'v2' }],
		['suite', { suite: 'none' }],
		['size', { size: 5001 }],
		['frame size', { frameSize: 2048 }],
		['frame count', { frameCount: 6 }],
		['content hash', { contentHash: new Uint8Array(32).fill(8) }]
	])('refuses a changed %s', (_, change) => {
		expect(verifyCode({ ...manifest, ...change }, signature, author.publicKey)).toBe('signature');
	});

	it('refuses another author', () => {
		expect(verifyCode(manifest, signature, generateIdentity().ed25519.publicKey)).toBe('signature');
	});

	it('refuses a malformed signature or key', () => {
		expect(verifyCode(manifest, signature.subarray(1), author.publicKey)).toBe('signature');
		expect(verifyCode(manifest, signature, new Uint8Array(0))).toBe('signature');
		expect(verifyCode(manifest, new Uint8Array(0), author.publicKey)).toBe('signature');
	});

	it('refuses a signature with S not reduced, which is malleable', () => {
		const order = 2n ** 252n + 27742317777372353535851937790883648493n;
		const raised =
			BigInt(`0x${Buffer.from(signature.subarray(32)).reverse().toString('hex')}`) + order;
		const malleable = Uint8Array.from(signature);
		malleable.set(Buffer.from(raised.toString(16).padStart(64, '0'), 'hex').reverse(), 32);

		expect(verifyCode(manifest, malleable, author.publicKey)).toBe('signature');
	});

	it('refuses a zeroed key and a wrong-size content hash', () => {
		expect(() => signVersion(manifest, new Uint8Array(32))).toThrow(ZeroKeyError);
		expect(() => versionMessage({ ...manifest, contentHash: new Uint8Array(31) })).toThrow(
			SealError
		);
	});

	it('signs the documented bytes', () => {
		expect(
			ed25519.verify(signature, versionMessage(manifest), author.publicKey, { zip215: false })
		).toBe(true);
		expect(versionMessage({ ...manifest, size: 2 ** 40 })).not.toEqual(versionMessage(manifest));
	});
});
