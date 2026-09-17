// ==================== 工具函数 ====================

// 格式化时长
function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '--:--';
    if (!isFinite(seconds)) return '直播'; // 直播流：时长无限，显示「直播」而非 Infinity:NaN
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// HTML转义（含引号：属性值拼接处必须转义 " '，否则歌曲名/文件名含引号时可被属性注入）
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 格式化时长（别名，兼容旧代码）
function formatTime(seconds) {
    return formatDuration(seconds);
}

// ==================== 图片处理 ====================

// 校验一个 URL 是否"像可加载的图片资源"。
// 某些插件/接口会对无图条目返回占位坏值（如 http://y.gtimg.cn/music/common，
// 无文件名、非图床路径），直接塞进 <img> 会让浏览器请求 404 并在控制台刷屏。
// 该函数用于在渲染封面时过滤掉这类无效 URL，改显示占位音符，避免发起无效请求。
function isPlausibleImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    const path = (url.split('?')[0] || '').toLowerCase();
    // 带常见图片扩展名：直接认定为图片（如 y.gtimg.cn/music/photo_new/T002...M000xxx.jpg）
    if (/\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|$)/.test(path)) return true;
    // 无扩展名时，需命中已知图床特征路径，避免误把"无图占位"当图片
    // xmcdn/ximalaya：喜马拉雅图床（如 https://imagev2.xmcdn.com/storages/xxx，无扩展名）
    if (/(photo_new|imgcache|\/album\/|\/cover\/|avatar|pic\.|albumart|music\.(126|netease)|kgimg|kuwo|kwcdn|migu|musicapp|xmcdn|ximalaya)/i.test(path)) return true;
    return false;
}

// 榜单/歌单封面常直接取自网页抓取的缩略图（如网易云榜单 ?param=40y40），
// 放大到卡片上会明显模糊。网易云等图床支持用 ?param=宽y高 指定任意尺寸，
// 这里统一把小尺寸参数提升到 COVER_TARGET_SIZE，取回高清图。
const COVER_TARGET_SIZE = 500;

function upgradeCoverQuality(url) {
    if (!url || typeof url !== 'string') return url;
    // 形如 ?param=40y40 / &param=150y150（网易云、QQ音乐等通用）
    if (/[?&]param=\d+y\d+/i.test(url)) {
        return url.replace(/([?&]param=)\d+y\d+/i, `$1${COVER_TARGET_SIZE}y${COVER_TARGET_SIZE}`);
    }
    return url;
}

// 封面代理兜底记忆：外部图床直连（含 307 直链）失败的 URL 记录后，之后始终走服务器代理
const COVER_PROXY_MEMO_KEY = 'musichub_cover_proxy_memo';
function coverProxyMemoHas(raw) {
  try { const arr = JSON.parse(localStorage.getItem(COVER_PROXY_MEMO_KEY) || '[]'); return arr.indexOf(raw) !== -1; } catch { return false; }
}
function coverProxyMemoAdd(raw) {
  try {
    const arr = JSON.parse(localStorage.getItem(COVER_PROXY_MEMO_KEY) || '[]');
    if (arr.indexOf(raw) === -1) { arr.push(raw); if (arr.length > 500) arr.shift(); localStorage.setItem(COVER_PROXY_MEMO_KEY, JSON.stringify(arr)); }
  } catch { /* 忽略 */ }
}

// 显示封面占位（代理仍失败时）：优先父容器内 .cover-placeholder，否则显示相邻兄弟元素
function showCoverPlaceholder(img) {
  let ph = (img.parentElement && img.parentElement.querySelector) ? img.parentElement.querySelector('.cover-placeholder') : null;
  if (!ph && img.nextElementSibling && img.nextElementSibling.nodeType === 1) ph = img.nextElementSibling;
  if (ph) ph.style.display = 'flex';
}

// 全局封面兜底：外部图床直连（含 307 直链）失败 → 改用后端 /api/proxy/image 服务器代理
// （代理会按域名带 Referer，可绕过图床防盗链）。一旦代理成功即写入记忆，之后该封面始终走代理（不再重复直连失败）。
window.__coverImgOnError = async function (img) {
  const raw = img.getAttribute('data-raw');
  if (!raw) { img.style.display = 'none'; return; }
  // 仅外部 http(s) 图床走代理兜底；本地/相对路径封面（同源）直接隐藏（占位元素通常已在下方）
  if (!/^https?:\/\//i.test(raw)) { img.style.display = 'none'; return; }
  if (img.dataset.coverProxyTried === '1') {
    // 代理也失败：隐藏图片并显示占位（若存在）
    img.style.display = 'none';
    showCoverPlaceholder(img);
    return;
  }
  img.dataset.coverProxyTried = '1';
  try {
    const proxyUrl = await signProxyUrl(raw, 'image');
    coverProxyMemoAdd(raw);
    img.src = proxyUrl;
  } catch (e) {
    img.style.display = 'none';
    showCoverPlaceholder(img);
  }
};

// 生成图片 HTML：
//  - 本地/相对路径（/api/radio/cover 等）保持原占位兜底；
//  - 外部 http(s) 图床：先直连（307 风格），失败时由 window.__coverImgOnError 用服务器代理兜底，
//    并通过 data-raw 记录原始 URL 以支持"一直用代理"记忆。
function createImageWithFallback(url, alt = 'cover', className = '') {
    if (!url) return '';

    const escapedUrl = escapeHtml(url);
    const escapedAlt = escapeHtml(alt);
    const classAttr = className ? `class="${escapeHtml(className)}"` : '';

    if (!/^https?:\/\//i.test(url)) {
        return `<img src="${escapedUrl}" alt="${escapedAlt}" ${classAttr} onerror="this.onerror=null; this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">`;
    }
    // 防盗链图床（kuwo/kugou/migu/qq/163 等）：浏览器直连会被本地调试代理改写/缓存污染，且部分图床校验 Referer。
    // 改为 .lazy-cover + data-cover，交给 CoverLazy 统一走服务器代理取图（绕开浏览器代理、带主站 Referer）；
    // CoverLazy 失败兜底会触发 __coverImgOnError（隐藏图片并显示相邻占位音符 🎵）。
    if (/(kuwo|kugou|\.kg|\.qq\.com|y\.qq|yqq|163\.com|netease|migu|douyin|douban|bilibili|bili)/i.test(url)) {
        return `<img class="${className ? escapeHtml(className) + ' ' : ''}lazy-cover" data-cover="${escapedUrl}" data-raw="${escapedUrl}" data-default="" alt="${escapedAlt}" decoding="async" onerror="window.__coverImgOnError(this)">`;
    }
    return `<img src="${escapedUrl}" alt="${escapedAlt}" ${classAttr} data-raw="${escapedUrl}" onerror="window.__coverImgOnError(this)">`;
}

// ==================== 代理防盗链：前端只换 token，绝不持外链 ====================
// 调用后端 /api/proxy/sign 把外部 URL 换成短期签名 token，再构造同源代理地址。
// 这样外部完整 URL 永远不会出现在前端请求参数里（满足"前端只传 token"的安全约束）。
//
// token 内存缓存：后端签发的 token 有效期默认 5 分钟（PROXY_TOKEN_TTL=300），
// 这里缓存 4 分钟（留 1 分钟余量，绝不把临期 token 塞给图片请求）。
// 滚动长列表时同一封面的签名 POST 只发一次；并发签名自动合并为同一次请求（inflight 去重）。
const PROXY_SIGN_TTL_MS = 4 * 60 * 1000;
const PROXY_SIGN_CACHE_MAX = 1000;
const proxySignCache = new Map();    // targetUrl -> { token, ts }
const proxySignInflight = new Map(); // targetUrl -> Promise<token>

function pruneProxySignCache(now = Date.now()) {
  for (const [k, v] of proxySignCache) {
    if (now - v.ts > PROXY_SIGN_TTL_MS) proxySignCache.delete(k);
  }
  while (proxySignCache.size > PROXY_SIGN_CACHE_MAX) {
    const oldest = proxySignCache.keys().next().value;
    if (oldest === undefined) break;
    proxySignCache.delete(oldest);
  }
}

/**
 * 是否「同源 / 相对路径 / 内网地址」——这类地址不需要（也无法）走代理签名。
 * 后端 /api/proxy/sign 带 SSRF 守卫：主机为私网网段（含 192.168.x、localhost 等）会直接
 * 返回 403「目标地址不允许代理」。而 API_BASE = location.origin，前端拼出的同源绝对地址
 * （如 http://<站点地址>/api/cover?id=xxx）正是私网地址，签名必然 403（日志刷屏）。
 * @param {string} targetUrl
 * @returns {boolean}
 */
function isSameOriginOrPrivateUrl(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return true;
  try {
    const u = new URL(targetUrl, window.location.origin);
    if (u.origin === window.location.origin) return true;
    const h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
      || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h);
  } catch {
    return false;
  }
}

async function signProxyUrl(targetUrl, type) {
  // 同源 / 内网地址原样返回：交给浏览器同源请求，无需代理签名（否则必被后端 403 拒绝）
  if (isSameOriginOrPrivateUrl(targetUrl)) return targetUrl;

  const base = (window.API_BASE) || '';
  const buildUrl = (token) => `${base}/api/proxy/${type}?token=${encodeURIComponent(token)}`;

  const hit = proxySignCache.get(targetUrl);
  if (hit && Date.now() - hit.ts < PROXY_SIGN_TTL_MS) return buildUrl(hit.token);
  if (hit) proxySignCache.delete(targetUrl);

  // 并发去重：同一 URL 的签名请求合并为一次
  const inflight = proxySignInflight.get(targetUrl);
  if (inflight) return buildUrl(await inflight);

  const p = (async () => {
    const resp = await fetch(`${base}/api/proxy/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || '代理签名失败');
    proxySignCache.set(targetUrl, { token: data.data.token, ts: Date.now() });
    pruneProxySignCache();
    return data.data.token;
  })();
  proxySignInflight.set(targetUrl, p);
  try {
    return buildUrl(await p);
  } finally {
    proxySignInflight.delete(targetUrl);
  }
}

// 导出工具函数
window.formatDuration = formatDuration;
window.formatTime = formatTime;
window.escapeHtml = escapeHtml;
window.createImageWithFallback = createImageWithFallback;
window.isPlausibleImageUrl = isPlausibleImageUrl;
window.upgradeCoverQuality = upgradeCoverQuality;
window.signProxyUrl = signProxyUrl;
window.coverProxyMemoHas = coverProxyMemoHas;
