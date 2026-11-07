import { UploadPanelState } from '$lib/drive/upload/panel.svelte';
import { drive } from './drive.svelte';

/** What the upload panel shows, shared with the layout that leaves room for it. */
export const uploadPanel = new UploadPanelState(() => drive.core?.queue.clearFinished());
