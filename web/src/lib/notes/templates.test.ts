import { describe, expect, it } from 'vitest';
import { analyze } from './parse';
import { BUILTIN_TEMPLATES, fillTemplate, titleFromTemplate } from './templates';

describe('templates', () => {
	it('fills in the date, time and title', () => {
		const now = new Date(2026, 10, 7, 9, 5);
		expect(fillTemplate('{{title}} on {{ date }} at {{time}}', { title: 'Standup', now })).toBe(
			'Standup on 2026-11-07 at 09:05'
		);
		// A title goes in as typed: `$&`, `$'` and `$1` are not replacement patterns.
		expect(fillTemplate('# {{title}}', { title: "$& $' $` $1 $$", now })).toBe("# $& $' $` $1 $$");
		expect(titleFromTemplate({ id: 'builtin:daily', title: 'Daily journal' }, now)).toBe(
			'2026-11-07'
		);
		expect(titleFromTemplate({ id: 'x', title: 'Mine' }, now)).toBe('Mine');
	});

	it('come with checklists that read as tasks', () => {
		const meeting = BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:meeting');
		expect(analyze(meeting?.body ?? '').tasks).toHaveLength(1);
		expect(BUILTIN_TEMPLATES.map((t) => t.title)).toEqual([
			'Meeting notes',
			'Daily journal',
			'Project plan',
			'Checklist'
		]);
	});
});
