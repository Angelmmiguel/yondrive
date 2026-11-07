import { describe, expect, it, vi } from 'vitest';
import { ApiError, isApiError } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { deriveLinkRoot } from '$lib/crypto/kdf';
import { sealerFor, SUITE_E2E, type Suite } from '$lib/crypto/sealer';
import { Drive } from '$lib/drive/drive';
import { inlineFramePool } from '$lib/drive/frame-pool';
import { openNodes } from '$lib/drive/open-nodes';
import type { StreamClient } from '$lib/drive/stream/client';
import { memoryResumeStore } from '$lib/drive/upload/resume';
import {
	CHEAP_KDF,
	fakeDriveServer,
	fakeFile,
	fakeUser,
	patterned,
	SUITES,
	testPublicKeys,
	USER_ID
} from '$lib/testing/drive';
import { ContactKeysChangedError, Contacts, memoryPinStorage } from './contacts';
import { canChangePlace, canWrite, isOwner } from './roles';
import { memoryRotationJobs, type RotationProgress } from './rotation';
import { PublicLinkSession, WrongLinkPasswordError } from './public';
import { UntrustedGrantError } from './sharing';

const ALICE = USER_ID;
const BOB = 'b'.repeat(32);
const CAROL = 'c'.repeat(32);

const streams = (): StreamClient => ({
	open: async () => null,
	release: () => {},
	clear: () => {},
	stop: () => {}
});

function people(suite: Suite) {
	const server = fakeDriveServer(suite);
	const sealer = sealerFor(suite);
	const person = (id: string, username: string) => {
		const keys = fakeUser(suite);
		server.users.set(id, { id, username, public_keys: testPublicKeys(keys) });
		const jobs = memoryRotationJobs();
		const pins = memoryPinStorage();
		const make = () => {
			const api = server.as(id);
			const drive = new Drive({
				api,
				sealer,
				keys: () => keys,
				userId: () => id,
				open: async (key, parent, records) => openNodes(sealer, key, parent, records),
				pool: inlineFramePool(sealer),
				resume: memoryResumeStore(),
				streams: streams(),
				saveUrl: () => {},
				saveBlob: () => {},
				pins,
				rotationJobs: jobs,
				deriveLinkRoot: async (password, params) => deriveLinkRoot(password, params),
				linkKdf: CHEAP_KDF,
				origin: () => 'https://drive.example',
				sleep: async () => {}
			});
			drive.engine.frameSize = 1024;
			return drive;
		};
		return { id, username, keys, drive: make(), make, api: server.as(id), jobs, pins };
	};
	return {
		server,
		sealer,
		alice: person(ALICE, 'alice'),
		bob: person(BOB, 'bob'),
		carol: person(CAROL, 'carol')
	};
}

type World = ReturnType<typeof people>;
type Person = World['alice'];

async function upload(person: Person, parentId: string, name: string, bytes: Uint8Array) {
	const { drive } = person;
	drive.queue.addFiles(parentId, [{ file: fakeFile(name, bytes) }]);
	await vi.waitFor(() => expect(drive.queue.active).toBe(false), { interval: 5 });
	const failed = drive.queue.items.find((item) => item.status === 'failed');
	if (failed !== undefined) throw failed.error;
	drive.queue.clearFinished();
	const node = drive.tree.childrenOf(parentId).find((child) => child.name === name);
	if (node === undefined) throw new Error('it did not arrive');
	return node;
}

async function read(person: Person, node: { id: string; currentVersion: string | null }) {
	const version = await person.drive.openVersion(node);
	const blob = await person.drive.readBlob(node, version);
	return new Uint8Array(await blob.arrayBuffer());
}

async function world(suite: Suite) {
	const w = people(suite);
	await w.alice.drive.start();
	await w.bob.drive.start();
	await w.carol.drive.start();
	const root = w.alice.drive.tree.rootId as string;
	const folder = await w.alice.drive.tree.createFolder(root, 'Project');
	const inner = await w.alice.drive.tree.createFolder(folder.id, 'Inner');
	const bytes = patterned(3000);
	const file = await upload(w.alice, inner.id, 'plan.bin', bytes);
	return { ...w, root, folder, inner, file, bytes };
}

describe.each(SUITES)('sharing in mode %s', (_, suite) => {
	it('lets a viewer read the whole subtree, and nothing more', async () => {
		const w = await world(suite);
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');

		const [entry] = await w.bob.drive.sharing.refreshShared();
		expect(entry.trust).toBe('verified');
		const top = await w.bob.drive.tree.resolve(entry.node.id);
		expect(top.name).toBe('Project');
		expect(top.parentId).toBeNull();
		expect(top.role).toBe('viewer');

		await w.bob.drive.tree.loadFolder(top.id);
		const [inner] = w.bob.drive.tree.childrenOf(top.id);
		expect(inner.name).toBe('Inner');
		await w.bob.drive.tree.loadFolder(inner.id);
		const [file] = w.bob.drive.tree.childrenOf(inner.id);
		expect(await read(w.bob, file)).toEqual(w.bytes);

		await expect(w.bob.drive.tree.createFolder(top.id, 'Mine')).rejects.toSatisfy((e) =>
			isApiError(e, 'forbidden')
		);
		await expect(w.bob.drive.tree.patch(file.id, { favorite: true })).rejects.toSatisfy((e) =>
			isApiError(e, 'forbidden')
		);
		// What is shared stays out of what is about one's own files.
		expect(w.bob.drive.tree.live()).toEqual([]);
	});

	it('lets an editor write inside, and not change where the shared folder lives', async () => {
		const w = await world(suite);
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'editor');
		await w.bob.drive.sharing.refreshShared();
		const top = await w.bob.drive.tree.resolve(w.folder.id);

		await expect(w.bob.drive.tree.rename(top.id, 'Other')).rejects.toThrow();
		await expect(w.bob.drive.tree.trash(top.id)).rejects.toSatisfy((e) =>
			isApiError(e, 'forbidden')
		);

		const made = await w.bob.drive.tree.createFolder(top.id, 'From Bob');
		const bytes = patterned(1500);
		const file = await upload(w.bob, made.id, 'notes.bin', bytes);
		expect(file.ownerId).toBe(ALICE);

		// The owner reads what the editor signed, and the signer is known by their pinned key.
		await w.alice.drive.tree.loadFolder(w.folder.id, true);
		const seen = w.alice.drive.tree.childrenOf(w.folder.id).find((n) => n.name === 'From Bob');
		await w.alice.drive.tree.loadFolder(seen?.id as string);
		const [theirs] = w.alice.drive.tree.childrenOf(seen?.id as string);
		const version = await w.alice.drive.openVersion(theirs);
		expect(version.formerAuthor).toBe(false);
		expect(await read(w.alice, theirs)).toEqual(bytes);
		if (w.sealer.encrypted) expect(w.alice.drive.sharing.contacts.get(BOB)?.username).toBe('bob');
	});

	it('shows what someone who has lost edit rights wrote, and says so', async () => {
		const w = await world(suite);
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'editor');
		await w.bob.drive.sharing.refreshShared();
		await w.bob.drive.tree.resolve(w.folder.id);
		const file = await upload(w.bob, w.folder.id, 'theirs.bin', patterned(100));

		await w.alice.drive.sharing.revoke(grant.id, w.folder.id);

		await w.alice.drive.tree.loadFolder(w.folder.id, true);
		const seen = w.alice.drive.tree.childrenOf(w.folder.id).find((n) => n.id === file.id);
		const version = await w.alice.drive.openVersion(seen as typeof file);
		expect(version.formerAuthor).toBe(true);
	});

	it('changes a role under a new signature', async () => {
		const w = await world(suite);
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		const [person] = await w.alice.drive.sharing.people(w.folder.id);
		expect(person.unsigned).toBe(false);

		await w.alice.drive.sharing.changeRole(person.access, w.folder.id, 'editor');

		const [entry] = await w.bob.drive.sharing.refreshShared();
		expect(entry.trust).toBe('verified');
		expect(entry.grant.role).toBe('editor');
	});

	it('refuses a grant whose granter does not own the node', async () => {
		const w = await world(suite);
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		w.server.grants.set(grant.id, { ...grant, granter_id: CAROL, granter_username: 'carol' });

		const [entry] = await w.bob.drive.sharing.refreshShared();
		expect(entry.trust).toBe('not-owner');
		await expect(w.bob.drive.tree.resolve(w.folder.id)).rejects.toBeInstanceOf(UntrustedGrantError);
	});

	it('revokes, rotates from the top down, and leaves others their access', async () => {
		const w = await world(suite);
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		await w.alice.drive.sharing.share(w.folder.id, 'carol', 'viewer');
		const progress: number[] = [];

		await w.alice.drive.sharing.revoke(grant.id, w.folder.id, ({ done }) => progress.push(done));

		expect(progress.at(-1)).toBe(3);
		for (const id of [w.folder.id, w.inner.id, w.file.id]) {
			expect(w.server.nodes.get(id)?.key_generation).toBe(2);
		}
		await expect(w.bob.api.getNode(w.folder.id)).rejects.toSatisfy((e) =>
			isApiError(e, 'not_found')
		);

		// The owner's tree has the new keys, and everything reads, through the chain.
		const seen = await w.alice.drive.tree.resolve(w.file.id);
		expect(await read(w.alice, seen)).toEqual(w.bytes);
		const version = await w.alice.drive.openVersion(seen);
		expect(version.keyGeneration).toBe(1);

		// The one who stayed gets the new key from their resealed grant, signed anew.
		const [entry] = await w.carol.drive.sharing.refreshShared();
		expect(entry.trust).toBe('verified');
		expect(entry.grant.key_generation).toBe(2);
		await w.carol.drive.tree.resolve(w.folder.id);
		await w.carol.drive.tree.loadFolder(w.folder.id);
		const [inner] = w.carol.drive.tree.childrenOf(w.folder.id);
		await w.carol.drive.tree.loadFolder(inner.id);
		const [file] = w.carol.drive.tree.childrenOf(inner.id);
		expect(await read(w.carol, file)).toEqual(w.bytes);
	});

	it('names the children in the trash, too', async () => {
		const w = await world(suite);
		const gone = await w.alice.drive.tree.createFolder(w.folder.id, 'Old');
		await w.alice.drive.tree.trash(gone.id);
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');

		await w.alice.drive.sharing.revoke(grant.id, w.folder.id);

		expect(w.server.nodes.get(gone.id)?.key_generation).toBe(2);
		const restored = await w.alice.drive.tree.restore(gone.id);
		expect(restored.name).toBe('Old');
	});

	it('resumes a stopped rotation by generation, without doing a node twice', async () => {
		const w = await world(suite);
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		const stop = new ApiError(0, 'network');
		w.server.state.failRotation = [() => null, (id) => (id === w.inner.id ? stop : null)];

		await expect(w.alice.drive.sharing.revoke(grant.id, w.folder.id)).rejects.toBe(stop);
		expect(w.server.nodes.get(w.folder.id)?.key_generation).toBe(2);
		expect(w.server.nodes.get(w.inner.id)?.key_generation).toBe(1);
		expect(w.alice.jobs.list()).toHaveLength(1);

		const later = w.alice.make();
		await later.start();
		await vi.waitFor(() => expect(w.alice.jobs.list()).toHaveLength(0), { interval: 5 });

		expect(w.server.nodes.get(w.folder.id)?.key_generation).toBe(2);
		expect(w.server.nodes.get(w.inner.id)?.key_generation).toBe(2);
		expect(w.server.nodes.get(w.file.id)?.key_generation).toBe(2);
		const seen = await later.tree.resolve(w.file.id);
		const version = await later.openVersion(seen);
		const blob = await later.readBlob(seen, version);
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(w.bytes);
	});

	it('reads again and seals again when a rotation is refused as a conflict', async () => {
		const w = await world(suite);
		const grant = await w.alice.drive.sharing.share(w.inner.id, 'bob', 'viewer');
		w.server.state.failRotation = [() => new ApiError(409, 'rotate_conflict')];

		await w.alice.drive.sharing.revoke(grant.id, w.inner.id);

		expect(w.server.nodes.get(w.inner.id)?.key_generation).toBe(2);
		expect(w.alice.jobs.list()).toHaveLength(0);
	});

	it('takes a thumbnail away with the key, and asks for another', async () => {
		const w = await world(suite);
		const made: string[] = [];
		w.alice.drive.thumbs.remake = async (node) => {
			made.push(node.id);
		};
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		w.server.nodes.set(w.file.id, {
			...(w.server.nodes.get(w.file.id) as NonNullable<ReturnType<typeof w.server.nodes.get>>),
			thumb_blob_id: 'f'.repeat(32)
		});

		await w.alice.drive.sharing.revoke(grant.id, w.folder.id);

		expect(w.server.nodes.get(w.file.id)?.thumb_blob_id).toBeUndefined();
		await vi.waitFor(() => expect(made).toEqual([w.file.id]), { interval: 5 });
	});

	it('follows the journal: a new share, a rotation and a revocation', async () => {
		const w = await world(suite);
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		await w.alice.drive.sharing.share(w.folder.id, 'carol', 'viewer');
		await w.bob.drive.poll();
		await w.carol.drive.poll();
		expect(w.carol.drive.sharing.shared).toHaveLength(1);
		await w.carol.drive.tree.resolve(w.folder.id);
		await w.carol.drive.tree.loadFolder(w.folder.id);
		await w.bob.drive.tree.resolve(w.folder.id);
		expect(w.bob.drive.tree.nodes.has(w.folder.id)).toBe(true);

		await w.alice.drive.sharing.revoke(grant.id, w.folder.id);

		await w.bob.drive.poll();
		expect(w.bob.drive.tree.nodes.has(w.folder.id)).toBe(false);
		expect(w.bob.drive.sharing.shared).toEqual([]);

		await w.carol.drive.poll();
		const [inner] = w.carol.drive.tree.childrenOf(w.folder.id);
		expect(inner.readable).toBe(true);
		expect(w.carol.drive.tree.generationOf(w.folder.id)).toBe(2);
	});

	it('starts an upload over when a rotation overtakes it', async () => {
		const w = await world(suite);
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'editor');
		await w.bob.drive.sharing.refreshShared();
		const top = await w.bob.drive.tree.resolve(w.folder.id);
		await w.bob.drive.tree.loadFolder(top.id);
		const carolGrant = await w.alice.drive.sharing.share(w.folder.id, 'carol', 'viewer');
		await w.alice.drive.sharing.revoke(carolGrant.id, w.folder.id);

		// Bob's device has not seen it, so his first try is sealed under the old key.
		const bytes = patterned(2000);
		const file = await upload(w.bob, top.id, 'late.bin', bytes);

		expect(w.server.versions.get(file.id)?.[0].key_generation).toBe(1);
		expect(w.bob.drive.tree.generationOf(top.id)).toBe(2);
		await w.alice.drive.tree.loadFolder(w.folder.id, true);
		const seen = w.alice.drive.tree.childrenOf(w.folder.id).find((n) => n.id === file.id);
		expect(await read(w.alice, seen as typeof file)).toEqual(bytes);
	});

	it('counts what is unread, and marks it', async () => {
		const w = await world(suite);
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		const { list } = await w.bob.drive.sharing.notifications();
		expect(list.map((one) => one.node_id)).toEqual([w.folder.id]);

		await w.bob.drive.sharing.markRead();
		expect((await w.bob.drive.sharing.notifications()).list).toEqual([]);
	});

	it('shows who has a node on its row, also through a folder above', async () => {
		const w = await world(suite);
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		const trail = w.alice.drive.tree.breadcrumbs(w.file.id);
		expect(w.alice.drive.sharing.peopleOf(trail)).toEqual(['bob']);

		await w.bob.drive.sharing.refreshShared();
		const top = await w.bob.drive.tree.resolve(w.folder.id);
		expect(w.bob.drive.sharing.peopleOf([top])).toEqual(['alice']);
	});

	describe('public links', () => {
		function reader(w: World, id: string, fragment: string) {
			return new PublicLinkSession(id, w.sealer.parseLinkFragment(fragment), {
				api: w.server.as('anonymous'),
				sealer: w.sealer,
				pool: inlineFramePool(w.sealer),
				deriveRoot: async (password, params) => deriveLinkRoot(password, params),
				schedule: () => () => {}
			});
		}
		const fragmentOf = (url: string) => new URL(url).hash.slice(1);

		it('opens from the address alone, down through the wraps', async () => {
			const w = await world(suite);
			const { link, url } = await w.alice.drive.sharing.createLink(w.folder.id, {});
			expect(new URL(url).pathname).toBe(`/s/${link.id}`);
			expect(w.alice.drive.sharing.urlOf(link)).toBe(url);

			const session = reader(w, link.id, fragmentOf(url));
			const state = await session.open();
			expect(state).toMatchObject({ kind: 'open', node: { name: 'Project', parentId: null } });

			const [inner] = await session.children(w.folder.id);
			expect(inner.name).toBe('Inner');
			const [file] = await session.children(inner.id);
			const version = await session.version(file.id);
			const blob = await session.read(file.id, version);
			expect(new Uint8Array(await blob.arrayBuffer())).toEqual(w.bytes);
			session.stop();
		});

		it('takes a password, refusing a wrong one, and the address carries no key', async () => {
			const w = await world(suite);
			const { link, url } = await w.alice.drive.sharing.createLink(w.folder.id, {
				password: 'the right password'
			});
			expect(new URL(url).hash).toBe('');
			expect(link.has_password).toBe(true);

			const session = reader(w, link.id, '');
			expect(await session.open()).toEqual({ kind: 'password' });
			await expect(session.unlock('a wrong password')).rejects.toBeInstanceOf(
				WrongLinkPasswordError
			);
			const state = await session.unlock('the right password');
			expect(state).toMatchObject({ kind: 'open', node: { name: 'Project' } });
			const [inner] = await session.children(w.folder.id);
			expect(inner.name).toBe('Inner');
			session.stop();
		});

		it('says why a link has ended', async () => {
			const w = await world(suite);
			const sharing = w.alice.drive.sharing;
			const expiring = await sharing.createLink(w.folder.id, {
				expiresAt: new Date(w.server.state.now + 1000)
			});
			const revoked = await sharing.createLink(w.folder.id, {});
			await sharing.revokeLink(revoked.link.id);
			w.server.state.now += 2000;

			expect(await reader(w, expiring.link.id, fragmentOf(expiring.url)).open()).toEqual({
				kind: 'ended',
				why: 'expired'
			});
			expect(await reader(w, revoked.link.id, fragmentOf(revoked.url)).open()).toEqual({
				kind: 'ended',
				why: 'revoked'
			});
			expect(await reader(w, 'a'.repeat(32), '').open()).toEqual({ kind: 'ended', why: 'gone' });
		});

		it('counts a file once per session, up to the limit', async () => {
			const w = await world(suite);
			const { link, url } = await w.alice.drive.sharing.createLink(w.inner.id, {
				downloadLimit: 1
			});
			const session = reader(w, link.id, fragmentOf(url));
			await session.open();
			expect(session.downloadsRemaining).toBe(1);
			const [file] = await session.children(w.inner.id);
			const version = await session.version(file.id);
			await session.read(file.id, version);
			await session.read(file.id, version);
			expect(w.server.links.get(link.id)?.download_count).toBe(1);

			expect(await reader(w, link.id, fragmentOf(url)).open()).toEqual({
				kind: 'ended',
				why: 'limit'
			});
		});

		it('survives a rotation, and reads the file under its old key through the chain', async () => {
			const w = await world(suite);
			const { link, url } = await w.alice.drive.sharing.createLink(w.folder.id, {});
			const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			await w.alice.drive.sharing.revoke(grant.id, w.folder.id);

			const session = reader(w, link.id, fragmentOf(url));
			await session.open();
			const [inner] = await session.children(w.folder.id);
			const [file] = await session.children(inner.id);
			expect(inner.readable && file.readable).toBe(true);
			const version = await session.version(file.id);
			const blob = await session.read(file.id, version);
			expect(new Uint8Array(await blob.arrayBuffer())).toEqual(w.bytes);
		});
	});
});

describe('with keys', () => {
	const e2e = () => world(SUITE_E2E);

	it('pins on first use, and refuses a swapped key until someone accepts it', async () => {
		const w = await e2e();
		const contacts = w.alice.drive.sharing.contacts;
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		expect(contacts.get(BOB)?.username).toBe('bob');
		const number = contacts.safetyNumberWith(contacts.get(BOB)?.keys as never);
		expect(number).toMatch(/^(\d{5} ){11}\d{5}$/);
		// Both sides get the same number.
		const theirs = w.bob.drive.sharing.contacts;
		const alice = await theirs.keysOf(ALICE);
		expect(theirs.safetyNumberWith(alice)).toBe(number);

		const mallory = fakeUser(SUITE_E2E);
		w.server.users.set(BOB, { id: BOB, username: 'bob', public_keys: testPublicKeys(mallory) });
		const before = w.server.grants.size;
		const refused = await w.alice.drive.sharing
			.share(w.inner.id, 'bob', 'viewer')
			.catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(ContactKeysChangedError);
		expect(w.server.grants.size).toBe(before);

		contacts.accept(refused as ContactKeysChangedError);
		await w.alice.drive.sharing.share(w.inner.id, 'bob', 'viewer');
		expect(w.server.grants.size).toBe(before + 1);
	});

	describe('a pin holds an id and a name together', () => {
		const OTHER = 'd'.repeat(32);
		const hostile = (w: World, username = 'bob') => {
			w.server.users.delete(BOB);
			w.server.users.set(OTHER, {
				id: OTHER,
				username,
				public_keys: testPublicKeys(fakeUser(SUITE_E2E))
			});
		};
		const refusal = (w: Awaited<ReturnType<typeof world>>, username = 'bob') =>
			w.alice.drive.sharing.share(w.inner.id, username, 'viewer').catch((e: unknown) => e);

		it('stops at a known name on another id, and shares nothing', async () => {
			const w = await e2e();
			const contacts = w.alice.drive.sharing.contacts;
			await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			const known = contacts.get(BOB)?.keys;
			hostile(w);
			const before = w.server.grants.size;

			const refused = await refusal(w);

			expect(refused).toBeInstanceOf(ContactKeysChangedError);
			const changed = refused as ContactKeysChangedError;
			expect(changed.userId).toBe(OTHER);
			expect(changed.username).toBe('bob');
			expect(changed.was.userId).toBe(BOB);
			expect(changed.pinned).toEqual(known);
			expect(w.server.grants.size).toBe(before);
			expect(contacts.get(OTHER)).toBeUndefined();

			// Saying no leaves it as it was, and it comes up again.
			expect(await refusal(w)).toBeInstanceOf(ContactKeysChangedError);
			expect(w.server.grants.size).toBe(before);
		});

		it('compares names the way the server does', async () => {
			const w = await e2e();
			await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			const contacts = w.alice.drive.sharing.contacts;
			const { identity } = fakeUser(SUITE_E2E);
			const given = { x25519: identity.x25519.publicKey, ed25519: identity.ed25519.publicKey };
			expect(() => contacts.check(OTHER, ' BOB ', given)).toThrow(ContactKeysChangedError);
		});

		it('replaces the old pin on accepting, so that the name has one account', async () => {
			const w = await e2e();
			const contacts = w.alice.drive.sharing.contacts;
			await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			hostile(w);
			const before = w.server.grants.size;

			contacts.accept((await refusal(w)) as ContactKeysChangedError);

			expect(contacts.get(BOB)).toBeUndefined();
			expect(contacts.get(OTHER)?.username).toBe('bob');
			expect(contacts.get(OTHER)?.comparedAt).toBeNull();
			await w.alice.drive.sharing.share(w.inner.id, 'bob', 'viewer');
			expect(w.server.grants.size).toBe(before + 1);
		});

		it('stops at a known id under another name, and keeps the name it knew', async () => {
			const w = await e2e();
			const contacts = w.alice.drive.sharing.contacts;
			await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			const user = w.server.users.get(BOB) as NonNullable<ReturnType<typeof w.server.users.get>>;
			w.server.users.set(BOB, { ...user, username: 'robert' });
			contacts.refresh();

			const refused = await contacts.keysOf(BOB).catch((e: unknown) => e);

			expect(refused).toBeInstanceOf(ContactKeysChangedError);
			const changed = refused as ContactKeysChangedError;
			expect(changed.username).toBe('robert');
			expect(changed.was).toEqual({ userId: undefined, username: 'bob' });
			expect(contacts.get(BOB)?.username).toBe('bob');

			contacts.accept(changed);
			expect(contacts.get(BOB)?.username).toBe('robert');
			expect(await contacts.keysOf(BOB)).toEqual(contacts.get(BOB)?.keys);
		});

		it('takes the name a lookup was asked for, or no answer at all', async () => {
			const w = await e2e();
			hostile(w, 'bob-the-second');
			const lookupUser = w.server.as(ALICE).lookupUser;
			const contacts = new Contacts({
				api: {
					getUserKeys: w.server.as(ALICE).getUserKeys,
					lookupUser: () => lookupUser('bob-the-second')
				},
				sealer: w.sealer,
				keys: () => w.alice.keys,
				userId: () => ALICE,
				storage: memoryPinStorage()
			});

			await expect(contacts.lookup('bob')).rejects.toSatisfy((e) => isApiError(e, 'not_found'));
			expect(contacts.get(OTHER)).toBeUndefined();
		});

		it('holds the name on a grant to the pins, though the keys route says otherwise', async () => {
			const w = await e2e();
			const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			expect((await w.bob.drive.sharing.refreshShared())[0].trust).toBe('verified');

			w.server.grants.set(grant.id, { ...grant, granter_username: 'mallory' });
			const [relabelled] = await w.bob.drive.sharing.refreshShared();
			expect(relabelled.trust).toBe('keys-changed');
			expect(relabelled.changed?.was.username).toBe('alice');
			expect(w.bob.drive.sharing.contacts.get(ALICE)?.username).toBe('alice');
		});

		it('does not believe a grant from another account with a known name', async () => {
			const w = await e2e();
			const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			expect((await w.bob.drive.sharing.refreshShared())[0].trust).toBe('verified');

			// All a hostile server needs: an owner of its own, whose key signs for real.
			const forger = fakeUser(SUITE_E2E);
			w.server.users.set(OTHER, {
				id: OTHER,
				username: 'alice',
				public_keys: testPublicKeys(forger)
			});
			const node = w.server.nodes.get(w.folder.id) as NonNullable<
				ReturnType<typeof w.server.nodes.get>
			>;
			w.server.nodes.set(w.folder.id, { ...node, owner_id: OTHER });
			w.server.grants.set(grant.id, {
				...grant,
				granter_id: OTHER,
				signature: encodeBase64(
					w.sealer.signGrant(
						{
							nodeId: grant.node_id,
							granterId: OTHER,
							granteeId: BOB,
							role: grant.role,
							generation: grant.key_generation,
							sealedKey: decodeBase64(grant.sealed_key)
						},
						forger
					)
				)
			});

			const [entry] = await w.bob.drive.sharing.refreshShared();
			expect(entry.trust).toBe('keys-changed');
			expect(entry.changed?.was.userId).toBe(ALICE);
			await expect(w.bob.drive.sharing.grantKey(entry.node)).rejects.toBeInstanceOf(
				UntrustedGrantError
			);
		});
	});

	it('keeps the pins sealed, under a key only this master key reaches', async () => {
		const w = await e2e();
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		const stored = w.alice.pins.read() as string;
		expect(new TextDecoder().decode(decodeBase64(stored))).not.toContain('bob');
		expect(w.alice.drive.sharing.contacts.get(BOB)?.username).toBe('bob');
	});

	it('refuses a forged signature, a changed role and a grant signed by someone else', async () => {
		const w = await e2e();
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		const check = async () => (await w.bob.drive.sharing.refreshShared())[0].trust;
		expect(await check()).toBe('verified');

		const signature = decodeBase64(grant.signature);
		signature[3] ^= 1;
		w.server.grants.set(grant.id, { ...grant, signature: encodeBase64(signature) });
		expect(await check()).toBe('bad-signature');
		await expect(w.bob.drive.tree.resolve(w.folder.id)).rejects.toBeInstanceOf(UntrustedGrantError);

		w.server.grants.set(grant.id, { ...grant, role: 'editor' });
		expect(await check()).toBe('bad-signature');

		w.server.grants.set(grant.id, {
			...grant,
			signature: encodeBase64(
				w.sealer.signGrant(
					{
						nodeId: grant.node_id,
						granterId: ALICE,
						granteeId: BOB,
						role: grant.role,
						generation: grant.key_generation,
						sealedKey: decodeBase64(grant.sealed_key)
					},
					w.carol.keys
				)
			)
		});
		expect(await check()).toBe('bad-signature');
	});

	it('marks the granter as changed when their pinned keys do not match', async () => {
		const w = await e2e();
		await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		expect((await w.bob.drive.sharing.refreshShared())[0].trust).toBe('verified');

		w.server.users.set(ALICE, {
			id: ALICE,
			username: 'alice',
			public_keys: testPublicKeys(fakeUser(SUITE_E2E))
		});
		w.bob.drive.sharing.contacts.refresh();
		const [entry] = await w.bob.drive.sharing.refreshShared();
		expect(entry.trust).toBe('keys-changed');
		expect(entry.changed).toBeInstanceOf(ContactKeysChangedError);
	});

	it('will not seal a new key to someone the owner never signed for', async () => {
		const w = await e2e();
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		await w.alice.drive.sharing.share(w.folder.id, 'carol', 'viewer');
		// A hostile server slips a viewer of its own in, signed by nobody.
		const planted = 'd'.repeat(32);
		w.server.users.set(planted, {
			id: planted,
			username: 'planted',
			public_keys: testPublicKeys(fakeUser(SUITE_E2E))
		});
		w.server.grants.set('e'.repeat(32), {
			...grant,
			id: 'e'.repeat(32),
			grantee_id: planted,
			grantee_username: 'planted'
		});

		await expect(w.alice.drive.sharing.revoke(grant.id, w.folder.id)).rejects.toBeInstanceOf(
			SealError
		);
		expect(w.server.nodes.get(w.folder.id)?.key_generation).toBe(1);
	});

	describe('a child whose wrap opens for nobody', () => {
		const damage = (w: Awaited<ReturnType<typeof world>>, id: string) => {
			const stored = w.server.nodes.get(id) as NonNullable<ReturnType<typeof w.server.nodes.get>>;
			const wrap = decodeBase64(stored.wrapped_key);
			wrap[wrap.length - 1] ^= 1;
			w.server.nodes.set(id, { ...stored, wrapped_key: encodeBase64(wrap) });
		};

		it('does not stop a rotation, and is counted where the owner hears of it', async () => {
			const w = await e2e();
			const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'editor');
			const bad = await w.alice.drive.tree.createFolder(w.folder.id, 'Bad');
			damage(w, bad.id);
			const progress: RotationProgress[] = [];

			await w.alice.drive.sharing.revoke(grant.id, w.folder.id, (one) => progress.push(one));

			for (const id of [w.folder.id, w.inner.id, w.file.id]) {
				expect(w.server.nodes.get(id)?.key_generation).toBe(2);
			}
			expect(w.server.nodes.get(bad.id)?.key_generation).toBe(1);
			expect(w.alice.jobs.list()).toEqual([]);
			expect(progress.at(-1)).toMatchObject({ done: 4, total: 4, unreadable: 1 });
			expect(progress.at(-1)?.topId).toBe(w.folder.id);
		});

		it('keeps the count in the job, and does not count one twice on resuming', async () => {
			const w = await e2e();
			const bad = await w.alice.drive.tree.createFolder(w.folder.id, 'Bad');
			damage(w, bad.id);
			w.alice.jobs.save({ topId: w.folder.id, done: {}, unreadable: [bad.id] });
			const saved: (string[] | undefined)[] = [];
			const save = w.alice.jobs.save;
			w.alice.jobs.save = (job) => {
				saved.push(job.unreadable);
				save(job);
			};
			const progress: RotationProgress[] = [];

			await w.alice.drive.sharing.resumeRotations((one) => progress.push(one));

			expect(saved.at(-1)).toEqual([bad.id]);
			expect(progress.at(-1)?.unreadable).toBe(1);
		});

		it('does not pass over the top: the job stays, to try again', async () => {
			const w = await e2e();
			const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
			damage(w, w.folder.id);

			await expect(w.alice.drive.sharing.revoke(grant.id, w.folder.id)).rejects.toBeInstanceOf(
				SealError
			);
			expect(w.alice.jobs.list()).toHaveLength(1);
		});
	});

	it('leaves someone holding an old key unable to read what comes after', async () => {
		const w = await e2e();
		const grant = await w.alice.drive.sharing.share(w.folder.id, 'bob', 'viewer');
		await w.bob.drive.sharing.refreshShared();
		await w.bob.drive.tree.resolve(w.folder.id);
		const retained = (await w.bob.drive.tree.nodeKey(w.folder.id)).slice() as Bytes;

		await w.alice.drive.sharing.revoke(grant.id, w.folder.id);
		const secret = await upload(w.alice, w.folder.id, 'after.bin', patterned(100));

		const stored = w.server.nodes.get(secret.id) as NonNullable<
			ReturnType<typeof w.server.nodes.get>
		>;
		expect(() =>
			w.sealer.unwrapNodeKey(decodeBase64(stored.wrapped_key), retained, w.folder.id, secret.id)
		).toThrow(SealError);
		const top = w.server.nodes.get(w.folder.id) as typeof stored;
		expect(() =>
			w.sealer.openMetadata(retained, w.folder.id, decodeBase64(top.sealed_metadata))
		).toThrow(SealError);
	});

	it('refuses a link with no key, or the wrong one, and never with the key sent', async () => {
		const w = await e2e();
		const { link, url } = await w.alice.drive.sharing.createLink(w.folder.id, {});
		const session = (fragment: string) =>
			new PublicLinkSession(link.id, w.sealer.parseLinkFragment(fragment), {
				api: w.server.as('anonymous'),
				sealer: w.sealer,
				pool: inlineFramePool(w.sealer),
				deriveRoot: async () => new Uint8Array(32) as Bytes,
				schedule: () => () => {}
			});

		expect(await session('').open()).toEqual({ kind: 'ended', why: 'no-key' });
		expect(await session(encodeBase64(new Uint8Array(32)).slice(0, 10)).open()).toEqual({
			kind: 'ended',
			why: 'no-key'
		});
		const wrong = w.sealer.linkFragment(w.sealer.newLinkKey());
		expect(await session(wrong).open()).toEqual({ kind: 'ended', why: 'bad-key' });

		expect(JSON.stringify(w.server.links.get(link.id))).not.toContain(new URL(url).hash.slice(1));
	});
});

describe('roles', () => {
	it('offers what the role allows', () => {
		const parent = { role: 'editor' as const };
		expect(canWrite({ role: 'viewer' })).toBe(false);
		expect(isOwner({ role: 'editor' })).toBe(false);
		expect(canChangePlace({ role: 'editor', parentId: null }, undefined)).toBe(false);
		expect(canChangePlace({ role: 'editor', parentId: 'p' }, parent)).toBe(true);
		expect(canChangePlace({ role: 'editor', parentId: 'p' }, { role: 'viewer' })).toBe(false);
		expect(canChangePlace({ role: 'viewer', parentId: 'p' }, parent)).toBe(false);
		expect(canChangePlace({ role: 'owner', parentId: 'p' }, undefined)).toBe(true);
	});
});
