/** What a name may be. The server cannot check it, so a bad one would stay. */
export class InvalidNameError extends Error {
	constructor(readonly reason: 'empty' | 'separator' | 'dots' | 'long') {
		super(`invalid name: ${reason}`);
		this.name = 'InvalidNameError';
	}
}

export const MAX_NAME_LENGTH = 255;

/** The name to use, or `InvalidNameError`. Surrounding space goes, as it is never meant. */
export function cleanName(typed: string): string {
	const name = typed.trim();
	if (name === '') throw new InvalidNameError('empty');
	if (name === '.' || name === '..') throw new InvalidNameError('dots');
	if (/[/\\\0]/.test(name)) throw new InvalidNameError('separator');
	if (name.length > MAX_NAME_LENGTH) throw new InvalidNameError('long');
	return name;
}
