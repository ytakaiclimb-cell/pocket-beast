// ポケットビースト: オフラインでも開けるようにする。
//
// これが無いと Chrome が「アプリ」と認識せず、
// メニューに「アプリをインストール」が出ない。
//
// 育成のぶんは端末の中だけで動くので、電波が無くても遊べる。
// 対戦だけは通信が要る。

const VERSION = 'v7';
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

  const save = (res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  };

  // アプリ本体（HTML）は「通信さきに、だめならキャッシュ」。
  // こうしないと、直したものが次の次まで届かない。
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') ||
                 url.pathname.endsWith('.html');
  if (isPage) {
    // no-cache でブラウザ自身のキャッシュも飛ばして、サーバに聞きに行く。
    // GitHub Pages が max-age=600 を付けるので、これが無いと
    // 直したものが 10分ほど届かない。
    e.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then(save)
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // 画像などは「キャッシュさきに、裏で更新」。
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then(save).catch(() => hit);
      return hit || net;
    })
  );
});
