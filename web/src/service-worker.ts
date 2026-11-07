/// <reference lib="webworker" />
/**
 * Serves decrypted streams at /stream/<id> and nothing else: every other request
 * goes to the network as if this were not here. The work is in `StreamHost`. Keys
 * arrive from a page, stay in memory and go on a lock, in any tab, on sign-out, or
 * after a while with nothing to do. The browser may also stop this worker at any
 * time, which takes them too; a request after that asks the pages again.
 */
import { STREAM_PATH, StreamHost, TAB_CHANNEL, type PageMessage } from '$lib/drive/stream/host';
import { createAskPages, fetchStoredBytes } from '$lib/drive/stream/worker-glue';

const sw = self as unknown as ServiceWorkerGlobalScope;

const IDLE_MS = 10 * 60 * 1000;
let idle: ReturnType<typeof setTimeout> | undefined;

const host = new StreamHost({
	fetchBytes: fetchStoredBytes,
	askPages: createAskPages(sw),
	report(message) {
		void sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pages) => {
			for (const page of pages) page.postMessage(message);
		});
	}
});

function touch() {
	clearTimeout(idle);
	idle = setTimeout(() => host.clear(), IDLE_MS);
}

new BroadcastChannel(TAB_CHANNEL).onmessage = (event: MessageEvent<unknown>) => {
	if (event.data === 'locked' || event.data === 'signed-out') host.clear();
};

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener('message', (event) => {
	const message = event.data as PageMessage;
	if (message.type === 'register') {
		touch();
		host.register(message.info);
	} else if (message.type === 'release') host.release(message.id);
	else if (message.type === 'clear') host.clear();
});

sw.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== sw.location.origin || !url.pathname.startsWith(STREAM_PATH)) return;
	const id = url.pathname.slice(STREAM_PATH.length);
	touch();
	event.respondWith(host.respond(id, event.request.headers.get('range'), event.request.signal));
});
