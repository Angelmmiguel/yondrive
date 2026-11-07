/**
 * Writes docs/crypto-vectors.json. This implements docs/CRYPTO.md from scratch on
 * node:crypto, importing nothing from src/lib/crypto and none of its ciphers or
 * curves, so that the vitest comparing that code against the file compares two
 * implementations. Argon2id is the exception, as Node 22 lacks it.
 *
 *   node web/scripts/crypto-vectors.mjs > docs/crypto-vectors.json
 */
import { argon2id } from '@noble/hashes/argon2.js';
import {
	createCipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	hkdfSync,
	sign
} from 'node:crypto';
import { strict as assert } from 'node:assert';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => Buffer.from(text, 'hex');
const utf8 = (text) => Buffer.from(text, 'utf8');
const sha256 = (...parts) => {
	const hash = createHash('sha256');
	for (const part of parts) hash.update(part);
	return hash.digest();
};

/** Fixed input bytes: never zero, never random, different per seed. */
const bytes = (seed, length) =>
	Buffer.from(Array.from({ length }, (_, i) => ((seed * 31 + i * 7) % 255) + 1));

const u32 = (value) => {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(value);
	return out;
};
const u64 = (value) => {
	const out = Buffer.alloc(8);
	out.writeBigUInt64BE(BigInt(value));
	return out;
};
const fields = (label, ...parts) =>
	Buffer.concat([utf8(label), ...parts].flatMap((part) => [u32(part.length), part]));

const hkdf = (key, info) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));

function hchacha20(key, nonce) {
	const state = new Uint32Array(16);
	state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
	for (let i = 0; i < 8; i++) state[4 + i] = key.readUInt32LE(i * 4);
	for (let i = 0; i < 4; i++) state[12 + i] = nonce.readUInt32LE(i * 4);
	const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
	const quarter = (a, b, c, d) => {
		state[a] += state[b];
		state[d] = rotl(state[d] ^ state[a], 16);
		state[c] += state[d];
		state[b] = rotl(state[b] ^ state[c], 12);
		state[a] += state[b];
		state[d] = rotl(state[d] ^ state[a], 8);
		state[c] += state[d];
		state[b] = rotl(state[b] ^ state[c], 7);
	};
	for (let round = 0; round < 10; round++) {
		quarter(0, 4, 8, 12);
		quarter(1, 5, 9, 13);
		quarter(2, 6, 10, 14);
		quarter(3, 7, 11, 15);
		quarter(0, 5, 10, 15);
		quarter(1, 6, 11, 12);
		quarter(2, 7, 8, 13);
		quarter(3, 4, 9, 14);
	}
	const out = Buffer.alloc(32);
	[0, 1, 2, 3, 12, 13, 14, 15].forEach((word, i) => out.writeUInt32LE(state[word], i * 4));
	return out;
}

function xchacha(key, nonce, aad, plaintext) {
	const iv = Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]);
	const cipher = createCipheriv('chacha20-poly1305', hchacha20(key, nonce.subarray(0, 16)), iv, {
		authTagLength: 16
	});
	cipher.setAAD(aad);
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([body, cipher.getAuthTag()]);
}

const seal = (key, nonce, aad, plaintext) =>
	Buffer.concat([Buffer.from([1]), nonce, xchacha(key, nonce, aad, plaintext)]);

assert.equal(
	hex(
		xchacha(
			Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i)),
			Buffer.from(Array.from({ length: 24 }, (_, i) => 0x40 + i)),
			unhex('50515253c0c1c2c3c4c5c6c7'),
			utf8(
				"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
			)
		).subarray(-16)
	),
	'c0875924c1c7987947deafd8780acf49'
);

const PKCS8 = {
	x25519: unhex('302e020100300506032b656e04220420'),
	ed25519: unhex('302e020100300506032b657004220420')
};
const SPKI = {
	x25519: unhex('302a300506032b656e032100'),
	ed25519: unhex('302a300506032b6570032100')
};
const privateKey = (kind, raw) =>
	createPrivateKey({ key: Buffer.concat([PKCS8[kind], raw]), format: 'der', type: 'pkcs8' });
const publicOf = (kind, raw) =>
	createPublicKey(privateKey(kind, raw))
		.export({ format: 'der', type: 'spki' })
		.subarray(SPKI[kind].length);
const x25519 = (raw, peer) =>
	diffieHellman({
		privateKey: privateKey('x25519', raw),
		publicKey: createPublicKey({
			key: Buffer.concat([SPKI.x25519, peer]),
			format: 'der',
			type: 'spki'
		})
	});

const SUITE = 'xchacha20poly1305-v1';

function kdfVector(passphrase, normalized, salt) {
	const params = { m: 8192, t: 1, p: 1 };
	const root = Buffer.from(argon2id(utf8(normalized), salt, { ...params, dkLen: 32 }));
	return {
		passphrase,
		normalized,
		salt: hex(salt),
		...params,
		root: hex(root),
		kek: hex(hkdf(root, 'yondrive/kek/v1')),
		authKey: hex(hkdf(root, 'yondrive/auth/v1'))
	};
}

const recoveryEntropy = Buffer.alloc(32, 0x7f);
const master = bytes(1, 32);
const kek = bytes(2, 32);
const nodeKey = bytes(3, 32);
const parentKey = bytes(4, 32);

const wrap = (key, nonce, aad, plaintext) => ({
	key: hex(key),
	nonce: hex(nonce),
	aad: hex(aad),
	plaintext: hex(plaintext),
	sealed: hex(seal(key, nonce, aad, plaintext))
});

function identityVector() {
	const x = bytes(5, 32);
	const ed = bytes(6, 32);
	const xPublic = publicOf('x25519', x);
	const edPublic = publicOf('ed25519', ed);
	const xNonce = bytes(7, 24);
	const edNonce = bytes(8, 24);
	const xAad = fields('yondrive/identity/x25519/v1', xPublic);
	const edAad = fields('yondrive/identity/ed25519/v1', edPublic);
	return {
		master: hex(master),
		x25519Private: hex(x),
		x25519Public: hex(xPublic),
		ed25519Private: hex(ed),
		ed25519Public: hex(edPublic),
		x25519Nonce: hex(xNonce),
		ed25519Nonce: hex(edNonce),
		x25519Aad: hex(xAad),
		ed25519Aad: hex(edAad),
		sealedX25519: hex(seal(master, xNonce, xAad, x)),
		sealedEd25519: hex(seal(master, edNonce, edAad, ed))
	};
}

function grantVector() {
	const recipientPrivate = bytes(9, 32);
	const recipientPublic = publicOf('x25519', recipientPrivate);
	const ephemeralPrivate = bytes(10, 32);
	const ephemeralPublic = publicOf('x25519', ephemeralPrivate);
	const shared = x25519(ephemeralPrivate, recipientPublic);
	assert.deepEqual(shared, x25519(recipientPrivate, ephemeralPublic));
	const wrapKey = hkdf(shared, fields('yondrive/grant/key/v1', ephemeralPublic, recipientPublic));
	const nonce = bytes(11, 24);
	const nodeId = 'node-1';
	const aad = fields('yondrive/node/grant/v1', ephemeralPublic, recipientPublic, utf8(nodeId));
	return {
		nodeKey: hex(nodeKey),
		nodeId,
		recipientPrivate: hex(recipientPrivate),
		recipientPublic: hex(recipientPublic),
		ephemeralPrivate: hex(ephemeralPrivate),
		ephemeralPublic: hex(ephemeralPublic),
		shared: hex(shared),
		wrapKey: hex(wrapKey),
		nonce: hex(nonce),
		aad: hex(aad),
		sealed: hex(Buffer.concat([ephemeralPublic, seal(wrapKey, nonce, aad, nodeKey)]))
	};
}

function nameVectors() {
	const key = hkdf(parentKey, 'yondrive/name/v1');
	const names = [
		['Report.DOCX', 'report.docx'],
		['café.txt', 'café.txt'],
		['ÑANDÚ', 'ñandú'],
		['İ', 'i̇'],
		['ΣΑΣ', 'σας'],
		['Straße', 'straße'],
		['ﬁ', 'ﬁ'],
		[' a  b ', ' a  b ']
	];
	return {
		parentKey: hex(parentKey),
		nameKey: hex(key),
		cases: names.map(([name, normalized]) => ({
			name,
			normalized,
			hmac: hex(createHmac('sha256', key).update(utf8(normalized)).digest()),
			noneTag: hex(sha256(fields('yondrive/name/none/v1', utf8(normalized))))
		}))
	};
}

const FRAME_SIZE = 1024;
const frameInputs = [
	[0, false, bytes(20, FRAME_SIZE), bytes(30, 24)],
	[1, false, bytes(21, FRAME_SIZE), bytes(31, 24)],
	[2, true, bytes(22, 10), bytes(32, 24)]
];

function contentVector() {
	const nodeId = 'node-1';
	const versionId = 'version-1';
	const content = hkdf(nodeKey, 'yondrive/content/v1');
	const versionKey = hkdf(
		content,
		fields('yondrive/content/version/v1', utf8(nodeId), utf8(versionId))
	);
	const frames = frameInputs.map(([index, final, plaintext, nonce]) => {
		const aad = fields(
			'yondrive/frame/v1',
			utf8(nodeId),
			utf8(versionId),
			u32(FRAME_SIZE),
			u32(index),
			Buffer.from([final ? 1 : 0])
		);
		const sealed = seal(versionKey, nonce, aad, plaintext);
		return {
			index,
			final,
			plaintext: hex(plaintext),
			nonce: hex(nonce),
			aad: hex(aad),
			sealed: hex(sealed),
			sha256: hex(sha256(sealed))
		};
	});
	return {
		nodeKey: hex(nodeKey),
		nodeId,
		versionId,
		frameSize: FRAME_SIZE,
		content: hex(content),
		versionKey: hex(versionKey),
		frames,
		size: FRAME_SIZE * 2 + 10,
		contentHash: hex(contentHash(frames.map((frame) => unhex(frame.sha256))))
	};
}

function contentHash(digests) {
	return sha256(fields('yondrive/content/hash/v1'), ...digests);
}

function contentNoneVector() {
	const frames = frameInputs.map(([index, final, plaintext]) => ({
		index,
		final,
		plaintext: hex(plaintext),
		sha256: hex(sha256(plaintext))
	}));
	return {
		nodeId: 'node-1',
		versionId: 'version-1',
		frameSize: FRAME_SIZE,
		frames,
		size: FRAME_SIZE * 2 + 10,
		contentHash: hex(contentHash(frames.map((frame) => unhex(frame.sha256))))
	};
}

function manifestVector(contentHashHex) {
	const secret = bytes(12, 32);
	const manifest = {
		nodeId: 'node-1',
		versionId: 'version-1',
		suite: SUITE,
		size: 5000000000,
		frameSize: 4194304,
		frameCount: 1193,
		contentHash: contentHashHex
	};
	const message = fields(
		'yondrive/version/v1',
		utf8(manifest.nodeId),
		utf8(manifest.versionId),
		utf8(manifest.suite),
		u64(manifest.size),
		u32(manifest.frameSize),
		u32(manifest.frameCount),
		unhex(manifest.contentHash)
	);
	return {
		...manifest,
		ed25519Private: hex(secret),
		ed25519Public: hex(publicOf('ed25519', secret)),
		message: hex(message),
		signature: hex(sign(null, message, privateKey('ed25519', secret)))
	};
}

function pinningVector() {
	const user = (x, ed) => {
		const x25519Public = publicOf('x25519', bytes(x, 32));
		const ed25519Public = publicOf('ed25519', bytes(ed, 32));
		return {
			x25519: hex(x25519Public),
			ed25519: hex(ed25519Public),
			fingerprint: hex(sha256(fields('yondrive/fingerprint/v1', x25519Public, ed25519Public)))
		};
	};
	const alice = user(13, 14);
	const bob = user(15, 16);
	const [low, high] = [alice.fingerprint, bob.fingerprint].sort();
	const digest = createHash('sha512')
		.update(fields('yondrive/safety-number/v1', unhex(low), unhex(high)))
		.digest();
	const groups = Array.from({ length: 12 }, (_, group) =>
		String(digest.readBigUInt64BE(group * 5) >> 24n)
	).map((value) => String(BigInt(value) % 100000n).padStart(5, '0'));
	return { alice, bob, safetyNumber: groups.join(' ') };
}

function metadataVector() {
	const nodeId = 'node-1';
	const json = '{"name":"Plan.docx","tags":["work"],"modified":1760000000}';
	const key = hkdf(nodeKey, 'yondrive/meta/v1');
	const nonce = bytes(17, 24);
	const aad = fields('yondrive/meta/seal/v1', utf8(nodeId));
	return {
		nodeKey: hex(nodeKey),
		nodeId,
		json,
		metaKey: hex(key),
		nonce: hex(nonce),
		aad: hex(aad),
		sealed: hex(seal(key, nonce, aad, utf8(json))),
		noneStored: hex(utf8(json))
	};
}

function smallBlobVectors() {
	const nodeId = 'node-1';
	const blobId = 'blob-1';
	const image = bytes(70, 40);
	const segment = bytes(71, 40);
	const thumbKey = hkdf(nodeKey, 'yondrive/thumb/v1');
	const indexKey = hkdf(master, 'yondrive/index/v1');
	return {
		thumbnail: {
			nodeKey: hex(nodeKey),
			nodeId,
			blobId,
			thumbKey: hex(thumbKey),
			...wrap(
				thumbKey,
				bytes(72, 24),
				fields('yondrive/blob/thumb/v1', utf8(nodeId), utf8(blobId)),
				image
			)
		},
		index: {
			masterKey: hex(master),
			blobId,
			indexKey: hex(indexKey),
			...wrap(indexKey, bytes(73, 24), fields('yondrive/blob/index/v1', utf8(blobId)), segment)
		}
	};
}

function sharingVectors() {
	const secret = bytes(80, 32);
	const grantBytes = bytes(81, 105);
	const message = fields(
		'yondrive/grant/v1',
		utf8('node-1'),
		utf8('user-granter'),
		utf8('user-grantee'),
		utf8('editor'),
		u32(3),
		grantBytes
	);
	const oldKey = bytes(82, 32);
	const newKey = bytes(83, 32);
	const previousSubkey = hkdf(newKey, 'yondrive/node-previous/v1');
	const linkId = 'link-1';
	const linkKey = bytes(84, 32);
	const wrapSubkey = hkdf(linkKey, 'yondrive/link-wrap/v1');
	const ownerSubkey = hkdf(master, 'yondrive/link-owner/v1');
	const passwordRoot = bytes(85, 32);
	const kekOfLink = hkdf(passwordRoot, 'yondrive/link-kek/v1');
	const pinsKey = hkdf(master, 'yondrive/pins/v1');
	return {
		grantSignature: {
			nodeId: 'node-1',
			granterId: 'user-granter',
			granteeId: 'user-grantee',
			role: 'editor',
			generation: 3,
			grant: hex(grantBytes),
			ed25519Private: hex(secret),
			ed25519Public: hex(publicOf('ed25519', secret)),
			message: hex(message),
			signature: hex(sign(null, message, privateKey('ed25519', secret)))
		},
		previousKey: {
			nodeId: 'node-1',
			generation: 3,
			newKey: hex(newKey),
			subkey: hex(previousSubkey),
			...wrap(
				previousSubkey,
				bytes(86, 24),
				fields('yondrive/node/previous/v1', utf8('node-1'), u32(3)),
				oldKey
			)
		},
		link: {
			linkId,
			nodeId: 'node-1',
			linkKey: hex(linkKey),
			fragment: linkKey.toString('base64url'),
			nodeKey: wrap(
				wrapSubkey,
				bytes(87, 24),
				fields('yondrive/link/key/v1', utf8(linkId), utf8('node-1')),
				nodeKey
			),
			owner: {
				masterKey: hex(master),
				...wrap(ownerSubkey, bytes(88, 24), fields('yondrive/link/owner/v1', utf8(linkId)), linkKey)
			},
			password: {
				root: hex(passwordRoot),
				authKey: hex(hkdf(passwordRoot, 'yondrive/link-auth/v1')),
				kek: hex(kekOfLink),
				...wrap(
					kekOfLink,
					bytes(89, 24),
					fields('yondrive/link/password/v1', utf8(linkId)),
					linkKey
				)
			}
		},
		pins: {
			masterKey: hex(master),
			userId: 'user-1',
			...wrap(pinsKey, bytes(90, 24), fields('yondrive/pins/seal/v1', utf8('user-1')), utf8('{}'))
		}
	};
}

const childWrapKey = hkdf(parentKey, 'yondrive/node-wrap/v1');

const content = contentVector();

const vectors = {
	description:
		'Test vectors for docs/CRYPTO.md. Bytes are lowercase hex unless a field is a text string or a number. Generated by web/scripts/crypto-vectors.mjs; inputs are fixed, nonces and ephemeral keys included.',
	version: 1,
	fieldsEncoding: {
		label: 'ab',
		fields: ['63', ''],
		encoded: hex(fields('ab', utf8('c'), Buffer.alloc(0)))
	},
	kdf: [
		kdfVector('correct horse battery', 'correct horse battery', bytes(40, 16)),
		kdfVector('café ﬁsh and chips', 'café fish and chips', bytes(41, 16))
	],
	recovery: {
		entropy: hex(recoveryEntropy),
		phrase:
			'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
		kek: hex(hkdf(recoveryEntropy, 'yondrive/kek/v1')),
		authKey: hex(hkdf(recoveryEntropy, 'yondrive/auth/v1'))
	},
	seal: wrap(bytes(42, 32), bytes(43, 24), utf8('any aad'), utf8('any plaintext')),
	masterWrap: ['passphrase', 'recovery', 'session'].map((purpose, i) => ({
		purpose,
		...wrap(kek, bytes(50 + i, 24), fields(`yondrive/master/${purpose}/v1`), master)
	})),
	identity: identityVector(),
	nodeSubkeys: {
		nodeKey: hex(nodeKey),
		meta: hex(hkdf(nodeKey, 'yondrive/meta/v1')),
		name: hex(hkdf(nodeKey, 'yondrive/name/v1')),
		content: hex(hkdf(nodeKey, 'yondrive/content/v1')),
		nodeWrap: hex(hkdf(nodeKey, 'yondrive/node-wrap/v1'))
	},
	rootWrap: {
		nodeId: 'node-root',
		...wrap(master, bytes(60, 24), fields('yondrive/node/root/v1', utf8('node-root')), nodeKey)
	},
	childWrap: {
		parentKey: hex(parentKey),
		parentId: 'node-parent',
		nodeId: 'node-1',
		...wrap(
			childWrapKey,
			bytes(61, 24),
			fields('yondrive/node/child/v1', utf8('node-parent'), utf8('node-1')),
			nodeKey
		)
	},
	grant: grantVector(),
	metadata: metadataVector(),
	names: nameVectors(),
	content,
	contentNone: contentNoneVector(),
	manifest: manifestVector(content.contentHash),
	pinning: pinningVector(),
	smallBlobs: smallBlobVectors(),
	...sharingVectors()
};

process.stdout.write(`${JSON.stringify(vectors, null, '\t')}\n`);
