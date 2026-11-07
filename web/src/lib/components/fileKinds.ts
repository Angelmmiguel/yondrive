import type { IconName } from './icons';

export type FileKind = 'folder' | 'doc' | 'sheet' | 'note' | 'image' | 'pdf' | 'video' | 'other';

interface KindStyle {
	icon: IconName;
	/** Semantic colour tokens for the ink and its soft tint. */
	ink: string;
	soft: string;
	label: string;
}

/** How each kind of file is drawn, from the semantic file and app tokens. */
export const FILE_KINDS: Record<FileKind, KindStyle> = {
	folder: {
		icon: 'folder',
		ink: 'var(--file-folder)',
		soft: 'var(--file-folder-soft)',
		label: 'Folder'
	},
	doc: { icon: 'doc', ink: 'var(--drive)', soft: 'var(--drive-soft)', label: 'Document' },
	sheet: { icon: 'sheet', ink: 'var(--sheets)', soft: 'var(--sheets-soft)', label: 'Spreadsheet' },
	note: { icon: 'note', ink: 'var(--notes)', soft: 'var(--notes-soft)', label: 'Note' },
	image: {
		icon: 'photo',
		ink: 'var(--file-image)',
		soft: 'var(--file-image-soft)',
		label: 'Image'
	},
	pdf: { icon: 'pdf', ink: 'var(--file-pdf)', soft: 'var(--file-pdf-soft)', label: 'PDF' },
	video: {
		icon: 'video',
		ink: 'var(--file-video)',
		soft: 'var(--file-video-soft)',
		label: 'Video'
	},
	other: { icon: 'doc', ink: 'var(--file-folder)', soft: 'var(--file-folder-soft)', label: 'File' }
};
