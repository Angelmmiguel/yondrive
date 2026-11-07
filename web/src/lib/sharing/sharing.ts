/**
 * Sharing for one unlocked session: whom things are shared with, what is shared with
 * this user, and what it takes to believe either. Everything is built through the
 * `Sealer`, so in suite `none` the keys and signatures here are empty and the same
 * code runs. The one thing that always holds is that a grant counts only if its
 * granter owns the node, and, with keys, only if the granter's pinned key signed it.
 */
import type { Api } from '$lib/api/client';
import {
	isApiError,
	type Grant,
	type GrantRole,
	type Link,
	type Node,
	type NodeAccess,
	type Notification
} from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { newKdfParams, type KdfParams } from '$lib/crypto/kdf';
import { zero } from '$lib/crypto/random';
import type { GrantFields, Sealer, UserKeys } from '$lib/crypto/sealer';
import type { AuthorKeys } from '$lib/drive/download/reader';
import { newId } from '$lib/drive/ids';
import type { DriveTree } from '$lib/drive/tree';
import { ContactKeysChangedError, type Contacts } from './contacts';
import { buildLink, linkUrl, urlOfLink, type LinkOptions } from './links';
import {
	runRotation,
	type RotationDeps,
	type RotationJob,
	type RotationJobs,
	type RotationProgress
} from './rotation';

/** Whether a grant can be believed, and if not, why. */
export type GrantTrust = 'verified' | 'not-owner' | 'bad-signature' | 'keys-changed';

export interface SharedEntry {
	grant: Grant;
	node: Node;
	trust: GrantTrust;
	/** The contact whose keys did not match, when that is the reason. */
	changed?: ContactKeysChangedError;
}

/** A share that cannot be opened, as its grant could not be verified. */
export class UntrustedGrantError extends Error {
	constructor(readonly trust: GrantTrust | 'none') {
		super('this share could not be verified');
		this.name = 'UntrustedGrantError';
	}
}

export interface SharingDeps {
	api: Pick<
		Api,
		| 'getNode'
		| 'listChildren'
		| 'listTrash'
		| 'rotateNode'
		| 'listNodeAccess'
		| 'listGrantsMade'
		| 'listSharedWithMe'
		| 'createGrant'
		| 'updateGrant'
		| 'deleteGrant'
		| 'listLinks'
		| 'createLink'
		| 'revokeLink'
		| 'deleteLink'
		| 'listNotifications'
		| 'markNotificationsRead'
	>;
	sealer: Sealer;
	keys: () => UserKeys;
	userId: () => string;
	contacts: Contacts;
	jobs: RotationJobs;
	tree: () => Pick<DriveTree, 'nodeKey' | 'generationOf' | 'refresh' | 'resolve' | 'rotated'>;
	/** Argon2id over a link's password, with what to derive it with. */
	deriveRoot: (password: string, params: KdfParams) => Promise<Bytes>;
	newKdfParams?: () => KdfParams;
	origin?: () => string;
	onRotated?: (node: Node, hadThumbnail: boolean) => void;
	now?: () => number;
}

export function fieldsOf(grant: Grant): GrantFields {
	return {
		nodeId: grant.node_id,
		granterId: grant.granter_id,
		granteeId: grant.grantee_id,
		role: grant.role,
		generation: grant.key_generation,
		sealedKey: decodeBase64(grant.sealed_key)
	};
}

/** One entry of who can reach a node, with whether this owner's own signature stands behind it. */
export interface Person {
	access: NodeAccess;
	/** It has no signature of this user's: a server can add a row, but cannot sign one. */
	unsigned: boolean;
}

export class Sharing {
	readonly #deps: SharingDeps;
	#shared = new Map<string, SharedEntry>();
	#made: { grant: Grant; node: Node }[] = [];
	#links: { link: Link; node: Node }[] = [];
	readonly #running = new Map<string, Promise<void>>();

	constructor(deps: SharingDeps) {
		this.#deps = deps;
	}

	get contacts(): Contacts {
		return this.#deps.contacts;
	}

	/** Whether a grant can be believed. Reads the granter's keys through the pins. */
	async #trust(grant: Grant, node: Node): Promise<Pick<SharedEntry, 'trust' | 'changed'>> {
		const { userId, contacts, sealer } = this.#deps;
		if (
			grant.node_id !== node.id ||
			grant.grantee_id !== userId() ||
			grant.granter_id !== node.owner_id
		) {
			return { trust: 'not-owner' };
		}
		let keys;
		try {
			keys = await contacts.keysNamed(grant.granter_id, grant.granter_username);
		} catch (e) {
			if (e instanceof ContactKeysChangedError) return { trust: 'keys-changed', changed: e };
			throw e;
		}
		try {
			sealer.verifyGrant(fieldsOf(grant), decodeBase64(grant.signature), keys);
		} catch (e) {
			if (e instanceof SealError) return { trust: 'bad-signature' };
			throw e;
		}
		return { trust: 'verified' };
	}

	/** Reads everything held by this user, and checks each. */
	async refreshShared(): Promise<SharedEntry[]> {
		const { api } = this.#deps;
		const next = new Map<string, SharedEntry>();
		let cursor: string | undefined;
		do {
			const page = await api.listSharedWithMe({ cursor });
			for (const { grant, node } of page.items) {
				next.set(node.id, { grant, node, ...(await this.#trust(grant, node)) });
			}
			cursor = page.next_cursor;
		} while (cursor !== undefined);
		this.#shared = next;
		return [...next.values()];
	}

	get shared(): SharedEntry[] {
		return [...this.#shared.values()];
	}

	/** The key of a share's top, for the tree: only from a grant that verifies. */
	grantKey = async (node: Node): Promise<Bytes> => {
		const { sealer, keys } = this.#deps;
		const generation = node.key_generation ?? 1;
		let entry = this.#shared.get(node.id);
		if (entry === undefined || entry.grant.key_generation !== generation) {
			await this.refreshShared();
			entry = this.#shared.get(node.id);
		}
		if (entry === undefined) throw new UntrustedGrantError('none');
		if (entry.trust !== 'verified') throw new UntrustedGrantError(entry.trust);
		// A grant signed for an old key still verifies. Taken as this generation's key, it
		// would have what is written next sealed under a key a revoked person may hold.
		if (entry.grant.key_generation !== generation) throw new UntrustedGrantError('none');
		return sealer.openNodeKeyFrom(decodeBase64(entry.grant.sealed_key), keys(), node.id);
	};

	/**
	 * The keys to check a version's signature with. The owner may write, and so may an
	 * editor. To the owner the server gives the grants themselves, and this user's own
	 * signature on one is what says so; anyone else takes the list from the server, as
	 * docs/SECURITY.md has it. A signer who is not on the list wrote this before losing
	 * the right, or a server is lying, and the screen says which is the question.
	 */
	authorKeys = async (authorId: string, nodeId: string): Promise<AuthorKeys> => {
		const { api, contacts, userId, sealer, tree } = this.#deps;
		const me = userId();
		const node = await tree().resolve(nodeId);
		if (authorId === node.ownerId) return contacts.keysOf(authorId);
		const { access } = await api.listNodeAccess(nodeId);
		const entry = access.find((one) => one.user_id === authorId && one.role === 'editor');
		const keys = await contacts.keysOf(authorId);
		if (entry === undefined) return { ...keys, former: true };
		if (node.ownerId === me) {
			// The owner is given every signature, so a row without one is one a server added.
			if (entry.signature === undefined) return { ...keys, former: true };
			sealer.verifyGrant(
				{
					nodeId: entry.node_id ?? nodeId,
					granterId: me,
					granteeId: authorId,
					role: entry.role,
					generation: entry.key_generation ?? 1,
					sealedKey: decodeBase64(entry.sealed_key ?? '')
				},
				decodeBase64(entry.signature),
				await contacts.keysOf(me)
			);
		}
		return keys;
	};

	/** Shares a node with someone found by username, sealed to the keys they are pinned with. */
	async share(nodeId: string, username: string, role: GrantRole): Promise<Grant> {
		const { api, sealer, keys, userId, contacts, tree } = this.#deps;
		const contact = await contacts.lookup(username);
		for (let tried = 1; ; tried++) {
			const key = await tree().nodeKey(nodeId);
			const generation = tree().generationOf(nodeId) ?? 1;
			const sealedKey = sealer.sealNodeKeyTo(key, contact.keys, nodeId);
			const signature = sealer.signGrant(
				{
					nodeId,
					granterId: userId(),
					granteeId: contact.id,
					role,
					generation,
					sealedKey
				},
				keys()
			);
			try {
				const grant = await api.createGrant({
					node_id: nodeId,
					grantee_id: contact.id,
					role,
					key_generation: generation,
					sealed_key: encodeBase64(sealedKey),
					signature: encodeBase64(signature)
				});
				await this.refreshMade().catch(() => {});
				return grant;
			} catch (e) {
				if (tried >= 3 || !isApiError(e, 'key_generation_conflict')) throw e;
				await tree().refresh(nodeId);
			}
		}
	}

	/** Who can reach a node, nearest first. */
	async people(nodeId: string): Promise<Person[]> {
		const { api, sealer, userId, contacts, tree } = this.#deps;
		const { access } = await api.listNodeAccess(nodeId);
		const me = userId();
		// Only the owner is given signatures, and only they can tell a row is missing one.
		if ((await tree().resolve(nodeId)).ownerId !== me) {
			return access.map((entry) => ({ access: entry, unsigned: false }));
		}
		const own = await contacts.keysOf(me);
		return access.map((entry) => {
			let unsigned = entry.signature === undefined;
			if (entry.signature !== undefined) {
				try {
					sealer.verifyGrant(
						{
							nodeId: entry.node_id ?? nodeId,
							granterId: me,
							granteeId: entry.user_id,
							role: entry.role,
							generation: entry.key_generation ?? 1,
							sealedKey: decodeBase64(entry.sealed_key ?? '')
						},
						decodeBase64(entry.signature),
						own
					);
				} catch {
					unsigned = true;
				}
			}
			return { access: entry, unsigned };
		});
	}

	/** A role is signed, so changing it signs again, over the same sealed key. */
	async changeRole(access: NodeAccess, nodeId: string, role: GrantRole): Promise<void> {
		const { api, sealer, keys, userId } = this.#deps;
		if (access.grant_id === undefined) throw new Error('that is not a grant of this user');
		const signature = sealer.signGrant(
			{
				nodeId: access.node_id ?? nodeId,
				granterId: userId(),
				granteeId: access.user_id,
				role,
				generation: access.key_generation ?? 1,
				sealedKey: decodeBase64(access.sealed_key ?? '')
			},
			keys()
		);
		await api.updateGrant(access.grant_id, { role, signature: encodeBase64(signature) });
		await this.refreshMade().catch(() => {});
	}

	#rotation(): RotationDeps {
		const { api, sealer, keys, userId, contacts, jobs, tree, onRotated, now } = this.#deps;
		return {
			api,
			sealer,
			keys,
			userId,
			keysOf: (id) => contacts.keysOf(id),
			parentKey: async (id) => {
				await tree().refresh(id);
				return tree().nodeKey(id);
			},
			jobs,
			now,
			onRotated: (record, key, hadThumbnail) => {
				tree().rotated(record, key);
				onRotated?.(record, hadThumbnail);
			}
		};
	}

	/**
	 * Ends someone's access, then replaces the keys they may have kept, from the node of
	 * the grant down. The job is written down first, so that nothing is lost if this
	 * stops: access has ended by then, and what is left resumes at the next unlock.
	 */
	async revoke(
		grantId: string,
		nodeId: string,
		onProgress?: (progress: RotationProgress) => void
	): Promise<void> {
		const { api, jobs } = this.#deps;
		const known = jobs.list().find((job) => job.topId === nodeId);
		const job = known ?? { topId: nodeId, done: {} };
		jobs.save(job);
		try {
			await api.deleteGrant(grantId);
		} catch (e) {
			if (known === undefined) jobs.remove(nodeId);
			throw e;
		}
		await this.#run(job, onProgress);
		await this.refreshMade().catch(() => {});
	}

	/** One rotation of a job at a time: a job can be started from a revocation and from the journal. */
	#run(job: RotationJob, onProgress?: (progress: RotationProgress) => void): Promise<void> {
		const running = this.#running.get(job.topId);
		if (running !== undefined) return running;
		const run = runRotation(job, this.#rotation(), onProgress).finally(() => {
			this.#running.delete(job.topId);
		});
		this.#running.set(job.topId, run);
		return run;
	}

	/**
	 * Gives up a grant this user holds. Nothing to rotate from here: the owner's client
	 * does that, from the `revoked` row in their journal.
	 */
	async leave(grantId: string, nodeId: string): Promise<void> {
		await this.#deps.api.deleteGrant(grantId);
		this.#shared.delete(nodeId);
	}

	/**
	 * Writes down a rotation for each of these nodes this user owns, and has none for
	 * already: one in hand is this device's own revocation. What cannot be read now is
	 * left, and the journal still shows it at the next unlock. Whether any was added.
	 */
	async queueRotations(nodeIds: readonly string[]): Promise<boolean> {
		const { api, jobs, userId } = this.#deps;
		let queued = false;
		for (const id of nodeIds) {
			if (jobs.list().some((job) => job.topId === id)) continue;
			const node = await api.getNode(id).catch(() => null);
			if (node?.owner_id !== userId() || node.parent_id === undefined) continue;
			jobs.save({ topId: id, done: {} });
			queued = true;
		}
		return queued;
	}

	/** Rotations a previous session left unfinished. */
	get pendingRotations(): string[] {
		return this.#deps.jobs.list().map((job) => job.topId);
	}

	async resumeRotations(onProgress?: (progress: RotationProgress) => void): Promise<void> {
		// One that cannot finish does not keep the others under old keys.
		const failed: unknown[] = [];
		for (const job of this.#deps.jobs.list()) {
			await this.#run(job, onProgress).catch((e: unknown) => failed.push(e));
		}
		if (failed.length > 0) throw failed[0];
	}

	/** All that this user has shared: the "shared by me" page and the people on a row. */
	async refreshMade(): Promise<void> {
		const { api } = this.#deps;
		const made: { grant: Grant; node: Node }[] = [];
		let cursor: string | undefined;
		do {
			const page = await api.listGrantsMade({ cursor });
			made.push(...page.items);
			cursor = page.next_cursor;
		} while (cursor !== undefined);
		const links: { link: Link; node: Node }[] = [];
		cursor = undefined;
		do {
			const page = await api.listLinks({ cursor });
			links.push(...page.items);
			cursor = page.next_cursor;
		} while (cursor !== undefined);
		this.#made = made;
		this.#links = links;
	}

	get made(): readonly { grant: Grant; node: Node }[] {
		return this.#made;
	}

	get links(): readonly { link: Link; node: Node }[] {
		return this.#links;
	}

	linksOf(nodeId: string): Link[] {
		return this.#links.filter(({ link }) => link.node_id === nodeId).map(({ link }) => link);
	}

	/** Makes a public link, and gives its address, with its key, the one time it is easy to. */
	async createLink(
		nodeId: string,
		options: { expiresAt?: Date; downloadLimit?: number; password?: string }
	): Promise<{ link: Link; url: string }> {
		const { api, sealer, keys, tree, deriveRoot } = this.#deps;
		const params: LinkOptions = {
			expiresAt: options.expiresAt,
			downloadLimit: options.downloadLimit
		};
		let root: Bytes | undefined;
		if (options.password !== undefined) {
			const kdf = (this.#deps.newKdfParams ?? newKdfParams)();
			root = await deriveRoot(options.password, kdf);
			params.password = { kdf, root };
		}
		try {
			for (let tried = 1; ; tried++) {
				const id = newId();
				const { body, fragment } = buildLink(
					{
						id,
						nodeId,
						nodeKey: await tree().nodeKey(nodeId),
						generation: tree().generationOf(nodeId) ?? 1
					},
					params,
					sealer,
					keys()
				);
				try {
					const link = await api.createLink(body);
					await this.refreshMade().catch(() => {});
					return { link, url: linkUrl(this.#origin(), id, fragment) };
				} catch (e) {
					if (tried >= 3 || !isApiError(e, 'key_generation_conflict')) throw e;
					await tree().refresh(nodeId);
				}
			}
		} finally {
			if (root !== undefined) zero(root);
		}
	}

	#origin(): string {
		return this.#deps.origin?.() ?? location.origin;
	}

	/** The address of a link made earlier. */
	urlOf(link: Link): string {
		const { sealer, keys } = this.#deps;
		try {
			return urlOfLink(this.#origin(), link, sealer, keys());
		} catch {
			// Its copy does not open, as a server could arrange: no address to show.
			return '';
		}
	}

	async revokeLink(id: string): Promise<void> {
		await this.#deps.api.revokeLink(id);
		await this.refreshMade().catch(() => {});
	}

	async deleteLink(id: string): Promise<void> {
		await this.#deps.api.deleteLink(id);
		await this.refreshMade().catch(() => {});
	}

	/** People on a node's row: those it is shared with, also through a folder above it. */
	peopleOf(trail: readonly { id: string; ownerId: string }[]): string[] {
		const me = this.#deps.userId();
		const names = new Set<string>();
		for (const node of trail) {
			if (node.ownerId === me) {
				for (const { grant } of this.#made) {
					if (grant.node_id === node.id) names.add(grant.grantee_username);
				}
			} else {
				const entry = this.#shared.get(node.id);
				if (entry !== undefined) names.add(entry.grant.granter_username);
			}
		}
		return [...names];
	}

	/** What is unread, with who shared it where this user has seen the grant. */
	async notifications(): Promise<{ list: Notification[]; more: boolean }> {
		const { notifications, has_more: more } = await this.#deps.api.listNotifications();
		return { list: notifications, more };
	}

	markRead(grantIds?: string[]): Promise<void> {
		return this.#deps.api.markNotificationsRead({ grant_ids: grantIds });
	}
}
