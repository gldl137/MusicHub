/**
 * MusicHub Service Worker
 * 处理 PWA 离线缓存与通知点击事件。
 *
 * 策略：
 *  - 安装时预缓存核心入口（index / manifest / 图标），用相对路径以兼容子路径部署；
 *  - 页面导航（html）与带 ?v= 的静态资源走 network-first：优先拿最新版（改版立即生效），
 *    网络失败才回退缓存（保证离线可用）；
 *  - 其余同源静态资源走 stale-while-revalidate：先返回缓存、后台更新；
 *  - /api/ 与跨域资源（音频、封面源）不缓存、永远走网络。
 */

const CACHE_NAME = 'musichub-v7';

// 相对路径预缓存，兼容部署在子目录的情况
const CORE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png'
];

// 安装时缓存核心资源
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .catch((err) => console.log('[SW] pre-cache failed:', err))
            .finally(() => self.skipWaiting())
    );
});

// 激活时清理旧缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) => Promise.all(
            names.map((n) => (n !== CACHE_NAME ? caches.delete(n) : null))
        )).then(() => self.clients.claim())
    );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // 只处理同源请求
    if (url.origin !== self.location.origin) return;
    // API / 媒体流永远走网络，保证数据实时且不缓存大体积音频
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) return;

    // 页面导航（html）：network-first —— 每次都拿最新页面，改动立即生效；离线才回退缓存
    const isNavigation = req.mode === 'navigate'
        || (req.headers.get('accept') || '').includes('text/html')
        || url.pathname === '/' || url.pathname.endsWith('.html');

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);

        if (isNavigation) {
            try {
                const fresh = await fetch(req);
                if (fresh && fresh.ok && fresh.type === 'basic') {
                    cache.put(req, fresh.clone());
                }
                return fresh;
            } catch (e) {
                const cached = await cache.match(req);
                return cached || new Response('Offline', { status: 503 });
            }
        }

        const cached = await cache.match(req);
        const network = fetch(req)
            .then((res) => {
                // 只缓存同源成功的「baseline」响应，避免缓存错误页/跨域 opaque
                if (res && res.ok && res.type === 'basic') {
                    cache.put(req, res.clone());
                }
                return res;
            })
            .catch(() => cached);
        // 先给缓存（离线可用），没有再等网络
        return cached || network;
    })());
});

// 处理通知点击事件
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification click received:', event);
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((list) => {
                for (const c of list) {
                    if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
                }
                if (self.clients.openWindow) return self.clients.openWindow('/');
            })
    );
});
