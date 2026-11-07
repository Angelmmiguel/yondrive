/**
 * Templates: a few that come with the app, and the notes of the Templates
 * notebook, which anyone can add to. A template is Markdown with `{{date}}`,
 * `{{time}}` and `{{title}}` filled in when a note is made from it.
 */
import { dayKey } from './model';

export interface Template {
	/** `builtin:<name>`, or the id of a note in the Templates notebook. */
	id: string;
	title: string;
	/** The body; a note from the Templates notebook is read when chosen. */
	body: string | null;
}

export const BUILTIN_TEMPLATES: Template[] = [
	{
		id: 'builtin:meeting',
		title: 'Meeting notes',
		body: [
			'## Attendees',
			'',
			'- ',
			'',
			'## Agenda',
			'',
			'1. ',
			'',
			'## Decisions',
			'',
			'- ',
			'',
			'## Action items',
			'',
			'- [ ] '
		].join('\n')
	},
	{
		id: 'builtin:daily',
		title: 'Daily journal',
		body: ['## Plan for {{date}}', '', '- [ ] ', '', '## Notes', '', '', '## Done today', ''].join(
			'\n'
		)
	},
	{
		id: 'builtin:project',
		title: 'Project plan',
		body: [
			'> [!NOTE]',
			'> Goal: ',
			'',
			'## Scope',
			'',
			'- ',
			'',
			'## Milestones',
			'',
			'| Milestone | Date | Owner |',
			'| --- | --- | --- |',
			'|  |  |  |',
			'',
			'## Tasks',
			'',
			'- [ ] '
		].join('\n')
	},
	{
		id: 'builtin:checklist',
		title: 'Checklist',
		body: ['- [ ] ', '- [ ] ', '- [ ] '].join('\n')
	}
];

const pad = (n: number) => String(n).padStart(2, '0');

/** A template's body with its placeholders filled in. */
export function fillTemplate(body: string, values: { title: string; now: Date }): string {
	const time = `${pad(values.now.getHours())}:${pad(values.now.getMinutes())}`;
	return body
		.replace(/\{\{\s*date\s*\}\}/g, dayKey(values.now))
		.replace(/\{\{\s*time\s*\}\}/g, time)
		.replace(/\{\{\s*title\s*\}\}/g, values.title);
}

/** The title of a note made from a template: the template's, with the day for a journal. */
export function titleFromTemplate(template: Pick<Template, 'id' | 'title'>, now: Date): string {
	return template.id === 'builtin:daily' ? dayKey(now) : template.title;
}
