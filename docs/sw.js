// ポケットビースト: オフラインでも開けるようにする。
//
// これが無いと Chrome が「アプリ」と認識せず、
// メニューに「アプリをインストール」が出ない。
//
// 育成のぶんは端末の中だけで動くので、電波が無くても遊べる。
// 対戦だけは通信が要る。

const VERSION = 'v3';
const CACHE = 'pocket-beast-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Supabase への通信はキャッシュしない（対戦もセーブも常に最新が要る）
  if (url.origin !== self.location.origin) return;

  // 手元のキャッシュをすぐ返しつつ、裏で新しいものを取りに行く。
  // 次に開いたときに更新版になる。
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
