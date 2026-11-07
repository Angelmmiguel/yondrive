/** What the app shell offers the pages inside it. */
export interface ShellActions {
	newFolder(parentId?: string): void;
	uploadFiles(): void;
	uploadFolder(): void;
}
