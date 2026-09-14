/**
 * Resolver 核心 - 统一的 URL 解析层
 * 提供：缓存 + pending 去重 + 单入口调用 plugin
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runPlugin, loadPluginModule, resolvePluginFilePath } = require('./runner');
const { loadPluginConfig } = require('../lib/config');
const frontendLogger = require('../core/frontend-logger');

// ==================== 同音源（platform）聚合：一个音源可安装多个插件，按顺序轮流作为播放源 ====================

// 枚举插件目录下的所有插件文件（纯文件名，兼容平铺/子目录布局），与 context.listPluginNames 行为一致
function enumeratePluginFiles(pluginsDir) {
    const names = [];
    let entries;
    try {
        entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
        return names;
    }
    for (const entry of entries) {
        if (entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('..')) continue;
        if (entry.isFile()) {
            if (entry.name.endsWith('.js')) names.push(entry.name);
        } else if (entry.isDirectory()) {
            let inner = [];
            try {
                inner = fs.readdirSync(path.join(pluginsDir, entry.name));
            } catch { /* 忽略不可读目录 */ }
            for (const f of inner) {
                if (f.endsWith('.js') && !f.includes('/') && !f.includes('\\')) names.push(f);
            }
        }
    }
    return names;
}

// 读取某个插件文件的音源标识（platform）
function getPlatformOf(pluginsDir, pluginName) {
    try {
        const p = resolvePluginFilePath(pluginsDir, pluginName);
        if (!p || !p.endsWith('.js')) return null;
        const mod = loadPluginModule(p);
        return mod && mod.platform ? mod.platform : null;
    } catch {
        return null;
    }
}

// 聚合「同一音源」下的所有插件文件作为候选播放源：按用户配置顺序排序，起始插件置顶
function getSourceCandidates(pluginsDir, platform, startPlugin) {
    const files = enumeratePluginFiles(pluginsDir);
    const order = (loadPluginConfig().__pluginOrder) || [];
    const orderMap = order.reduce((m, k, i) => { m[k] = i; return m; }, {});
    const matched = [];
    for (const f of files) {
        const pf = getPlatformOf(pluginsDir, f);
        if (pf && pf === platform) matched.push(f);
    }
    matched.sort((a, b) => {
        const ia = orderMap[a] === undefined ? Number.MAX_SAFE_INTEGER : orderMap[a];
        const ib = orderMap[b] === undefined ? Number.MAX_SAFE_INTEGER : orderMap[b];
        return ia - ib;
    });
    if (startPlugin) {
        const idx = matched.indexOf(startPlugin);
        if (idx > 0) {
            const [s] = matched.splice(idx, 1);
            matched.unshift(s);
        }
    }
    return matched;
}

// 目标插件无法识别（已卸载/改名）时的兜底：用插件配置里的分组（displayName/group）找回
// 同组现役插件的音源。同一分组的插件来自同一音源站点，id 体系一致，可直接作为解析音源。
function recoverPlatformByConfig(pluginsDir, targetPlugin) {
    try {
        const all = loadPluginConfig();
        const stale = all[targetPlugin];
        const group = stale && (stale.displayName || stale.group);
        if (!group) return null;
        for (const [file, cfg] of Object.entries(all)) {
            if (file === targetPlugin || !cfg) continue;
            if (cfg.utility === true) continue; // 工具插件（封面获取等）无播放能力，不作候选
            if (cfg.displayName === group || cfg.group === group) {
                const pf = getPlatformOf(pluginsDir, file);
                if (pf) return pf;
            }
        }
    } catch { /* 忽略 */ }
    return null;
}

let logger = console;
let getDefaultPlugin = () => null;
let PLUGINS_DIR = './plugins';

function init(deps) {
    logger = deps.logger || console;
    getDefaultPlugin = deps.getDefaultPlugin || (() => null);
    PLUGINS_DIR = deps.pluginsDir || './plugins';
}

// 需要代理的域名列表（这些域名的音频链接需要添加特殊请求头才能播放）
const PROXY_DOMAINS = [
    'douyinvod.com',      // 汽水音乐/抖音 CDN
    'bytecdn.cn',         // 字节跳动 CDN
    'pstatp.com',         // 今日头条 CDN
    'music.tc.qq.com',    // QQ 音乐 CDN
    'qq.com',             // QQ 音乐
];

// 域名特定的请求头配置
const DOMAIN_HEADERS = {
    'douyinvod.com': {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
    },
    'bytecdn.cn': {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
    },
    'pstatp.com': {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
    },
    'music.tc.qq.com': {
        'Referer': 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
    },
    'qq.com': {
        'Referer': 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
    }
};

/**
 * 检查 URL 是否需要代理
 * @param {string} url - 音频 URL
 * @returns {object|null} - 如果需要代理返回 headers 对象，否则返回 null
 */
function getProxyHeadersForUrl(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        
        for (const domain of PROXY_DOMAINS) {
            if (hostname.includes(domain)) {
                return DOMAIN_HEADERS[domain] || null;
            }
        }
    } catch (_e) {
        // URL 解析失败
    }
    
    return null;
}

/**
 * 为 URL 添加代理标记
 * @param {string} url - 原始 URL
 * @param {object} headers - 需要设置的请求头
 * @returns {string} - 添加代理标记后的 URL
 */
function addProxyMarker(url, headers) {
    if (!url || typeof url !== 'string') {
        return url;
    }
    
    try {
        const separator = url.includes('?') ? '&' : '?';
        const setHeaders = encodeURIComponent(JSON.stringify(headers));
        return `${url}${separator}_setHeaders=${setHeaders}`;
    } catch (_e) {
        return url;
    }
}

// LX（落雪）音源：歌曲 plugin 形如 `lx:kg`，不经过 MusicFree 插件，而是走落雪自定义音源解析。
// 识别失败返回 null（保持原有 MusicFree 插件链路不变）。
function detectLxSource(plugin, music) {
    const candidates = [music && music.plugin, music && music.lxSource, plugin];
    for (const c of candidates) {
        const m = /^lx:([a-z0-9]+)$/i.exec(String(c || '').trim());
        if (m) return m[1].toLowerCase();
    }
    if (music && music.lxSource) return String(music.lxSource).toLowerCase();
    return null;
}

// 校验解析出的媒体 URL 是否有效（排除 "None"/"null"/相对路径等插件哨兵值）
function isValidMediaUrl(url) {
    if (typeof url !== 'string') return false;
    const u = url.trim().toLowerCase();
    if (!u || u === 'none' || u === 'null' || u === 'undefined') return false;
    return u.startsWith('http://') || u.startsWith('https://');
}

// 去掉代理标记（_setHeaders），返回纯媒体地址用于可达性探测
function stripProxyMarker(url) {
    if (!url || typeof url !== 'string') return url;
    try {
        const u = new URL(url);
        if (u.searchParams.has('_setHeaders')) {
            u.searchParams.delete('_setHeaders');
            return u.toString();
        }
    } catch { /* ignore */ }
    return url;
}

// 释放 axios stream 响应体，避免连接悬挂
function _consumeStream(resp) {
    try {
        if (resp && resp.data && typeof resp.data.destroy === 'function') resp.data.destroy();
        else if (resp && resp.data && typeof resp.data.resume === 'function') resp.data.resume();
    } catch { /* ignore */ }
}

/**
 * 读取流的前若干字节后立即释放连接（避免把整个音频文件拉下来）
 * @returns {Promise<Buffer>}
 */
function readStreamHead(stream, maxBytes = 16) {
    return new Promise((resolve) => {
        if (!stream || typeof stream.on !== 'function') return resolve(Buffer.alloc(0));
        let buf = Buffer.alloc(0);
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            try { stream.destroy(); } catch { /* ignore */ }
            resolve(buf);
        };
        const timer = setTimeout(done, 3000);
        stream.on('data', (chunk) => {
            buf = Buffer.concat([buf, Buffer.from(chunk)]);
            if (buf.length >= maxBytes) { clearTimeout(timer); done(); }
        });
        stream.on('end', () => { clearTimeout(timer); done(); });
        stream.on('error', () => { clearTimeout(timer); done(); });
    });
}

// 常见音频容器头部特征
function looksLikeAudio(head) {
    if (!head || head.length < 3) return false;
    const h = head;
    const hex4 = h.slice(0, 4).toString('hex');
    const ascii3 = h.slice(0, 3).toString('latin1');
    const ascii4 = h.slice(0, 4).toString('latin1');
    if (ascii3 === 'ID3') return true;                       // MP3(ID3)
    if (hex4.startsWith('fffb') || hex4.startsWith('fff3') || hex4.startsWith('fff2') || hex4.startsWith('fffa')) return true; // MP3 帧
    if (ascii4 === 'fLaC') return true;                      // FLAC
    if (ascii4 === 'OggS') return true;                      // OGG
    if (ascii4 === 'RIFF') return true;                      // WAV
    if (h.slice(4, 8).toString('latin1') === 'ftyp') return true; // M4A/MP4
    if (hex4 === '1a45dfa3') return true;                    // MKV/WebM
    if (ascii3 === '#!A') return true;                        // AMR
    if (h.slice(0, 2).toString('latin1') === 'AT') return true; // APE 不常见但留个口子
    return false;
}

/**
 * 校验「解析出的地址是否真的是音频」。
 * 落雪（LX）音源常见故障形态：第三方转发接口挂了，却依然返回 HTTP 200 + JSON 错误体。
 * 这种地址直接丢给 <audio> 只会得到浏览器侧含糊的「音频源不支持或不存在」（MediaError 4），
 * 因此这里主动判别并给出可读原因，让上层如实失败。
 *
 * 判定策略（宁可放行可疑，也不误杀真音频）：
 * - HTTP >= 400        → 失败（上游明确拒绝）
 * - Content-Type 为 json/html/text → 失败，并带上响应片段
 * - 其余情况           → 通过（含 octet-stream、无 Content-Type、音频类）
 * - 探测本身异常/超时  → 通过（不因探测失败阻断播放）
 *
 * @param {string} url 纯媒体地址（不含 _setHeaders 标记）
 * @param {Object|null} headers 需要透传的请求头（防盗链域名）
 * @returns {Promise<{ok:boolean, reason?:string, snippet?:string}>}
 */
async function probeAudioContent(url, headers = null) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    try {
        const resp = await axios.request({
            url,
            method: 'GET',
            headers: Object.assign({ 'User-Agent': UA, Range: 'bytes=0-2047' }, headers || {}),
            timeout: 8000,
            maxRedirects: 5,
            validateStatus: () => true,
            responseType: 'stream'
        });
        const ct = String(resp.headers['content-type'] || '').toLowerCase();
        if (resp.status >= 400) {
            _consumeStream(resp);
            return { ok: false, reason: `上游 HTTP ${resp.status}` };
        }
        // 明显不是音频的内容类型：读出片段作为证据
        if (/json|html|text\/plain|xml/.test(ct)) {
            const head = await readStreamHead(resp.data, 200);
            const snippet = head.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 180);
            return { ok: false, reason: `上游返回的不是音频（${ct || '未知类型'}）`, snippet };
        }
        // 兜底：无/含糊类型时用头部特征判断（仅当拿得到字节且明显是文本时才判失败）
        if (!ct || ct.includes('octet-stream')) {
            const head = await readStreamHead(resp.data, 16);
            if (head.length && looksLikeAudio(head)) return { ok: true };
            const asText = head.toString('utf8');
            if (/^\s*[\{\[]/.test(asText)) {
                return { ok: false, reason: '上游返回的不是音频（响应体为 JSON）', snippet: asText.replace(/\s+/g, ' ').slice(0, 180) };
            }
            return { ok: true };
        }
        _consumeStream(resp);
        return { ok: true };
    } catch (_e) {
        // 探测异常：保守放行，交给播放器与后续逻辑处理
        return { ok: true };
    }
}

/**
 * 探测媒体地址是否可播放（可达）。
 * - 2xx/3xx → 可达；>=400（403/404/410/5xx）→ 明确不可达；
 * - 探测本身异常（网络错误/超时/HEAD 不被允许 405）→ 保守视为可达，避免误切换可用音源。
 * @param {string} url 纯媒体地址（不含代理标记）
 * @returns {Promise<boolean>}
 */
async function probeUrlReachable(url) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const opts = (method, withRange) => ({
        url,
        method,
        headers: withRange ? { 'User-Agent': UA, Range: 'bytes=0-0' } : { 'User-Agent': UA },
        timeout: 5000,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'stream'
    });

    // 1) HEAD 探测
    try {
        const resp = await axios.request(opts('HEAD', false));
        _consumeStream(resp);
        if (resp.status === 405) {
            // HEAD 不被允许，改 GET Range 探测
        } else if (resp.status >= 200 && resp.status < 400) {
            return true;
        } else if (resp.status >= 400) {
            return false; // 明确不可达
        } else {
            return true;
        }
    } catch { /* 落到 GET 探测 */ }

    // 2) GET Range 探测（仅取状态，不下载正文）
    try {
        const resp = await axios.request(opts('GET', true));
        _consumeStream(resp);
        if (resp.status >= 200 && resp.status < 400) return true;
        if (resp.status >= 400) return false; // 明确不可达
        return true;
    } catch {
        // 探测异常：保守视为可达
        return true;
    }
}


// 拉流专用短时效缓存：签名 URL（酷狗 fts / 酷我路径 token）通常几分钟即过期，
// 长缓存会拿到失效地址导致客户端 403/404，故 resolveVerified 仅用短 TTL，
// 既能保证每次播放拿到新鲜地址、让探测及时发现死链换源，又避免同一次 HEAD+GET 突发重复解析。
const verifiedCache = new Map();
const VERIFIED_TTL = 60 * 1000; // 60 秒
const VERIFIED_MAX = 500;
function cleanExpiredVerified() {
    const now = Date.now();
    for (const [k, v] of verifiedCache.entries()) {
        if (now - v.ts > VERIFIED_TTL) verifiedCache.delete(k);
    }
}

const ResolverCore = {
    cache: new Map(),
    pending: new Map(),
    // URL 占用登记（url -> musicItemId）：防御第三方解析 API 对不同歌曲返回同一首
    // 「兜底歌曲」（实测 api.xunhuisi.store 对无效 mid 返回 200 + 固定歌曲地址），
    // 那种故障下所有歌会播同一个音频、缓存文件也全变成同一首歌的内容。
    _urlOwners: new Map(),
    CACHE_TTL: 30 * 60 * 1000,
    CACHE_MAX: 2000,

    getKey(id, plugin, quality) {
        return `${id}::${plugin}::${quality}`;
    },

    cleanExpired() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.ts > this.CACHE_TTL) {
                this.cache.delete(key);
            }
        }
    },

    async resolve(music, plugin, quality, userVars, reqId, fallbackMode = 'lower') {
        const targetPlugin = (plugin && plugin !== 'undefined' && plugin !== 'null') ? plugin : getDefaultPlugin();
        if (!targetPlugin) {
            return { success: false, error: 'No plugin installed' };
        }

        const musicItem = music ? { ...music, id: String(music.id) } : null;
        if (!musicItem) {
            return { success: false, error: 'Invalid music data' };
        }

        // LX（落雪）专区歌曲：交给落雪自定义音源解析（不走 MusicFree 插件）
        const lxSource = detectLxSource(plugin, musicItem);
        if (lxSource) {
            return this._resolveLx(musicItem, lxSource, quality, reqId, false);
        }

        // 解析起始插件的音源（platform），用来聚合「同一音源」下的所有插件作为候选播放源；
        // 插件已卸载/改名时用配置分组兜底恢复（播放历史可能残留旧插件名）
        const platform = getPlatformOf(PLUGINS_DIR, targetPlugin) || recoverPlatformByConfig(PLUGINS_DIR, targetPlugin);
        if (!platform) {
            return { success: false, error: `无法识别音源（缺少 platform 字段）: ${targetPlugin}` };
        }

        const candidates = getSourceCandidates(PLUGINS_DIR, platform, targetPlugin);
        if (!candidates.length) {
            return { success: false, error: '该音源下没有可用插件' };
        }

        // 缓存/pending 以「音源」为粒度：同一音源任一插件解析成功即共享，避免重复尝试其余源
        const cacheKey = this.getKey(musicItem.id, platform, quality);

        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.ts < this.CACHE_TTL)) {
            return { success: true, data: { url: cached.url, source: 'cache', status: 'success', sourceCount: candidates.length } };
        }

        if (this.pending.has(cacheKey)) {
            try {
                const url = await this.pending.get(cacheKey);
                return { success: true, data: { url, source: 'pending', status: 'success', sourceCount: candidates.length } };
            } catch (error) {
                return { success: false, error: error.message, status: 'failed' };
            }
        }

        const startTime = Date.now();
        const promise = this._resolveAcrossSources(musicItem, candidates, quality, userVars, cacheKey, reqId, fallbackMode);
        this.pending.set(cacheKey, promise);

        try {
            const result = await promise;
            const { url, sourcePlugin, actualQuality, degraded } = result;
            const duration = Date.now() - startTime;

            if (degraded) {
                logger.debug('RESOLVER', reqId, `SOURCE FALLBACK -> ${sourcePlugin} | ${duration}ms`);
            }

            return {
                success: true,
                data: {
                    url,
                    source: degraded ? 'fallback' : 'primary',
                    status: degraded ? 'degraded' : 'success',
                    sourcePlugin,
                    sourceCount: candidates.length,
                    duration
                }
            };
        } catch (error) {
            logger.error('RESOLVER', reqId, `ALL SOURCES FAILED | ${error.message}`);
            return { success: false, error: error.message, status: 'failed' };
        }
    },

    /**
     * 解析并校验可达性的变体：在 resolve 的基础上，对解析出的媒体地址做 HTTP 可达性探测，
     * 若当前音源地址不可达（4xx/5xx），自动换到同 platform 的下一个候选插件，直到找到可播放地址。
     * 仅当所有同组音源均不可达才返回失败（供上层停止/404）。
     *
     * 用于 OpenSubsonic 客户端（如箭头音乐）拉流：客户端拿到的地址若已失效，后端直接换成备用音源返回。
     */
    async resolveVerified(music, plugin, quality, userVars, reqId, fallbackMode = 'lower') {
        const targetPlugin = (plugin && plugin !== 'undefined' && plugin !== 'null') ? plugin : getDefaultPlugin();
        if (!targetPlugin) {
            return { success: false, error: 'No plugin installed' };
        }

        const musicItem = music ? { ...music, id: String(music.id) } : null;
        if (!musicItem) {
            return { success: false, error: 'Invalid music data' };
        }

        // LX（落雪）专区歌曲：同样走落雪自定义音源（带可达性探测，地址不可达自动换源）
        const lxSource = detectLxSource(plugin, musicItem);
        if (lxSource) {
            return this._resolveLx(musicItem, lxSource, quality, reqId, true);
        }

        // 插件已卸载/改名时用配置分组兜底恢复（播放历史可能残留旧插件名）
        const platform = getPlatformOf(PLUGINS_DIR, targetPlugin) || recoverPlatformByConfig(PLUGINS_DIR, targetPlugin);
        if (!platform) {
            return { success: false, error: `无法识别音源（缺少 platform 字段）: ${targetPlugin}` };
        }

        const candidates = getSourceCandidates(PLUGINS_DIR, platform, targetPlugin);
        if (!candidates.length) {
            return { success: false, error: '该音源下没有可用插件' };
        }

        const cacheKey = this.getKey(musicItem.id, platform, quality);
        cleanExpiredVerified();
        const cached = verifiedCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts < VERIFIED_TTL)) {
            return { success: true, data: { url: cached.url, source: 'cache', status: 'success', sourceCount: candidates.length } };
        }

        let lastError = null;
        for (let i = 0; i < candidates.length; i++) {
            const cand = candidates[i];
            const candKey = this.getKey(musicItem.id, cand, quality);
            let r;
            try {
                r = await this._fetchUrl(musicItem, cand, quality, userVars, candKey, reqId, fallbackMode);
            } catch (error) {
                lastError = error;
                logger.debug('RESOLVER', reqId, `Verified: source ${i + 1}/${candidates.length} (${cand}) resolve failed | ${error.message}`);
                continue;
            }

            const url = r && r.url;
            if (!url || !isValidMediaUrl(url)) {
                lastError = new Error('插件返回空地址');
                continue;
            }

            const cleanUrl = stripProxyMarker(url);
            const reachable = await probeUrlReachable(cleanUrl);
            if (reachable) {
                // 跨歌曲同 URL 防御（同 _resolveAcrossSources）：REST stream 链路同样拒绝源异常结果
                const urlOwnerKey = String(url);
                const urlOwner = this._urlOwners.get(urlOwnerKey);
                if (urlOwner && urlOwner !== String(musicItem.id)) {
                    lastError = new Error('解析源异常：不同歌曲返回了相同的音频地址');
                    logger.debug('RESOLVER', reqId, `Verified: source ${i + 1}/${candidates.length} (${cand}) rejected | duplicate url across songs`);
                    continue;
                }
                this._urlOwners.set(urlOwnerKey, String(musicItem.id));
                if (this._urlOwners.size > 1000) this._urlOwners.clear();
                verifiedCache.set(cacheKey, { url, ts: Date.now(), actualQuality: r.actualQuality });
                if (verifiedCache.size > VERIFIED_MAX) {
                    verifiedCache.delete(verifiedCache.keys().next().value);
                }
                logger.debug('RESOLVER', reqId, `Verified: source ${i + 1}/${candidates.length} (${cand}) reachable`);
                return {
                    success: true,
                    data: {
                        url,
                        source: i > 0 ? 'fallback' : 'primary',
                        status: i > 0 ? 'degraded' : 'success',
                        sourcePlugin: cand,
                        sourceCount: candidates.length
                    }
                };
            }

            // 地址不可达：清掉该候选缓存，换下一个同组音源
            this.cache.delete(candKey);
            lastError = new Error(`音源 ${cand} 地址不可达`);
            logger.debug('RESOLVER', reqId, `Verified: source ${i + 1}/${candidates.length} (${cand}) unreachable, switching`);
        }

        return { success: false, error: (lastError && lastError.message) || '所有音源均不可达', status: 'failed' };
    },

    // 按候选源（同音源多插件，已排序）逐个尝试解析；任一成功即返回，全部失败才抛出
    async _resolveAcrossSources(musicItem, candidates, quality, userVars, cacheKey, reqId, fallbackMode = 'lower') {
        let lastError = null;
        for (let i = 0; i < candidates.length; i++) {
            const cand = candidates[i];
            try {
                const r = await this._fetchUrl(
                    musicItem,
                    cand,
                    quality,
                    userVars,
                    this.getKey(musicItem.id, cand, quality),
                    reqId,
                    fallbackMode
                );
                // r = { url, source, actualQuality }，其中 source 为音质降级标记
                // 跨歌曲同 URL 防御：该地址已被其它歌曲占用 → 源异常，按失败处理（走换源/报错），绝不缓存
                const urlOwnerKey = String(r.url);
                const urlOwner = this._urlOwners.get(urlOwnerKey);
                if (urlOwner && urlOwner !== String(musicItem.id)) {
                    throw new Error('解析源异常：不同歌曲返回了相同的音频地址');
                }
                this._urlOwners.set(urlOwnerKey, String(musicItem.id));
                if (this._urlOwners.size > 1000) this._urlOwners.clear();
                this.cache.set(cacheKey, { url: r.url, ts: Date.now(), actualQuality: r.actualQuality });
                if (this.cache.size > ResolverCore.CACHE_MAX) {
                    this.cache.delete(this.cache.keys().next().value);
                }
                // 只要不是第一个候选、或发生过音质降级，都视为 degraded（已切换源）
                const degraded = i > 0 || r.source === 'fallback';
                return { url: r.url, sourcePlugin: cand, actualQuality: r.actualQuality, degraded };
            } catch (error) {
                lastError = error;
                logger.debug('RESOLVER', reqId, `Source ${i + 1}/${candidates.length} (${cand}) failed | ${error.message}`);
            }
        }
        throw lastError || new Error('所有音源均解析失败');
    },

    /**
     * LX（落雪）音源解析：由 lxmusic/resolver 调用已启用音源的 musicUrl 动作。
     * - verify=false：走 30 分钟解析缓存（播放/预加载）
     * - verify=true ：走 60 秒拉流短缓存 + 可达性探测（REST 拉流，地址失效自动换源）
     */
    async _resolveLx(musicItem, lxSource, quality, reqId, verify) {
        // 播放器「切换音源」选定的音源文件：作为优先源，失败仍回退其它已启用音源。
        // 计入缓存键，避免切换音源后命中上一个音源的旧地址。
        const preferFile = (musicItem && musicItem.lxSourceFile) ? String(musicItem.lxSourceFile) : null;
        const cacheKey = this.getKey(musicItem.id, `lx:${lxSource}`, quality)
            + (preferFile ? `::${preferFile}` : '');
        const store = verify ? verifiedCache : this.cache;
        const ttl = verify ? VERIFIED_TTL : this.CACHE_TTL;

        if (verify) cleanExpiredVerified();
        const cached = store.get(cacheKey);
        if (cached && (Date.now() - cached.ts < ttl)) {
            return {
                success: true,
                data: { url: cached.url, source: 'cache', status: 'success', sourcePlugin: `lx:${lxSource}`, sourceFile: cached.sourceFile || null },
            };
        }

        if (this.pending.has(cacheKey)) {
            try {
                const hit = await this.pending.get(cacheKey);
                return {
                    success: true,
                    data: { url: hit.url, source: 'pending', status: 'success', sourcePlugin: `lx:${lxSource}`, sourceFile: hit.sourceFile || null },
                };
            } catch (error) {
                return { success: false, error: error.message, status: 'failed' };
            }
        }

        const promise = (async () => {
            // 惰性 require，避免未使用 LX 专区时加载音源模块
            const { resolveLx } = require('../lxmusic/resolver');
            // 候选音源可用性判定：既看可达性，也看「返回的是不是真音频」。
            // 由 resolveLx 在候选循环里逐个调用 —— 某个源返回 JSON 假地址时会自动换下一个源，
            // 而不是整单失败（落雪音源最常见的故障就是转发接口返回 JSON 错误体）。
            const validateUrl = async (u) => {
                const h = getProxyHeadersForUrl(u);
                return probeAudioContent(stripProxyMarker(u), h);
            };

            const r = await resolveLx({
                music: musicItem,
                source: lxSource,
                quality,
                reqId,
                probe: validateUrl,
                preferFile,
            });
            if (!r.success) throw new Error(r.error);

            let url = r.data.url;
            // 与插件链路一致：需要防盗链头的域名统一挂 _setHeaders 标记，由代理转发
            const headers = getProxyHeadersForUrl(url);
            if (headers) url = addProxyMarker(url, headers);

            store.set(cacheKey, { url, ts: Date.now(), actualQuality: r.data.quality, sourceFile: r.data.from || null });
            const max = verify ? VERIFIED_MAX : this.CACHE_MAX;
            if (store.size > max) store.delete(store.keys().next().value);
            return { url, sourceFile: r.data.from || null, switched: !!(r.data.tried && r.data.tried.length) };
        })();

        this.pending.set(cacheKey, promise);
        try {
            const hit = await promise;
            return {
                success: true,
                data: {
                    url: hit.url,
                    source: 'lx',
                    status: 'success',
                    sourcePlugin: `lx:${lxSource}`,
                    sourceFile: hit.sourceFile,
                    switched: hit.switched,
                },
            };
        } catch (error) {
            logger.error('RESOLVER', reqId, `LX RESOLVE FAILED (${lxSource}) | ${error.message}`);
            return { success: false, error: error.message, status: 'failed' };
        } finally {
            this.pending.delete(cacheKey);
        }
    },

    _mapQuality(quality) {
        const qualityMap = {
            'low': 'standard',
            'standard': 'standard',
            'high': 'high',
            'super': 'high',
            'lossless': 'high'
        };
        return qualityMap[quality] || 'standard';
    },

    _getQualityFallbackChain(quality) {
        const mappedQuality = this._mapQuality(quality);
        const fallbackChains = {
            'lossless': ['high', 'standard'],
            'high': ['high', 'standard'],
            'standard': ['standard', 'high']  // standard失败时尝试high音质
        };
        return fallbackChains[mappedQuality] || ['standard', 'high'];
    },

    _getQualityUpgradeChain(quality) {
        const mappedQuality = this._mapQuality(quality);
        const upgradeChains = {
            'standard': ['standard', 'high', 'lossless'],
            'high': ['high', 'lossless'],
            'lossless': ['lossless']
        };
        return upgradeChains[mappedQuality] || ['standard'];
    },

    _getQualityChain(quality, fallbackMode = 'lower') {
        if (fallbackMode === 'higher') {
            return this._getQualityUpgradeChain(quality);
        }
        return this._getQualityFallbackChain(quality);
    },

    async _fetchUrl(musicItem, plugin, quality, userVars, cacheKey, reqId, fallbackMode = 'lower') {
        let lastError = null;
        let pluginFailed = false;
        const qualityChain = this._getQualityChain(quality, fallbackMode);
        
        // 音质降级链（仅在需要降级时显示）
        if (qualityChain.length > 1) {
            logger.debug('RESOLVER', reqId, `Quality chain: [${qualityChain.join(', ')}]`);
        }

        try {
            for (let qualityIndex = 0; qualityIndex < qualityChain.length; qualityIndex++) {
                const currentQuality = qualityChain[qualityIndex];

                try {
                    // 下载操作启用节流（避免风控）
                    const result = await runPlugin(plugin, 'getMediaSource', [musicItem, currentQuality], userVars, PLUGINS_DIR, reqId, true);

                    if (result === null || result === undefined) {
                        throw new Error('Plugin returned empty result');
                    }

                    let url = null;
                    let pluginHeaders = null;
                    if (typeof result === 'string') {
                        url = result;
                    } else if (typeof result === 'object' && result.url) {
                        url = result.url;
                        // 插件可能额外返回自定义请求头（如 htqyy 的 Referer 防盗链），需透传以便经代理转发，
                        // 否则浏览器 <audio> 无法携带自定义头，会被源站防盗链 403 拒绝。
                        if (result.headers && typeof result.headers === 'object') {
                            pluginHeaders = result.headers;
                        }
                    }

                    if (url && isValidMediaUrl(url)) {
                        // 合并「域名专属代理头」（汽水/QQ 等 PROXY_DOMAINS）与「插件返回的自定义头」（htqyy 等），
                        // 统一以 _setHeaders 形式附加到 URL，由前端 processAudioUrl 走后端代理转发。
                        const proxyHeaders = getProxyHeadersForUrl(url);
                        const mergedHeaders = Object.assign({}, proxyHeaders, pluginHeaders);
                        if (Object.keys(mergedHeaders).length > 0) {
                            url = addProxyMarker(url, mergedHeaders);
                        }
                        
                        this.cache.set(cacheKey, { url, ts: Date.now(), actualQuality: currentQuality });
                        if (this.cache.size > ResolverCore.CACHE_MAX) {
                          // 超出上限淘汰最旧条目（Map 保留插入顺序）
                          this.cache.delete(this.cache.keys().next().value);
                        }

                        let source = 'primary';
                        if (pluginFailed) {
                            source = 'fallback';
                        }

                        // 记录客户端请求播放的歌曲（含歌名/歌手），供前端「系统日志」展示，不依赖前端 JS 是否执行
                        frontendLogger.info('PLAYBACK', 'Playback started', {
                            title: musicItem && musicItem.title,
                            artist: musicItem && musicItem.artist,
                            album: musicItem && musicItem.album,
                            plugin: (musicItem && musicItem.platform) || plugin
                        });

                        return { url, source, actualQuality: currentQuality };
                    }

                    throw new Error('Empty or invalid URL (plugin returned no playable source)');

                } catch (error) {
                    lastError = error;
                    pluginFailed = true;

                    if (qualityIndex < qualityChain.length - 1) {
                        const nextQuality = qualityChain[qualityIndex + 1];
                        logger.debug('RESOLVER', reqId, `Quality ${currentQuality} failed, trying ${nextQuality} | ${error.message}`);
                        continue;
                    }

                    throw error;
                }
            }

            throw lastError || new Error('Failed to get URL for any quality');

        } finally {
            this.pending.delete(cacheKey);
        }
    }
};

module.exports = { ResolverCore, init, probeAudioContent, probeUrlReachable };
