/** Ids are chosen here, because they enter the AAD before anything is sealed. */
import { bytesToHex } from '@noble/hashes/utils.js';
import { randomBytes } from '$lib/crypto/random';

/** 32 lowercase hex characters from 16 random bytes, the one form the API takes. */
export function newId(): string {
	return bytesToHex(randomBytes(16));
}
