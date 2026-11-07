/** Drive's sentences for what can go wrong, on top of the account layer's. */
import { describeError, LockedError } from '$lib/account/errors';
import { SealError } from '$lib/crypto/aead';
import { ZeroKeyError } from '$lib/crypto/random';
import { ApiError, type ErrorCode } from '$lib/api/types';
import { InvalidNameError } from './names';

/** More than this client will hold in memory on a connection with no service worker. */
export class TooLargeForMemoryError extends Error {
	constructor(readonly limit: number) {
		super('too large to read into memory');
		this.name = 'TooLargeForMemoryError';
	}
}

/** The name in a folder belongs to something that cannot be reused. */
export class NameTakenError extends Error {
	constructor() {
		super('name taken');
		this.name = 'NameTakenError';
	}
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
	name_conflict: 'Something with that name is already in this folder. Choose another name.',
	quota_exceeded: 'There is not enough room left in your storage for this.',
	storage_full: 'The server has run out of disk space. Ask your administrator.',
	move_cycle: 'A folder cannot be moved into itself.',
	tree_too_deep: 'Folders cannot be nested any deeper here.',
	not_a_folder: 'That is not a folder.',
	node_trashed: 'That is in the trash. Restore it first.',
	parent_trashed: 'The folder it belongs in is in the trash. Restore that first.',
	not_trashed: 'That is no longer in the trash.',
	version_conflict: 'This file changed in the meantime. Reload and try again.',
	version_current: 'The current version cannot be deleted.',
	root_immutable: 'Your top folder cannot be changed.',
	upload_incomplete: 'Part of this file did not arrive. Try uploading it again.',
	suite_mismatch: 'This client and the server disagree about how files are stored.',
	too_large: 'That is too large for the server to accept.'
};

const NAME_MESSAGES: Record<InvalidNameError['reason'], string> = {
	empty: 'Type a name.',
	dots: 'That name is reserved. Choose another.',
	separator: 'A name cannot contain a slash or a backslash.',
	long: 'That name is too long.'
};

const limitText = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** A sentence for the person at the screen. Never includes anything sensitive. */
export function describeDriveError(e: unknown): string {
	if (e instanceof InvalidNameError) return NAME_MESSAGES[e.reason];
	if (e instanceof NameTakenError) return MESSAGES.name_conflict as string;
	if (e instanceof ZeroKeyError || e instanceof LockedError) {
		return 'The app was locked before this could finish.';
	}
	if (e instanceof SealError) {
		return 'This content failed its integrity check, so it was not opened. It may be damaged or may have been changed on the server.';
	}
	if (e instanceof TooLargeForMemoryError) {
		return `Without HTTPS the browser has to hold a file in memory, up to ${limitText(e.limit)}, and this one is larger. Reach this server over HTTPS to download it.`;
	}
	if (e instanceof ApiError) {
		const message = MESSAGES[e.code];
		if (message !== undefined) return message;
	}
	return describeError(e);
}
