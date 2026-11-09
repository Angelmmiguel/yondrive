/**
 * Sharing as the screens see it: what is shared, what is unread, and the warning that
 * stops everything when a contact's keys change. It wraps the `Sharing` of the drive
 * of this session, which is attached and detached with it.
 */
import type { CommentNotification, Grant, Link, Node, Notification } from '$lib/api/types';
import { ContactKeysChangedError } from '$lib/sharing/contacts';
import type { RotationProgress } from '$lib/sharing/rotation';
import type { SharedEntry, Sharing } from '$lib/sharing/sharing';

export class SharingState {
	shared = $state.raw<SharedEntry[]>([]);
	sharedLoaded = $state(false);
	made = $state.raw<readonly { grant: Grant; node: Node }[]>([]);
	links = $state.raw<readonly { link: Link; node: Node }[]>([]);
	unread = $state.raw<Notification[]>([]);
	/** Files with comments by others this user has not seen. */
	commented = $state.raw<CommentNotification[]>([]);
	/** A contact whose keys are not the pinned ones. Blocks the app until someone decides. */
	changed = $state.raw<ContactKeysChangedError | null>(null);
	/** Whose safety number is on screen. */
	comparing = $state.raw<{ userId: string; username: string } | null>(null);
	/** A rotation under way, here or going on from an earlier session. */
	rotation = $state.raw<RotationProgress | null>(null);
	/** How many items each rotation could not re-key, until the owner has seen it. */
	unrekeyed = $state.raw<Record<string, number>>({});

	core: Sharing | null = null;

	attach(core: Sharing): void {
		this.core = core;
	}

	/** On a lock or sign-out. */
	detach(): void {
		this.core = null;
		this.shared = [];
		this.sharedLoaded = false;
		this.made = [];
		this.links = [];
		this.unread = [];
		this.commented = [];
		this.changed = null;
		this.comparing = null;
		this.rotation = null;
		this.unrekeyed = {};
	}

	/** What is in `Sharing` now, for the screens. */
	#publish(core: Sharing): void {
		this.shared = core.shared;
		this.made = core.made;
		this.links = core.links;
	}

	/** Reads it all again, on start and whenever the journal says something moved. */
	async sync(): Promise<void> {
		const core = this.core;
		if (core === null) return;
		try {
			await core.refreshShared();
			await core.refreshMade();
			const { list, comments } = await core.notifications();
			if (this.core !== core) return;
			this.unread = list;
			this.commented = comments;
		} catch (e) {
			this.warn(e);
		}
		if (this.core !== core) return;
		this.#publish(core);
		this.sharedLoaded = true;
		const changed = core.shared.find((entry) => entry.changed !== undefined)?.changed;
		if (changed !== undefined && this.changed === null) this.changed = changed;
	}

	/** After something here changed what `Sharing` holds. */
	publish(): void {
		if (this.core !== null) this.#publish(this.core);
	}

	/** Takes a changed key to the warning. Whether it was one. */
	warn(e: unknown): boolean {
		if (!(e instanceof ContactKeysChangedError)) return false;
		this.changed = e;
		return true;
	}

	async markAllRead(): Promise<void> {
		if (this.core === null || (this.unread.length === 0 && this.commented.length === 0)) return;
		this.unread = [];
		this.commented = [];
		await this.core.markRead().catch(() => {});
	}

	/** The comments on a file have been seen, where they show. */
	async markCommentsRead(nodeId: string): Promise<void> {
		if (this.core === null || !this.commented.some((one) => one.node_id === nodeId)) return;
		this.commented = this.commented.filter((one) => one.node_id !== nodeId);
		await this.core.markCommentsRead([nodeId]).catch(() => {});
	}

	async markRead(grantId: string): Promise<void> {
		if (this.core === null) return;
		this.unread = this.unread.filter((one) => one.grant_id !== grantId);
		await this.core.markRead([grantId]).catch(() => {});
	}

	/** The people on a node's row, from the node up. */
	peopleOf(trail: readonly { id: string; ownerId: string }[]): string[] {
		void this.made;
		void this.shared;
		return this.core?.peopleOf(trail) ?? [];
	}

	entryOf(nodeId: string): SharedEntry | undefined {
		return this.shared.find((entry) => entry.node.id === nodeId);
	}

	/** Where a rotation has got to. What it could not re-key stays after it has ended. */
	track(progress: RotationProgress | null): void {
		this.rotation = progress;
		if (progress?.topId === undefined) return;
		const next = { ...this.unrekeyed };
		if (progress.unreadable) next[progress.topId] = progress.unreadable;
		else delete next[progress.topId];
		this.unrekeyed = next;
	}

	get unrekeyedCount(): number {
		return Object.values(this.unrekeyed).reduce((all, one) => all + one, 0);
	}

	dismissUnrekeyed(): void {
		this.unrekeyed = {};
	}

	/**
	 * Revokes a grant and replaces the keys, with the progress where the screens can see
	 * it. Returns how many items of it could not be re-keyed.
	 */
	async revoke(grantId: string, nodeId: string): Promise<number> {
		const core = this.core;
		if (core === null) return 0;
		this.rotation = { done: 0, total: 1 };
		let unreadable = 0;
		try {
			await core.revoke(grantId, nodeId, (progress) => {
				unreadable = progress.unreadable ?? 0;
				this.track(progress);
			});
			return unreadable;
		} finally {
			this.rotation = null;
			this.#publish(core);
		}
	}
}

export const sharing = new SharingState();
