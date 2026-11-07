import { describe, expect, it, vi } from 'vitest';
import { OVERHEAD, SealError } from './aead';
import { utf8 } from './encoding';
import type { VersionManifest } from './manifest';
import {
	accountHasWrappedKeys,
	decideMode,
	mayAcceptNone,
	parseSuite,
	sealerFor,
	SUITE_E2E,
	SUITE_NONE
} from './sealer';

const e2e = sealerFor(SUITE_E2E);
const none = sealerFor(SUITE_NONE);
const kek = new Uint8Array(32).fill(1);
const recoveryKek = new Uint8Array(32).fill(2);
const ref = { nodeId: 'n1', versionId: 'v1', frameSize: 1024 };

/** The pipeline a caller runs, with no knowledge of the mode. */
describe.each([
	['end-to-end', e2e],
	['none', none]
])('the same flow in mode %s', (_, sealer) => {
	const { keys, record } = sealer.createUser(kek, recoveryKek);

	it('creates and reopens a user', () => {
		const wrapped = sealer.wrapMaster(keys.masterKey, kek, 'passphrase');
		const master = sealer.unwrapMaster(wrapped, kek, 'passphrase');

		expect(master).toEqual(keys.masterKey);
		expect(sealer.openUser(record, master)).toEqual(keys);
	});

	it('walks a tree of node keys', () => {
		const root = sealer.newNodeKey();
		const child = sealer.newNodeKey();

		const wrappedRoot = sealer.wrapRootNodeKey(root, keys.masterKey, 'root');
		const wrappedChild = sealer.wrapNodeKey(child, root, 'root', 'child');

		expect(sealer.unwrapRootNodeKey(wrappedRoot, keys.masterKey, 'root')).toEqual(root);
		expect(sealer.unwrapNodeKey(wrappedChild, root, 'root', 'child')).toEqual(child);
	});

	it('hands a node key to another user', () => {
		const other = sealer.createUser(kek, recoveryKek);
		const nodeKey = sealer.newNodeKey();

		const grant = sealer.sealNodeKeyTo(nodeKey, other.record.publicKeys, 'n1');

		expect(sealer.openNodeKeyFrom(grant, other.keys, 'n1')).toEqual(nodeKey);
	});

	it('stores and reads metadata', () => {
		const nodeKey = sealer.newNodeKey();
		const value = { name: 'plan.docx', tags: ['a'] };

		expect(sealer.openMetadata(nodeKey, 'n1', sealer.sealMetadata(nodeKey, 'n1', value))).toEqual(
			value
		);
	});

	it('tags duplicate names alike', () => {
		const parent = sealer.newNodeKey();

		expect(sealer.nameTag(parent, 'CAFÉ')).toEqual(sealer.nameTag(parent, 'café'));
		expect(sealer.nameTag(parent, 'a')).not.toEqual(sealer.nameTag(parent, 'b'));
		expect(sealer.nameTag(parent, 'a')).toHaveLength(32);
	});

	it('seals, stores and opens a frame at the documented offset', () => {
		const cipher = sealer.openVersion(sealer.newNodeKey(), ref);
		const position = { index: 0, final: true };
		const plaintext = utf8('hello');

		const frame = cipher.sealFrame(position, plaintext);

		expect(frame.data).toHaveLength(plaintext.length + sealer.frameOverhead);
		expect(frame.sha256).toHaveLength(32);
		expect(cipher.openFrame(position, frame)).toEqual(plaintext);
	});

	it('catches a corrupt frame by its digest, without keys', () => {
		const cipher = sealer.openVersion(sealer.newNodeKey(), ref);
		const frame = cipher.sealFrame({ index: 0, final: true }, utf8('hello'));
		frame.data[0] ^= 1;

		expect(() => cipher.openFrame({ index: 0, final: true }, frame)).toThrow(
			expect.objectContaining({ code: 'integrity' })
		);
	});

	it('enforces the framing', () => {
		const cipher = sealer.openVersion(sealer.newNodeKey(), ref);

		expect(() => cipher.sealFrame({ index: 0, final: false }, utf8('short'))).toThrow(SealError);
	});

	it('returns buffers the caller owns', () => {
		const cipher = sealer.openVersion(sealer.newNodeKey(), ref);
		const plaintext = utf8('hello');
		const frame = cipher.sealFrame({ index: 0, final: true }, plaintext);
		const opened = cipher.openFrame({ index: 0, final: true }, frame);

		plaintext.fill(0);
		opened.fill(0);

		expect(cipher.openFrame({ index: 0, final: true }, frame)).toEqual(utf8('hello'));
	});

	it('signs and verifies a version', () => {
		const manifest: VersionManifest = {
			...ref,
			suite: sealer.suite,
			size: 5,
			frameCount: 1,
			contentHash: new Uint8Array(32).fill(3)
		};
		const signature = sealer.signVersion(manifest, keys);

		expect(() => sealer.verifyVersion(manifest, signature, record.publicKeys)).not.toThrow();
	});
});

describe('suite none', () => {
	it('says it is not encrypted', () => {
		expect(none.encrypted).toBe(false);
		expect(e2e.encrypted).toBe(true);
	});

	it('stores the original bytes, byte for byte', () => {
		const plaintext = utf8('the original file');
		const frame = none
			.openVersion(new Uint8Array(0), ref)
			.sealFrame({ index: 0, final: true }, plaintext);

		expect(frame.data).toEqual(plaintext);
		expect(none.frameOverhead).toBe(0);
	});

	it('stores metadata as readable JSON', () => {
		expect(new TextDecoder().decode(none.sealMetadata(new Uint8Array(0), 'n1', { a: 1 }))).toBe(
			'{"a":1}'
		);
	});

	it('has no keys, wraps or signatures', () => {
		const { keys, record } = none.createUser(kek, recoveryKek);
		const empty = new Uint8Array(0);

		expect(keys.masterKey).toEqual(empty);
		expect(record).toEqual({
			wrappedMaster: empty,
			recoveryWrappedMaster: empty,
			publicKeys: { x25519: empty, ed25519: empty },
			sealedX25519: empty,
			sealedEd25519: empty
		});
		expect(none.newNodeKey()).toEqual(empty);
		expect(accountHasWrappedKeys(record)).toBe(false);
	});

	it('keeps no session and never asks the server for one', async () => {
		const api = { putSessionKey: vi.fn(), getSessionKey: vi.fn() };

		await none.persistSession(new Uint8Array(0), api);

		await expect(none.resumeSession(api)).resolves.toEqual(new Uint8Array(0));
		expect(api.putSessionKey).not.toHaveBeenCalled();
		expect(api.getSessionKey).not.toHaveBeenCalled();
	});
});

describe('suite xchacha20poly1305-v1', () => {
	it('encrypts everything it stores', () => {
		const nodeKey = e2e.newNodeKey();
		const frame = e2e.openVersion(nodeKey, ref).sealFrame({ index: 0, final: true }, utf8('hello'));
		const metadata = e2e.sealMetadata(nodeKey, 'n1', { name: 'secret' });

		expect(frame.data).toHaveLength(5 + OVERHEAD);
		expect(Buffer.from(frame.data).includes('hello')).toBe(false);
		expect(Buffer.from(metadata).includes('secret')).toBe(false);
	});

	it('refuses a key from suite none, so a mixed-up mode cannot seal under nothing', () => {
		expect(() => e2e.sealMetadata(new Uint8Array(0), 'n1', {})).toThrow(RangeError);
		expect(() => e2e.openVersion(new Uint8Array(0), ref)).toThrow(RangeError);
	});

	it('zeroes the version key on close', () => {
		const cipher = e2e.openVersion(e2e.newNodeKey(), ref);

		cipher.close();

		expect(() => cipher.sealFrame({ index: 0, final: true }, utf8('x'))).toThrow('zeroed');
	});
});

describe('parseSuite', () => {
	it('knows the two suites and nothing else', () => {
		expect(parseSuite(SUITE_E2E)).toBe(SUITE_E2E);
		expect(parseSuite(SUITE_NONE)).toBe(SUITE_NONE);
		expect(parseSuite('NONE')).toBeNull();
		expect(parseSuite(undefined)).toBeNull();
	});
});

describe('accountHasWrappedKeys', () => {
	it('sees keys whichever suite the server claims', () => {
		const { record } = e2e.createUser(kek, recoveryKek);

		expect(accountHasWrappedKeys(record)).toBe(true);
		expect(accountHasWrappedKeys(null)).toBe(false);
		expect(
			decideMode({
				claimed: SUITE_NONE,
				accountHasWrappedKeys: accountHasWrappedKeys(record),
				pinned: null
			})
		).toEqual({ accept: false, reason: 'account-has-keys' });
	});
});

describe('mayAcceptNone', () => {
	it.each([
		[false, null, { accept: true }],
		[false, SUITE_NONE, { accept: true }],
		[false, SUITE_E2E, { accept: false, reason: 'device-pinned' }],
		[true, null, { accept: false, reason: 'account-has-keys' }],
		[true, SUITE_NONE, { accept: false, reason: 'account-has-keys' }],
		[true, SUITE_E2E, { accept: false, reason: 'account-has-keys' }]
	] as const)('keys %s, pin %s', (accountHasWrappedKeys, pinned, expected) => {
		expect(mayAcceptNone({ accountHasWrappedKeys, pinned })).toEqual(expected);
	});
});

describe('decideMode', () => {
	it.each([
		[SUITE_E2E, false, null, { accept: true, suite: SUITE_E2E }],
		[SUITE_E2E, true, SUITE_E2E, { accept: true, suite: SUITE_E2E }],
		[SUITE_NONE, false, null, { accept: true, suite: SUITE_NONE }],
		[SUITE_NONE, false, SUITE_NONE, { accept: true, suite: SUITE_NONE }],
		[SUITE_E2E, false, SUITE_NONE, { accept: false, reason: 'device-pinned' }],
		[SUITE_NONE, false, SUITE_E2E, { accept: false, reason: 'device-pinned' }],
		[SUITE_NONE, true, null, { accept: false, reason: 'account-has-keys' }],
		['rot13', false, null, { accept: false, reason: 'unknown-suite' }],
		[undefined, false, SUITE_E2E, { accept: false, reason: 'unknown-suite' }]
	] as const)('claim %s, keys %s, pin %s', (claimed, accountHasWrappedKeys, pinned, expected) => {
		expect(decideMode({ claimed, accountHasWrappedKeys, pinned })).toEqual(expected);
	});
});
