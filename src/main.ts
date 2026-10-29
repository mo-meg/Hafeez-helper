import './ui/styles.css';
import { AudioCache } from './browser/audioCache.ts';
import { HtmlAudioBackend } from './browser/htmlAudioBackend.ts';
import { createIdbStore } from './browser/idbStore.ts';
import { createServices } from './core/services.ts';
import { createMemoryStore } from './core/storage/memoryStore.ts';
import type { Store } from './core/storage/store.ts';
import { randomIds, systemClock } from './core/util/ids.ts';
import { App } from './ui/app.ts';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  const notices: string[] = [];
  let store: Store;
  try {
    store = await createIdbStore();
  } catch (e) {
    store = createMemoryStore();
    notices.push(`Local storage is unavailable (${e instanceof Error ? e.message : String(e)}). Changes will be lost when this page closes; export a backup in Settings to keep them.`);
  }
  const services = createServices({ store, clock: systemClock, ids: randomIds, fetcher: (url, init) => fetch(url, init) });
  const app = new App({
    services,
    audioBackend: new HtmlAudioBackend(),
    audioCache: new AudioCache(store.audio),
    isOnline: () => navigator.onLine,
    notices,
  });
  await app.start(root);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline shell unavailable; the app still works online */
    });
  }
}

boot().catch((e: unknown) => {
  const root = document.getElementById('app');
  if (root) root.textContent = `Hafeez Helfer could not start: ${e instanceof Error ? e.message : String(e)}`;
});
