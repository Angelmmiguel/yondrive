/**
 * Making a public link and showing it again. The URL carries the link key in its
 * fragment, which browsers do not send. With a password it carries nothing: the
 * server gives the wrapped key only to the right password. Without keys, as in suite
 * `none`, every key here is empty and the URL is just the address.
 */
import type { CreateLinkRequest, Kdf, Link } from '$lib/api/types';
import { optional } from '$lib/account/wire';
import { decodeBase64, encodeBase64, type Bytes } from '$lib/crypto/encoding';
import { zero } from '$lib/crypto/random';
import type { Sealer, UserKeys } from '$lib/crypto/sealer';

export interface LinkOptions {
	expiresAt?: Date;
	downloadLimit?: number;
	/** Set together: what a password has been derived to. `root` is zeroed by the caller. */
	password?: { kdf: Kdf; root: Uint8Array };
}

/** The body of a new link, and the URL fragment it goes by. */
export function buildLink(
	input: { id: string; nodeId: string; nodeKey: Uint8Array; generation: number },
	options: LinkOptions,
	sealer: Sealer,
	keys: UserKeys
): { body: CreateLinkRequest; fragment: string } {
	const { id, nodeId, nodeKey, generation } = input;
	const linkKey = sealer.newLinkKey();
	try {
		const body: CreateLinkRequest = {
			id,
			node_id: nodeId,
			role: 'view',
			key_generation: generation,
			sealed_key: encodeBase64(sealer.sealLinkNodeKey(nodeKey, linkKey, id, nodeId)),
			owner_sealed_key: encodeBase64(sealer.sealLinkOwnerCopy(linkKey, keys.masterKey, id)),
			expires_at: options.expiresAt?.toISOString(),
			download_limit: options.downloadLimit
		};
		if (options.password !== undefined) {
			const { authKey, kek } = sealer.linkPasswordKeys(options.password.root);
			body.password = {
				kdf: options.password.kdf,
				auth_key: encodeBase64(authKey),
				wrapped_key: optional(sealer.wrapLinkKey(linkKey, kek, id))
			};
			zero(authKey, kek);
			return { body, fragment: '' };
		}
		return { body, fragment: sealer.linkFragment(linkKey) };
	} finally {
		zero(linkKey);
	}
}

/** The address of a link. */
export function linkUrl(origin: string, id: string, fragment: string): string {
	const base = `${origin}/s/${id}`;
	return fragment === '' ? base : `${base}#${fragment}`;
}

/** The address of a link already made, from the owner's copy of its key. */
export function urlOfLink(
	origin: string,
	link: Pick<Link, 'id' | 'has_password' | 'owner_sealed_key'>,
	sealer: Sealer,
	keys: UserKeys
): string {
	if (link.has_password) return linkUrl(origin, link.id, '');
	let linkKey: Bytes | null = null;
	try {
		linkKey = sealer.openLinkOwnerCopy(
			decodeBase64(link.owner_sealed_key),
			keys.masterKey,
			link.id
		);
		return linkUrl(origin, link.id, sealer.linkFragment(linkKey));
	} finally {
		if (linkKey !== null) zero(linkKey);
	}
}

/** What a link has come to, as a person would put it. */
export type LinkStatus = 'live' | 'revoked' | 'expired' | 'used-up';

export function linkStatus(link: Link, now: number): LinkStatus {
	if (link.revoked_at !== undefined) return 'revoked';
	if (link.expires_at !== undefined && Date.parse(link.expires_at) <= now) return 'expired';
	if (link.download_limit !== undefined && link.download_count >= link.download_limit) {
		return 'used-up';
	}
	return 'live';
}
