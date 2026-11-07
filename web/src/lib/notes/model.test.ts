import { describe, expect, it } from 'vitest';
import {
	cleanTag,
	dailyTitle,
	dayKey,
	fileNameOf,
	isNoteFile,
	isNotesRoot,
	marksNote,
	nextColor,
	noteMetaPatch,
	notebookColor,
	parseNoteMeta,
	sameDay,
	sameTitle,
	titleOf
} from './model';

describe('notes model', () => {
	it('names the daily note by its local day, so it sorts and reads anywhere', () => {
		expect(dailyTitle(new Date(2026, 10, 7, 23, 59))).toBe('2026-11-07');
		expect(dayKey(new Date(2026, 0, 3))).toBe('2026-01-03');
		expect(sameDay(new Date(2026, 10, 7, 1).getTime(), new Date(2026, 10, 7, 22).getTime())).toBe(
			true
		);
		expect(sameDay(new Date(2026, 10, 7).getTime(), new Date(2026, 10, 8).getTime())).toBe(false);
	});

	it('turns a title into a file name and back', () => {
		expect(fileNameOf('Sync engine — design notes')).toBe('Sync engine — design notes.md');
		expect(fileNameOf('  a/b\\c  ')).toBe('a-b-c.md');
		expect(fileNameOf('')).toBe('Untitled note.md');
		expect(fileNameOf('..')).toBe('Untitled note.md');
		expect(fileNameOf('x'.repeat(400))).toHaveLength(255);
		expect(titleOf('Groceries.md')).toBe('Groceries');
		expect(titleOf('README.MD')).toBe('README');
		expect(sameTitle('Café ', 'CAFÉ')).toBe(true);
	});

	it('reads its fields from metadata, keeping what it does not know', () => {
		expect(parseNoteMeta({})).toEqual({
			pinned: false,
			archived: false,
			reminder: null,
			tags: [],
			daily: null
		});
		const raw = {
			note: {
				pinned: true,
				reminder: 1_800_000_000_000,
				tags: ['#Work', 'work', 3],
				daily: 'x',
				other: 1
			}
		};
		expect(parseNoteMeta(raw)).toMatchObject({
			pinned: true,
			reminder: 1_800_000_000_000,
			tags: ['work'],
			daily: null
		});
		expect(noteMetaPatch(raw, { pinned: false })).toEqual({
			note: { ...raw.note, pinned: false }
		});
	});

	it('tells notes, notebooks and the notes folder apart', () => {
		expect(isNotesRoot({ kind: 'folder', name: 'Notes', raw: { app: 'notes' } })).toBe(true);
		expect(isNotesRoot({ kind: 'folder', name: 'Notes', raw: {} })).toBe(false);
		expect(isNoteFile({ kind: 'file', name: 'a.md', raw: {} })).toBe(true);
		expect(isNoteFile({ kind: 'file', name: 'a.png', raw: {} })).toBe(false);
		expect(marksNote({ kind: 'file', name: 'a.md', raw: { note: {} } })).toBe(true);
		expect(marksNote({ kind: 'file', name: 'a.md', raw: {} })).toBe(false);
		expect(marksNote({ kind: 'folder', name: 'Work', raw: { notebook: { color: 'rose' } } })).toBe(
			true
		);
		expect(notebookColor({ notebook: { color: 'rose' } })).toBe('rose');
		expect(notebookColor({ notebook: { color: 'red; x' } })).toBe('blue');
		expect(nextColor(7)).toBe('orange');
	});

	it('keeps tags plain', () => {
		expect(cleanTag('#Travel Plans')).toBe('travel-plans');
		expect(cleanTag('##ideas/2027')).toBe('ideas/2027');
		expect(cleanTag('!!!')).toBe('');
	});
});
