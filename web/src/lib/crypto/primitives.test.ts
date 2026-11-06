/**
 * Known answers from the RFCs for the primitives no other test file pins,
 * through the same library entry points the constructions use.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { utf8 } from './encoding';

describe('SHA-2', () => {
	it('sha256 reproduces the FIPS 180 "abc" vector', () => {
		expect(bytesToHex(sha256(utf8('abc')))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('sha512 reproduces the FIPS 180 "abc" vector', () => {
		expect(bytesToHex(sha512(utf8('abc')))).toBe(
			'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
				'2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'
		);
	});
});

describe('HMAC-SHA256', () => {
	it('reproduces RFC 4231 test case 1', () => {
		expect(bytesToHex(hmac(sha256, new Uint8Array(20).fill(0x0b), utf8('Hi There')))).toBe(
			'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
		);
	});

	it('reproduces RFC 4231 test case 2', () => {
		expect(bytesToHex(hmac(sha256, utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
			'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
		);
	});
});

describe('X25519', () => {
	const alice = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
	const alicePublic = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
	const bob = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
	const bobPublic = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
	const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

	it('reproduces the RFC 7748 §6.1 exchange', () => {
		expect(bytesToHex(x25519.getPublicKey(hexToBytes(alice)))).toBe(alicePublic);
		expect(bytesToHex(x25519.getPublicKey(hexToBytes(bob)))).toBe(bobPublic);
		expect(bytesToHex(x25519.getSharedSecret(hexToBytes(alice), hexToBytes(bobPublic)))).toBe(
			shared
		);
		expect(bytesToHex(x25519.getSharedSecret(hexToBytes(bob), hexToBytes(alicePublic)))).toBe(
			shared
		);
	});

	it('reproduces the RFC 7748 §5.2 scalar multiplication', () => {
		expect(
			bytesToHex(
				x25519.scalarMult(
					hexToBytes('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
					hexToBytes('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
				)
			)
		).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
	});
});

describe('Ed25519', () => {
	const cases = [
		{
			name: 'test 1',
			secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
			publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
			message: '',
			signature:
				'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
				'5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
		},
		{
			name: 'test 2',
			secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
			publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
			message: '72',
			signature:
				'92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
				'085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
		}
	];

	it.each(cases)('reproduces RFC 8032 §7.1 $name', ({ secret, publicKey, message, signature }) => {
		const msg = hexToBytes(message);

		expect(bytesToHex(ed25519.getPublicKey(hexToBytes(secret)))).toBe(publicKey);
		expect(bytesToHex(ed25519.sign(msg, hexToBytes(secret)))).toBe(signature);
		expect(
			ed25519.verify(hexToBytes(signature), msg, hexToBytes(publicKey), { zip215: false })
		).toBe(true);
	});
});
