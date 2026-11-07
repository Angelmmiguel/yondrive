/**
 * Stroke icon paths on a 24 by 24 grid, lifted from the design boards. Each
 * is one `d` attribute drawn with a round-capped stroke; no fills, no fonts.
 */
export const ICONS = {
	folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
	doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
	sheet:
		'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM4 10h16M4 15h16M10 4v16',
	note: 'M5 4h14v11l-5 5H5zM14 20v-5h5M9 9h6M9 12h4',
	photo:
		'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM7 10a2 2 0 1 0 4 0a2 2 0 1 0-4 0M21 16l-5-5-9 9',
	pdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M8.5 16.5h7M8.5 13h3',
	video:
		'M5 5h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM16 10l5-3v10l-5-3z',
	upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
	download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
	home: 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
	shared:
		'M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18.5 14.5A6 6 0 0 1 21.5 20',
	recent: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18M12 7v5l3 2',
	star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
	trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
	plus: 'M12 5v14M5 12h14',
	search: 'M11 18a7 7 0 1 0 0-14a7 7 0 1 0 0 14M20 20l-3.5-3.5',
	bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
	moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
	sun: 'M12 17a5 5 0 1 0 0-10a5 5 0 1 0 0 10M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
	check: 'M5 12.5l4.5 4.5L19 7.5',
	close: 'M6 6l12 12M18 6L6 18',
	sort: 'M12 5v14M6 13l6 6 6-6',
	filter: 'M4 6h16M7 12h10M10 18h4',
	list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
	grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
	info: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18M12 11v5M12 8h.01',
	warn: 'M12 3l9.5 17h-19zM12 10v4M12 17h.01',
	shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
	'shield-check': 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9.5 12l2 2 3.5-4',
	'lock-open': 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2',
	'arrow-right': 'M5 12h14M13 6l6 6-6 6',
	// Not on the boards: drawn on the same grid and stroke to fill a gap.
	'chevron-down': 'M6 9l6 6 6-6',
	'chevron-right': 'M9 6l6 6-6 6',
	copy: 'M9 9h11v11H9zM5 15V5h10',
	eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6',
	'eye-off':
		'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6M4 4l16 16',
	more: 'M5 12h.01M12 12h.01M19 12h.01',
	menu: 'M4 6h16M4 12h16M4 18h16'
} as const;

export type IconName = keyof typeof ICONS;
