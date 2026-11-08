import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/types';
import { decodeBase64, encodeBase64 } from '$lib/crypto/encoding';
import { deriveLinkRoot } from '$lib/crypto/kdf';
import { sealerFor, type Suite } from '$lib/crypto/sealer';
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
	USER_ID
} from '$lib/testing/drive';
import { memoryPinStorage } from './contacts';
import { adoptedMetadata, adoptIncoming, listIncoming, UnreadableIncomingError } from './incoming';
import { buildRequest, linkStatus, requestUrl, urlOfLink } from './links';
import { viewerFor } from '$lib/drive/viewers/kinds';
import { SUITE_E2E, SUITE_NONE } from '$lib/crypto/sealer';
import { WrongLinkPasswordError } from './public';
import { MAX_FROM, modeRefusal, RequestSender, RequestSession, UploadGoneError } from './request';

const streams = (): StreamClient => ({
	open: async () => null,
	release: () => {},
	clear: () => {},
	stop: () => {}
});

/** An owner with a folder to ask for files into, on a fake server. */
async function owner(suite: Suite) {
	const server = fakeDriveServer(suite);
	const sealer = sealerFor(suite);
	const keys = fakeUser(suite);
	const drive = new Drive({
		api: server.as(USER_ID),
		sealer,
		keys: () => keys,
		userId: () => USER_ID,
		open: async (key, parent, records) => openNodes(sealer, key, parent, records),
		pool: inlineFramePool(sealer),
		resume: memoryResumeStore(),
		streams: streams(),
		saveUrl: () => {},
		saveBlob: () => {},
		pins: memoryPinStorage(),
		deriveLinkRoot: async (password, params) => deriveLinkRoot(password, params),
		linkKdf: CHEAP_KDF,
		origin: () => 'https://drive.example',
		sleep: async () => {}
	});
	await drive.start();
	const folder = await drive.tree.createFolder(drive.tree.rootId as string, 'Inbox');
	const deps = { api: server.as(USER_ID), sealer, keys: () => keys, tree: drive.tree };
	return { server, sealer, keys, drive, folder, deps };
}

type Owner = Awaited<ReturnType<typeof owner>>;

function sender(o: Owner, url: string) {
	const { pathname, hash } = new URL(url);
	return new RequestSession(pathname.split('/')[2], o.sealer.parseRequestFragment(hash.slice(1)), {
		api: o.server.as('anonymous'),
		sealer: o.sealer,
		pool: inlineFramePool(o.sealer),
		deriveRoot: async (password, params) => deriveLinkRoot(password, params),
		schedule: () => () => {},
		sleep: async () => {},
		frameSize: 1024
	});
}

async function send(session: RequestSession, name: string, bytes: Uint8Array, note = {}) {
	const file = { ...fakeFile(name, bytes), type: '' };
	const sending = await session.begin(file, note);
	await session.transfer(file, sending);
}

async function read(o: Owner, nodeId: string) {
	const node = await o.drive.tree.resolve(nodeId);
	const version = await o.drive.openVersion(node);
	return new Uint8Array(await (await o.drive.readBlob(node, version)).arrayBuffer());
}

describe.each(SUITES)('file requests in mode %s', (_, suite) => {
	it('takes files from anyone with the address, and the owner adopts them', async () => {
		const o = await owner(suite);
		const { link, url } = await o.drive.sharing.createRequest(o.folder.id, { fileLimit: 5 });
		expect(new URL(url).pathname).toBe(`/r/${link.id}`);
		expect(new URL(url).hash === '').toBe(!o.sealer.encrypted);
		expect(o.drive.sharing.urlOf(link)).toBe(url);
		expect(link).toMatchObject({ kind: 'request', file_limit: 5, sealed_key: '' });

		const session = sender(o, url);
		expect(await session.open()).toEqual({ kind: 'open' });
		expect(session.room.filesRemaining).toBe(5);
		const bytes = patterned(2500);
		await send(session, 'report.pdf', bytes, { from: 'Dana', message: 'As asked.' });
		expect(session.room.filesRemaining).toBe(4);

		const [item] = await listIncoming(o.deps);
		expect(item.size).toBe(2500);
		const node = await adoptIncoming(item, o.deps);
		expect(node.parent_id).toBe(o.folder.id);
		expect(await listIncoming(o.deps)).toEqual([]);

		const adopted = await o.drive.tree.resolve(node.id);
		expect(adopted.name).toBe('report.pdf');
		expect(adopted.raw.request).toMatchObject({
			link: link.id,
			from: 'Dana',
			message: 'As asked.'
		});
		expect(await read(o, node.id)).toEqual(bytes);
	});

	it('names a file that clashes as an upload would', async () => {
		const o = await owner(suite);
		await o.drive.tree.createFolder(o.folder.id, 'notes.txt');
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {});
		const session = sender(o, url);
		await session.open();
		await send(session, 'notes.txt', patterned(10));
		const [item] = await listIncoming(o.deps);
		const node = await adoptIncoming(item, o.deps);
		expect((await o.drive.tree.resolve(node.id)).name).toBe('notes (2).txt');
	});

	it('asks for a password, and refuses a wrong one', async () => {
		const o = await owner(suite);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {
			password: 'a long password'
		});
		expect(new URL(url).hash === '').toBe(!o.sealer.encrypted);
		const session = sender(o, url);
		expect(await session.open()).toEqual({ kind: 'password' });
		await expect(session.unlock('wrong password')).rejects.toBeInstanceOf(WrongLinkPasswordError);
		expect(await session.unlock('a long password')).toEqual({ kind: 'open' });
	});

	it('stops at each limit with its code, and checks what it can before sending', async () => {
		const o = await owner(suite);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {
			maxFileSize: 2000,
			fileLimit: 2,
			bytesLimit: 3000
		});
		const session = sender(o, url);
		await session.open();
		expect(session.refusal(2001)).toBe('too-large');
		const big = { ...fakeFile('big', patterned(2001)), type: '' };
		await expect(session.begin(big, {})).rejects.toMatchObject({ code: 'request_file_too_large' });
		await send(session, 'a', patterned(2000));
		await expect(session.begin(fakeFile('b', patterned(1001)), {})).rejects.toMatchObject({
			code: 'request_bytes_reached'
		});
		await send(session, 'c', patterned(500));
		expect(session.refusal(1)).toBe('no-files');
		await expect(session.begin(fakeFile('d', patterned(1)), {})).rejects.toMatchObject({
			code: 'request_files_reached'
		});
	});

	it('says why a request has ended', async () => {
		const o = await owner(suite);
		const { link, url } = await o.drive.sharing.createRequest(o.folder.id, {});
		await o.drive.sharing.revokeLink(link.id);
		expect(await sender(o, url).open()).toEqual({ kind: 'ended', why: 'revoked' });
		const view = await o.drive.sharing.createLink(o.folder.id, {});
		const asRequest = url.replace(link.id, view.link.id);
		expect(await sender(o, asRequest).open()).toEqual({ kind: 'ended', why: 'gone' });
	});

	it('cuts what the sender said to size, and keeps it as text', () => {
		const item = { link_id: 'l', size: 3, created_at: '2026-01-01T00:00:00Z' } as never;
		const out = adoptedMetadata(
			item,
			{ name: '../evil/name', modified: 'soon', request: { from: 'x'.repeat(500), message: 4 } },
			7
		);
		expect(out.name).toBe('Untitled file');
		expect(out.modified).toBe(7);
		expect(out.size).toBe(3);
		expect(out.request.from).toHaveLength(MAX_FROM);
		expect(out.request.message).toBeUndefined();
	});
});

describe('file requests with keys', () => {
	const suite = SUITES[0][1];

	it('refuses an address whose key is missing or is not the one the server has', async () => {
		const o = await owner(suite);
		const { link, url } = await o.drive.sharing.createRequest(o.folder.id, {});
		expect(await sender(o, url.split('#')[0]).open()).toEqual({ kind: 'ended', why: 'no-key' });
		const other = o.sealer.newRequestKeys().publicKey;
		const swapped = `${url.split('#')[0]}#${o.sealer.requestFragment(other)}`;
		expect(await sender(o, swapped).open()).toEqual({ kind: 'ended', why: 'bad-key' });
		// A server that names a key of its own is refused the same way.
		o.server.state.requestKey = encodeBase64(other);
		expect(await sender(o, url).open()).toEqual({ kind: 'ended', why: 'bad-key' });
		o.server.state.requestKey = null;
		expect(link.public_key).not.toBe('');
	});

	it('gives no address for a request whose public key the server swapped', async () => {
		const o = await owner(suite);
		const { link } = await o.drive.sharing.createRequest(o.folder.id, {});
		const swapped = { ...link, public_key: encodeBase64(o.sealer.newRequestKeys().publicKey) };
		expect(() => urlOfLink('https://x', swapped, o.sealer, o.keys)).toThrow();
		expect(o.drive.sharing.urlOf(swapped)).toBe('');
	});

	it('refuses to adopt what was not sealed to the request', async () => {
		const o = await owner(suite);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {});
		const session = sender(o, url);
		await session.open();
		await send(session, 'x', patterned(10));
		const [item] = await listIncoming(o.deps);
		const forged = o.sealer.sealNodeKeyToRequest(
			o.sealer.newNodeKey(),
			decodeBase64(item.public_key),
			item.link_id,
			'f'.repeat(32)
		);
		await expect(
			adoptIncoming({ ...item, sealed_key: encodeBase64(forged) }, o.deps)
		).rejects.toBeInstanceOf(UnreadableIncomingError);
		await expect(
			adoptIncoming({ ...item, frame_count: item.frame_count + 1 }, o.deps)
		).rejects.toBeInstanceOf(UnreadableIncomingError);
		const otherKeys = fakeUser(suite);
		await expect(adoptIncoming(item, { ...o.deps, keys: () => otherKeys })).rejects.toBeInstanceOf(
			UnreadableIncomingError
		);
	});

	it('builds a request whose private key is under the master key alone', () => {
		const sealer = sealerFor(suite);
		const keys = fakeUser(suite);
		const { body, fragment } = buildRequest(
			{ id: 'a'.repeat(32), folderId: 'b'.repeat(32), generation: 3 },
			{ fileLimit: 2 },
			sealer,
			keys
		);
		expect(body).toMatchObject({
			kind: 'request',
			key_generation: 3,
			file_limit: 2,
			sealed_key: ''
		});
		expect(decodeBase64(body.owner_sealed_key)).toHaveLength(73);
		expect(body.public_key).toBe(encodeBase64(sealer.parseRequestFragment(fragment)));
		expect(requestUrl('https://x', 'id', fragment)).toBe(`https://x/r/id#${fragment}`);
		expect(requestUrl('https://x', 'id', '')).toBe('https://x/r/id');
	});
});

describe('the sender', () => {
	it('sends a pile a few at a time, resumes a failure from the frames that arrived, and forgets names', async () => {
		const o = await owner(SUITES[0][1]);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, { fileLimit: 3 });
		const session = sender(o, url);
		await session.open();
		const queue = new RequestSender(session);
		let fail = true;
		o.server.state.failFrame = (index) =>
			index === 1 && fail ? ((fail = false), new ApiError(400, 'frame_length')) : null;

		expect(
			queue.add([fakeFile('a', patterned(3000)), fakeFile('b', patterned(10))], {})
		).toBeNull();
		expect(queue.add([fakeFile('c', patterned(1)), fakeFile('d', patterned(1))], {})).toBe(
			'no-files'
		);
		await vi.waitFor(() => expect(queue.active).toBe(false), { interval: 5 });
		const failed = queue.items.find((i) => i.status === 'failed');
		expect(failed?.name).toBe('a');
		const before = o.server.calls.filter((c) => c.startsWith('request frame')).length;
		queue.retry(failed?.id as number);
		await vi.waitFor(() => expect(queue.active).toBe(false), { interval: 5 });
		expect(queue.items.every((i) => i.status === 'sent')).toBe(true);
		// Only what had not arrived went again.
		const again = o.server.calls.filter((c) => c.startsWith('request frame')).length - before;
		expect(again).toBeLessThan(3);

		queue.clear();
		expect(queue.items).toEqual([]);
		const items = await listIncoming(o.deps);
		expect(items).toHaveLength(2);
		for (const item of items) await adoptIncoming(item, o.deps);
		await o.drive.tree.loadFolder(o.folder.id, true);
		const names = o.drive.tree.childrenOf(o.folder.id).map((n) => n.name);
		expect(names.sort()).toEqual(['a', 'b']);
	});

	it('cancels a file and gives its place back', async () => {
		const o = await owner(SUITES[1][1]);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, { fileLimit: 1 });
		const session = sender(o, url);
		await session.open();
		const file = fakeFile('a', patterned(10));
		const sending = await session.begin(file, {});
		await session.abandon(sending);
		await send(session, 'b', patterned(10));
		expect(await listIncoming(o.deps)).toHaveLength(1);
	});
});

describe('the status of a request', () => {
	it('is used up once every file has arrived', () => {
		const link = {
			kind: 'request',
			download_count: 0,
			file_limit: 2,
			files_received: 2
		} as never;
		expect(linkStatus(link, 0)).toBe('used-up');
	});
});

describe('what a hostile server is refused', () => {
	it('refuses a server that says it encrypts nothing, for an address with a key', () => {
		expect(modeRefusal('somekey', sealerFor(SUITE_NONE))).toBe('downgraded');
		expect(modeRefusal('', sealerFor(SUITE_NONE))).toBeNull();
		expect(modeRefusal('somekey', sealerFor(SUITE_E2E))).toBeNull();
		expect(modeRefusal('', sealerFor(SUITE_E2E))).toBeNull();
	});

	it('names a server whose files are sealed otherwise', async () => {
		const o = await owner(SUITE_E2E);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {});
		const { pathname } = new URL(url);
		const none = sealerFor(SUITE_NONE);
		const session = new RequestSession(pathname.split('/')[2], new Uint8Array(0), {
			api: o.server.as('anonymous'),
			sealer: none,
			pool: inlineFramePool(none),
			deriveRoot: async (password, params) => deriveLinkRoot(password, params),
			schedule: () => () => {}
		});
		expect(await session.open()).toEqual({ kind: 'ended', why: 'wrong-mode' });
	});

	it('refuses an item the server put in another folder, or in one that is not the owner’s', async () => {
		const o = await owner(SUITE_E2E);
		const other = await o.drive.tree.createFolder(o.drive.tree.rootId as string, 'Elsewhere');
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {});
		const session = sender(o, url);
		await session.open();
		await send(session, 'x', patterned(10));
		const [item] = await listIncoming(o.deps);
		await expect(adoptIncoming({ ...item, folder_id: other.id }, o.deps)).rejects.toBeInstanceOf(
			UnreadableIncomingError
		);
		const shared = {
			...o.deps,
			tree: {
				...o.deps.tree,
				resolve: async (id: string) => ({
					...(await o.drive.tree.resolve(id)),
					role: 'editor' as const
				}),
				nodeKey: (id: string) => o.drive.tree.nodeKey(id),
				generationOf: (id: string) => o.drive.tree.generationOf(id),
				refresh: (id: string) => o.drive.tree.refresh(id)
			}
		};
		await expect(adoptIncoming(item, shared)).rejects.toBeInstanceOf(UnreadableIncomingError);
		// The swapped folder also gives no address.
		const { link } = await o.drive.sharing.createRequest(o.folder.id, {});
		expect(o.drive.sharing.urlOf({ ...link, node_id: other.id })).toBe('');
		expect(await adoptIncoming(item, o.deps)).toMatchObject({ parent_id: o.folder.id });
	});
});

describe('a sender whose upload went away', () => {
	it('starts the file over once the server has dropped it, and says so after', async () => {
		const o = await owner(SUITE_NONE);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {});
		const session = sender(o, url);
		await session.open();
		const file = fakeFile('a', patterned(3000));
		const sending = await session.begin(file, {});
		o.server.requestUploads.delete(sending.uploadId);
		await expect(session.transfer(file, sending)).rejects.toBeInstanceOf(UploadGoneError);

		const queue = new RequestSender(session);
		let drop = true;
		o.server.state.failFrame = (index) => {
			if (index !== 1 || !drop) return null;
			drop = false;
			o.server.requestUploads.clear();
			return new ApiError(404, 'not_found');
		};
		queue.add([fakeFile('b', patterned(3000))], {});
		await vi.waitFor(() => expect(queue.active).toBe(false), { interval: 5 });
		expect(queue.items[0].status).toBe('sent');
		expect(await listIncoming(o.deps)).toHaveLength(1);
	});

	it('takes a commit answered twice as one file, and a commit of nothing as a failure', async () => {
		const o = await owner(SUITE_NONE);
		const { link, url } = await o.drive.sharing.createRequest(o.folder.id, {});
		const session = sender(o, url);
		await session.open();
		const file = fakeFile('a', patterned(10));
		const sending = await session.begin(file, {});
		await session.transfer(file, sending);
		const api = o.server.as('anonymous');
		const token = `${link.id}.1`;
		const sealed = { sealed_key: '', sealed_metadata: 'e30=' };
		await expect(
			api.commitRequestUpload(link.id, sending.uploadId, token, sealed)
		).resolves.toBeUndefined();
		expect(await listIncoming(o.deps)).toHaveLength(1);
		await expect(
			api.commitRequestUpload(link.id, 'r'.repeat(32), token, sealed)
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('asks for the password again when the session runs out', async () => {
		const o = await owner(SUITE_NONE);
		const { url } = await o.drive.sharing.createRequest(o.folder.id, {
			password: 'a long password'
		});
		const { pathname } = new URL(url);
		let locked = false;
		const session = new RequestSession(pathname.split('/')[2], new Uint8Array(0), {
			api: o.server.as('anonymous'),
			sealer: o.sealer,
			pool: inlineFramePool(o.sealer),
			deriveRoot: async (password, params) => deriveLinkRoot(password, params),
			schedule: () => () => {},
			onlocked: () => (locked = true),
			onended: () => {
				throw new Error('not an ending');
			}
		});
		await session.open();
		await session.unlock('a long password');
		// A token the server no longer takes: what renews it finds the password asked for.
		o.server.state.forgetSessions = true;
		await session.renew();
		expect(locked).toBe(true);
	});
});

describe('what the owner keeps of what arrived', () => {
	const item = { link_id: 'l', size: 3, created_at: 'not a time' } as never;

	it('takes a media type only in its form, and a time only if it is one', () => {
		const html = adoptedMetadata(item, { name: 'page.html', type: 'text/html' }, 1);
		expect(html.type).toBe('text/html');
		expect(viewerFor(html)).toBeNull();
		expect(
			viewerFor(adoptedMetadata(item, { name: 'a.svg', type: 'image/svg+xml' }, 1))
		).toBeNull();
		const odd = adoptedMetadata(item, { name: 'notes.txt', type: 'text/plain; x="<b>"' }, 1);
		expect(odd.type).toBe('text/plain');
		expect(
			adoptedMetadata(item, { name: 'x.bin', type: `a/${'b'.repeat(300)}` }, 1).type
		).not.toContain('bbb');
		expect(html.request.received).toBeUndefined();
		expect(JSON.parse(JSON.stringify(html.request))).not.toHaveProperty('received');
	});

	it('counts a request whose bytes are all taken as used up', () => {
		const link = {
			kind: 'request',
			download_count: 0,
			bytes_limit: 10,
			bytes_received: 10
		} as never;
		expect(linkStatus(link, 0)).toBe('used-up');
	});
});
