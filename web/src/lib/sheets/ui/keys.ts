/**
 * The keyboard of the grid as a table: a key with its modifiers to what it does,
 * both while moving around and while a cell is being edited. The grid carries
 * the actions out; nothing here touches the page.
 */

export interface KeyLike {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

export type GridAction =
	| { type: 'move'; dRow: number; dCol: number; extend: boolean }
	| { type: 'page'; dir: -1 | 1; extend: boolean }
	| { type: 'jump'; dir: Dir; extend: boolean }
	/** Home and End: along the row, or with Ctrl to A1 and the last used cell. */
	| { type: 'home'; sheet: boolean; extend: boolean }
	| { type: 'end'; sheet: boolean; extend: boolean }
	| { type: 'selectAll' }
	| { type: 'edit' }
	/** Enter and Tab: within the selection when it is more than a cell. */
	| { type: 'next'; dRow: number; dCol: number }
	| { type: 'clear' }
	| { type: 'escape' }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'format'; mark: 'bold' | 'italic' | 'strike' }
	| { type: 'save' }
	/** A character typed: editing starts with it, replacing the cell. */
	| { type: 'type'; text: string };

const ARROWS: Record<string, Dir> = {
	ArrowUp: 'up',
	ArrowDown: 'down',
	ArrowLeft: 'left',
	ArrowRight: 'right'
};

export const DELTA: Record<Dir, [number, number]> = {
	up: [-1, 0],
	down: [1, 0],
	left: [0, -1],
	right: [0, 1]
};

/** What a key does in the grid when no cell is being edited; null for nothing. */
export function gridKey(e: KeyLike): GridAction | null {
	const mod = !!(e.ctrlKey || e.metaKey);
	const extend = !!e.shiftKey;
	const dir = ARROWS[e.key];
	if (dir) {
		if (e.altKey) return null;
		if (mod) return { type: 'jump', dir, extend };
		const [dRow, dCol] = DELTA[dir];
		return { type: 'move', dRow, dCol, extend };
	}
	if (mod && !e.altKey) {
		switch (e.key.toLowerCase()) {
			case 'a':
				return { type: 'selectAll' };
			case 'z':
				return extend ? { type: 'redo' } : { type: 'undo' };
			case 'y':
				return { type: 'redo' };
			case 'b':
				return { type: 'format', mark: 'bold' };
			case 'i':
				return { type: 'format', mark: 'italic' };
			case '5':
				return { type: 'format', mark: 'strike' };
			case 's':
				return { type: 'save' };
			case 'home':
				return { type: 'home', sheet: true, extend };
			case 'end':
				return { type: 'end', sheet: true, extend };
		}
		return null;
	}
	switch (e.key) {
		case 'PageDown':
			return { type: 'page', dir: 1, extend };
		case 'PageUp':
			return { type: 'page', dir: -1, extend };
		case 'Home':
			return { type: 'home', sheet: false, extend };
		case 'End':
			return { type: 'end', sheet: false, extend };
		case 'F2':
			return { type: 'edit' };
		case 'Enter':
			return { type: 'next', dRow: extend ? -1 : 1, dCol: 0 };
		case 'Tab':
			return { type: 'next', dRow: 0, dCol: extend ? -1 : 1 };
		case 'Delete':
		case 'Backspace':
			return { type: 'clear' };
		case 'Escape':
			return { type: 'escape' };
	}
	if (e.key.length === 1 && !e.altKey) return { type: 'type', text: e.key };
	return null;
}

/**
 * How editing began: by typing over the cell, where arrows finish the edit and
 * move as they would in the grid, or with F2, a double click or the formula bar,
 * where arrows move the caret.
 */
export type EditHow = 'replace' | 'edit';

export type EditorAction =
	| { type: 'commit'; dRow: number; dCol: number }
	/** Ctrl+Enter: the same input into every selected cell. */
	| { type: 'fill' }
	| { type: 'cancel' }
	| { type: 'newline' };

/** What a key does in the cell editor; null leaves it to the text box. */
export function editorKey(e: KeyLike, how: EditHow): EditorAction | null {
	if (e.key === 'Enter') {
		if (e.altKey) return { type: 'newline' };
		if (e.ctrlKey || e.metaKey) return { type: 'fill' };
		return { type: 'commit', dRow: e.shiftKey ? -1 : 1, dCol: 0 };
	}
	if (e.key === 'Tab') return { type: 'commit', dRow: 0, dCol: e.shiftKey ? -1 : 1 };
	if (e.key === 'Escape') return { type: 'cancel' };
	const dir = ARROWS[e.key];
	if (dir && how === 'replace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
		const [dRow, dCol] = DELTA[dir];
		return { type: 'commit', dRow, dCol };
	}
	return null;
}
