/**
 * What someone may do with a node, as the screens ask it. The server decides; this
 * only keeps from offering what it would refuse. Renaming, moving and trashing change
 * the folder a node lives in, so they take write access to that folder, and a share's
 * top node has none anyone but the owner can see.
 */
import type { GrantRole, NodeRole } from '$lib/api/types';

export interface RoleFacts {
	role: NodeRole;
	parentId: string | null;
}

export const canWrite = (node: Pick<RoleFacts, 'role'>): boolean =>
	node.role === 'owner' || node.role === 'editor';

/** Writes comments: everyone but a viewer. Resolving them and moving their anchors takes `canWrite`. */
export const canComment = (node: Pick<RoleFacts, 'role'>): boolean => node.role !== 'viewer';

export const isOwner = (node: Pick<RoleFacts, 'role'>): boolean => node.role === 'owner';

/** Whether it can be renamed, moved or trashed, given the role over its parent, if that is known. */
export function canChangePlace(
	node: RoleFacts,
	parent: Pick<RoleFacts, 'role'> | undefined
): boolean {
	if (!canWrite(node) || node.parentId === null) return false;
	return parent === undefined ? node.role === 'owner' : canWrite(parent);
}

/** What a grant lets its holder do, in words: "Can comment". */
export const ROLE_LABELS: Record<GrantRole, string> = {
	viewer: 'Can view',
	commenter: 'Can comment',
	editor: 'Can edit'
};
