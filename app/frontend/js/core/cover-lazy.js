/**
 * 封面 / 艺人头像 / 专辑封面的可视懒加载器
 * 目标：列表（可能上千行）渲染时，封面不立即请求；只有元素进入视口（提前 120px 预加载）
 *      才发起网络请求，并用请求队列把并发限制在 MAX_CONCURRENT，彻底消除「请求风暴」。
 *
 * 配合：
 *   - 内存缓存 coverCache（url -> objectURL）：同一封面只请求一次
 *   - CacheStorage（可选持久层）：刷新页面后命中缓存，不再回源
 *   - 渲染时 <img class="lazy-cover" data-cover="<url>" data-default="<默认图>"> 不带 src，
 *     由本模块在进入视口时填充 src。
 *
 * 注意：滚动容器采用浏览器视口（root=null），与具体滚动父级无关，最通用稳妥。
 */
(function () {
    'use strict';

    const MAX_CONCURRENT = 4;            // 同时最多 4 个封面请求（留 2 个连接给音频/状态等业务请求）
    const PLAYING_CONCURRENT = 1;        // 播放中降为 1：封面不中断加载，但把大部分连接让给音频/业务
    const ROOT_MARGIN = '120px 0px';     // 进入视口前 120px 预加载
    const CACHE_NAME = 'musichub-covers-v1';

    let observer = null;
    let active = 0;
    let paused = false;               // 播放中暂停封面队列，让出浏览器连接给业务请求
    const queue = [];
    const coverCache = new Map();        // url -> objectURL（内存缓存，避免重复请求）

    function ensureObserver() {
        if (observer) return observer;
        observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) {
                    observer.unobserve(e.target);
                    enqueue(e.target);
                }
            });
        }, { root: null, rootMargin: ROOT_MARGIN, threshold: 0.01 });
        return observer;
    }

    function enqueue(img) {
        if (!img || img.dataset.lazy === '1') return;
        img.dataset.lazy = '1';
        queue.push(img);
        pump();
    }

    function pump() {
        // 播放中不彻底冻结：并发降到 PLAYING_CONCURRENT 让封面仍能逐个加载（避免整列表灰），
        // 同时把大部分同源连接让给音频流 / play-queue / lyrics 等业务请求
        const limit = paused ? PLAYING_CONCURRENT : MAX_CONCURRENT;
        while (active < limit && queue.length) {
            const img = queue.shift();
            active++;
            loadOne(img).finally(function () {
                active--;
                pump();
            });
        }
    }

    async function loadOne(img) {
        try {
            if (!img.isConnected) return;
            const url = img.dataset.cover;
            if (!url) {
                // 无封面 URL：交给 SongTable 的插件补全链路（本插件 getMusicInfo/search → 「封面获取」辅助插件），
                // 先落默认占位，补到后由 SongTable._setRowCover 回填真实封面；本地歌曲在补全入口直接跳过
                const pageEl = img.closest ? img.closest('[data-page-id]') : null;
                const pageId = pageEl && pageEl.dataset ? pageEl.dataset.pageId : null;
                const idx = img.dataset ? img.dataset.songIdx : null;
                if (pageId && idx !== undefined && idx !== null
                    && typeof window.SongTable !== 'undefined' && typeof SongTable._enrichRowCover === 'function') {
                    if (img.isConnected) img.src = img.dataset.default || '';
                    SongTable._enrichRowCover(pageId, parseInt(idx, 10));
                    return;
                }
                if (img.isConnected) img.src = img.dataset.default || '';
                return;
            }
            // 外网直链（http/https）。
            // 已知防盗链图床（kuwo/kugou/migu/qq/163 等）：浏览器若挂了本地调试代理，直连常被返回错图/缓存污染，
            // 且部分图床对 Referer 有校验。这里直接走服务器代理（后端 Node 不经浏览器代理、带主站 Referer），
            // 取到干净字节；代理签名/取图失败时退回直连 + onerror 兜底。
            if (/^https?:\/\//i.test(url)) {
                const hotlink = /(kuwo|kugou|\.kg|\.qq\.com|y\.qq|yqq|163\.com|netease|migu|douyin|douban|bilibili|bili)/i.test(url);
                // 防盗链图床直接走代理；此前直连失败已被记忆（coverProxyMemo）的外链也直接走代理，
                // 不再先直连失败一次再兜底（签名 token 本身有缓存，多一次代理判定零额外请求）
                const useProxy = hotlink
                    || (typeof window.coverProxyMemoHas === 'function' && window.coverProxyMemoHas(url));
                if (useProxy) {
                    try {
                        const proxyUrl = await signProxyUrl(url, 'image');
                        if (!img.isConnected) return;
                        img.dataset.raw = url;
                        img.src = proxyUrl;
                        img.onerror = function () {
                            if (!img.isConnected) return;
                            // 代理仍失败：走与播放器封面同款的服务端兜底（会再次签名代理，二次失败则落占位）
                            if (typeof window.__coverImgOnError === 'function') window.__coverImgOnError(img);
                            else img.style.display = 'none';
                        };
                        return;
                    } catch (e) {
                        // 代理不可用：退回直连
                    }
                }
                if (img.isConnected) {
                    img.src = url;
                    img.onerror = function () {
                        if (!img.isConnected) return;
                        // 直连失败（防盗链等）：与播放器封面同款，走服务器代理（带 Referer）兜底，
                        // 代理仍失败时由 __coverImgOnError 落占位，避免行封面空白
                        if (typeof window.__coverImgOnError === 'function') {
                            img.setAttribute('data-raw', url);
                            window.__coverImgOnError(img);
                        } else if (img.dataset.default && img.src !== img.dataset.default) {
                            img.src = img.dataset.default;
                        }
                    };
                }
                return;
            }
            if (coverCache.has(url)) {
                if (img.isConnected) img.src = coverCache.get(url);
                return;
            }
            // 持久层：命中 CacheStorage 直接用（刷新页面仍生效）
            if ('caches' in window) {
                try {
                    const m = await caches.match(url);
                    if (m) {
                        const b = await m.blob();
                        const u = URL.createObjectURL(b);
                        coverCache.set(url, u);
                        if (img.isConnected) img.src = u;
                        return;
                    }
                } catch (e) { /* 忽略缓存读取错误 */ }
            }
            const resp = await fetch(url, { cache: 'force-cache' });
            // 非 2xx（401/404/500）或非图片响应（后端解析失败时的错误 JSON）一律落占位，
            // 绝不把坏图塞进 <img>（否则表现为空白/坏块且无兜底）
            if (!resp.ok) throw new Error('cover http ' + resp.status);
            const cType = (resp.headers.get('content-type') || '');
            if (cType && !/^image\//i.test(cType)) throw new Error('cover not-image: ' + cType);
            if (!img.isConnected) return;          // 加载期间节点已被重绘移除
            const c2 = resp.clone();               // 先 clone 再读取 body，供缓存
            const blob = await resp.blob();
            if (!img.isConnected) return;
            const objUrl = URL.createObjectURL(blob);
            coverCache.set(url, objUrl);
            img.src = objUrl;
            if ('caches' in window) {
                try {
                    const cc = await caches.open(CACHE_NAME);
                    await cc.put(url, c2);
                } catch (e) { /* 忽略缓存写入错误 */ }
            }
        } catch (e) {
            if (img.isConnected) img.src = img.dataset.default || '';
        }
    }

    const CoverLazy = {
        /**
         * 播放状态变化：播放中暂停封面队列（已 inflight 的继续完成），让出浏览器同域名连接给
         * 音频流 / play-queue / player-state / lyrics 等业务请求，解决封面占满连接池导致业务 RT 飙升。
         * 由 player 模块在播放开始 / 暂停(结束)时调用。
         */
        setPaused: function (p) {
            paused = !!p;
            pump();   // 暂停与否都继续消费队列（播放中仅降速，不中断）
        },
        /**
         * 扫描 root 下所有未观察的 .lazy-cover，注册到 IntersectionObserver。
         * 每次列表重绘（含 SongListLazy 整段重绘）后调用即可。
         */
        scan: function (root) {
            const ob = ensureObserver();
            const list = (root || document).querySelectorAll('img.lazy-cover:not([data-lazy])');
            list.forEach(function (img) { ob.observe(img); });
        },
        // 预留：切换歌单/清理时调用，避免内存中 objectURL 无限增长
        clearCache: function () {
            coverCache.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
            coverCache.clear();
        }
    };

    // 自动扫描：任何后续插入 DOM 的 .lazy-cover（如卡片用 createImageWithFallback 渲染的防盗链封面）
    // 都会被懒加载，无需各模块手动调用 scan。
    function observeNewCovers() {
        if (typeof MutationObserver === 'undefined') return;
        const mo = new MutationObserver(function (mutations) {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const list = (node.matches && node.matches('img.lazy-cover:not([data-lazy])'))
                        ? [node]
                        : (node.querySelectorAll ? node.querySelectorAll('img.lazy-cover:not([data-lazy])') : []);
                    for (const im of list) ensureObserver().observe(im);
                }
            }
        });
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeNewCovers);
    else observeNewCovers();

    window.CoverLazy = CoverLazy;
})();
