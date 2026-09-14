/**
 * 播放器模块入口
 * 负责播放器核心控制和底部播放器栏
 */

// 封面懒加载随播放状态暂停：播放中让出浏览器同域名连接给音频流 / play-queue / player-state /
// lyrics 等业务请求，解决封面占满连接池导致 play-queue 等接口 RT 飙升。用 defineProperty 拦截
// window.isPlaying 赋值，自动调用 CoverLazy.setPaused，覆盖所有播放 / 暂停(结束)点，无需逐处改。
(function () {
    let _playing = false;
    try {
        Object.defineProperty(window, 'isPlaying', {
            configurable: true,
            get: function () { return _playing; },
            set: function (v) {
                _playing = !!v;
                if (window.CoverLazy && typeof window.CoverLazy.setPaused === 'function') {
                    window.CoverLazy.setPaused(_playing);
                }
            }
        });
    } catch (e) { /* 已有同名只读属性则忽略，不影响播放 */ }
})();

// 播放器音量拖动状态
let isPlayerVolumeDragging = false;
let playerVolumeRect = null; // 音量滑块位置缓存

// 播放请求 token，用于防止乱序
let playToken = 0;

// 标记是否正在播放新歌（用于跳过预加载）
let isLoadingNewSong = false;

// 播放失败行为：不自动切换下一首 —— 先自动换同音源分组内其它插件源（同一首歌逐个源尝试），
// 整组源全部失败则停止播放；成功换源后，当前及队列中后续同源歌曲统一改用新源。
// 以下计数/定时器仅在各清零点兼容保留（成功播放或手动停止时归零/清空），已不再用于自动跳歌。
let consecutivePlayErrors = 0;
let playErrorRetryTimer = null;
// 播放失败自动换源的跟踪状态：{ songKey, group, tried: [pluginName,...] }
// 记录"同一首歌在某音源分组内已尝试过的插件"，保证换源不重复、不无限循环
let autoFailoverState = null;

// 歌曲对象里可能出现的封面字段（不同插件字段名不一致，统一按此顺序识别）
const COVER_FIELDS = ['artwork', 'cover', 'coverImg', 'pic', 'albumArt', 'image'];

// 封面兜底补全的会话内缓存：key(插件|标题|歌手) -> { cover, ts }
const coverEnrichCache = new Map();
const COVER_ENRICH_HIT_TTL = 24 * 60 * 60 * 1000;   // 补到封面缓存 24h
const COVER_ENRICH_MISS_TTL = 10 * 60 * 1000;       // 没补到只缓存 10min，避免瞬时失败长期不重试

// 本地歌曲静默补词落盘节流：key(filePath) -> ts。同一文件 10 分钟内只补一次，
// 避免详情页未打开时反复播放同一首每次都发起 /api/lyrics
const localLyricSilentTs = new Map();
const LOCAL_LYRIC_SILENT_TTL = 10 * 60 * 1000;

/** 判断值是否为空（用于合并时跳过空值覆盖） */
function isEmptyValue(v) {
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

// ==================== 落雪（LX）音源：播放器侧多音源与切换 ====================
// 官方语义：可安装/启用多个音源脚本，播放在这些源之间自动回退；
// 播放器的「切换音源」用于指定优先使用的那个源（失败仍自动回退其它已启用源）。

/** 从 LX 歌曲里取平台 key（lx:kg → kg） */
function lxPlatformOf(song) {
    const raw = String((song && (song.plugin || song.platform)) || '');
    const m = /^lx:([a-z0-9]+)$/i.exec(raw);
    return m ? m[1].toLowerCase() : '';
}

/** 是否为落雪（LX）歌曲 */
function isLxSong(song) {
    return !!lxPlatformOf(song);
}

/** 读取「按平台记忆」的落雪音源偏好（播放器切换音源后记住） */
function getLxSourcePref(platform) {
    if (!platform) return '';
    try { return localStorage.getItem(`lx_source_pref::${platform}`) || ''; } catch { return ''; }
}

/** 保存落雪音源偏好 */
function saveLxSourcePref(platform, file) {
    if (!platform || !file) return;
    try { localStorage.setItem(`lx_source_pref::${platform}`, file); } catch { /* 隐私模式等忽略 */ }
}

// LX 音源列表短缓存（切换音源面板 / 按钮高亮共用，避免重复请求）
let lxSourcesCache = { ts: 0, list: [] };
const LX_SOURCES_CACHE_TTL = 30 * 1000;

/** 取已启用的 LX 音源列表（带 30s 缓存） */
async function fetchLxSources() {
    if (lxSourcesCache.list.length && Date.now() - lxSourcesCache.ts < LX_SOURCES_CACHE_TTL) {
        return lxSourcesCache.list;
    }
    try {
        const r = await API.lx.getSources();
        lxSourcesCache = { ts: Date.now(), list: (r && r.data) || [] };
    } catch { /* 请求失败沿用旧缓存 */ }
    return lxSourcesCache.list;
}

/** 同步读取缓存里的 LX 音源列表（用于按钮高亮等同步场景） */
function getLxSourcesCached() {
    return lxSourcesCache.list || [];
}

/** 从歌曲对象里取第一个有效封面 */
function pickCover(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const f of COVER_FIELDS) {
        const v = obj[f];
        if (!isEmptyValue(v)) return v;
    }
    return null;
}

/** 归一化字符串，用于标题/歌手比对 */
function normalizeText(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 判断 URL 是否为 HLS 直播流（.m3u8 / .m3u） */
function isHlsStream(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('.m3u8') || url.includes('.m3u');
}

const PlayerModule = {

    /**
     * 初始化播放器
     */
    init() {
        this.initExternalPlayer();
        this.bindEvents();
        this.initMediaSession();
    },

    /**
     * 处理音频 URL，如果需要代理则转换为代理 URL
     * 检查 URL 是否包含 _setHeaders 参数，如果包含则使用后端代理
     * @param {string} url - 原始音频 URL
     * @returns {string} 处理后的 URL
     */
    async processAudioUrl(url) {
        if (!url || typeof url !== 'string') {
            return url;
        }

        try {
            const urlObj = new URL(url);
            const setHeaders = urlObj.searchParams.get('_setHeaders');

            if (setHeaders) {
                // URL 包含 _setHeaders 参数，需要使用代理。
                // 安全改造：不再把外部完整 URL 暴露在请求参数，而是先到后端换短期签名 token，
                // 再以 /api/proxy/audio?token=xxx 形式访问（token 内含目标 URL + 过期时间 + 签名）。
                const tokenUrl = await signProxyUrl(url, 'audio');
                const proxyUrl = `${tokenUrl}&_setHeaders=${encodeURIComponent(setHeaders)}`;
                if (typeof log === 'function') {
                    log('DEBUG', 'Player', 'Using signed proxy URL for audio', { proxy: proxyUrl.substring(0, 60) });
                }
                return proxyUrl;
            }
        } catch (e) {
            // URL 解析失败或签名失败，返回原始 URL（由上层决定如何播放）
            if (typeof log === 'function') {
                log('WARN', 'Player', 'Failed to sign audio URL', { url: url.substring(0, 60), error: e.message });
            }
        }

        return url;
    },

    /**
     * 设置音频源并（按需）开始播放。
     * 支持三类来源：
     *   1) HLS 直播流（.m3u8/.m3u）且浏览器不支持原生 HLS → 使用 hls.js
     *   2) HLS 直播流且浏览器原生支持（Safari）→ audio 元素直接播放
     *   3) 普通音频流（mp3/aac/...）→ audio 元素直接播放
     * @param {string} url - 原始音频 URL（未做代理处理）
     * @param {boolean} autoPlay - 是否自动播放
     * @returns {Promise<boolean>} 是否实际开始播放（autoPlay 且成功）；非自动播放时返回 false（源已挂载）
     */
    async playStream(url, autoPlay) {
        const player = document.getElementById('audio-player');
        if (!player) return false;

        // 销毁旧 HLS 实例，避免切换歌曲时旧直播流残留
        if (window._hlsInstance) {
            try { window._hlsInstance.destroy(); } catch (e) { /* ignore */ }
            window._hlsInstance = null;
        }

        const finalUrl = await this.processAudioUrl(url);
        const isHls = isHlsStream(finalUrl);
        // HLS 源站普遍不发 CORS 头（实测央广仅允许 app.cctv.com 跨域），hls.js 直连必被浏览器拦截；
        // 且 HTTPS 页面拉 HTTP 流会触发混合内容拦截。统一经后端代理代拉并重写播放列表，保证同源可拉。
        // 安全改造：HLS 也走签名 token，前端不再暴露外部完整 URL。
        const sourceUrl = (isHls && !/\/api\/proxy\/hls/.test(finalUrl))
            ? await signProxyUrl(finalUrl, 'hls')
            : finalUrl;

        const tryPlay = async () => {
            if (!autoPlay) return false;
            try {
                await player.play();
                return true;
            } catch (e) {
                return false;
            }
        };

        // 1) HLS + hls.js（非原生支持的浏览器）
        if (isHls && window.Hls && window.Hls.isSupported()) {
            const hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
            window._hlsInstance = hls;
            return new Promise((resolve) => {
                let settled = false;
                const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
                hls.on(window.Hls.Events.ERROR, (_evt, data) => {
                    if (data && data.fatal) {
                        if (typeof log === 'function') {
                            log('ERROR', 'Play', `HLS fatal error: ${data.type}`, { token: undefined });
                        }
                        this.handlePlaybackFailure('电台加载失败');
                        done(false);
                    }
                });
                hls.loadSource(sourceUrl);
                hls.attachMedia(player);
                hls.on(window.Hls.Events.MANIFEST_PARSED, async () => {
                    done(await tryPlay());
                });
            });
        }

        // 2) 原生 HLS（Safari）——同样走代理，规避 HTTPS 页面拉 HTTP 流的混合内容拦截
        if (isHls && typeof player.canPlayType === 'function' && player.canPlayType('application/vnd.apple.mpegurl')) {
            player.src = sourceUrl;
            return tryPlay();
        }

        // 3) 普通音频流
        player.src = finalUrl;
        return tryPlay();
    },

    /**
     * 播放失败自动换源：同一首歌播放失败时，若它来自插件音源且该音源分组内
     * 还有其它可用插件，就自动改用组内下一个插件源重放当前歌曲（而不是直接跳过）；
     * 成功换源后，当前歌曲及队列中后续同音源分组的歌曲一并改用新源。
     * 组内全部源都尝试过仍失败时返回 false，交由统一失败处理停止播放。
     * @returns {boolean} 是否已触发自动换源重放
     */
    async tryAutoSourceFailover() {
        const song = window.currentMusic;
        if (!song) return false;

        // 仅对插件音源生效：本地文件 / 电台直播流没有可切换的分组源；
        // 但「手动/自动切到本地后播放失败」要继续用原插件分组换源（本地视为已尝试过）
        let pluginName = (typeof getPluginForMusic === 'function')
            ? getPluginForMusic(song, 'play', true)
            : (song.plugin || song.platform);
        if (pluginName === 'local' && song._localSwitchOrigin) {
            pluginName = song._localSwitchOrigin;
        } else if (!pluginName || pluginName === 'local' || pluginName === 'radio') {
            return false;
        }

        let group = this.getSongSourceGroup(song);
        if (!group && song._localSwitchOrigin) {
            const op = (window.installedPlugins || []).find(p => p.name === song._localSwitchOrigin);
            group = op ? (op.groupName || op.platform) : null;
        }
        if (!group) return false;

        // 以歌曲稳定标识区分「同一首」（与插件名无关，避免换源后被误判成新歌导致重复尝试）
        const songKey = (song.id != null && song.id !== '')
            ? `id:${song.id}`
            : `t:${song.title || ''}|${song.artist || ''}|${group}`;

        // 本轮（同一首歌 / 同一分组）已尝试过的源集合（'__local__' 代表本地曲库），每个源最多试一次，避免死循环
        if (!autoFailoverState || autoFailoverState.songKey !== songKey || autoFailoverState.group !== group) {
            autoFailoverState = { songKey, group, tried: [] };
        }
        const st = autoFailoverState;
        if (!st.tried.includes(pluginName)) st.tried.push(pluginName);

        // 1) 本地曲库候选：优先于其它插件（NAS 本地文件最稳，不依赖外网）
        if (!st.tried.includes('__local__')) {
            st.tried.push('__local__');
            let localMatch = null;
            try {
                const r = await API.music.localMatch(song);
                if (r && r.success && r.data) localMatch = r.data;
            } catch { localMatch = null; }
            if (localMatch && localMatch.filePath) {
                if (!song._localSwitchOrigin) song._localSwitchOrigin = pluginName;
                song.plugin = 'local';
                song.platform = 'local';
                song.filePath = localMatch.filePath;
                song.isLocalMatch = true;
                if (typeof PlayQueueAPI !== 'undefined' && window.currentPlaylist) {
                    PlayQueueAPI.saveQueue(window.currentPlaylist).catch(() => {});
                }
                // 清掉可能残留的旧定时器，避免历史失败计划里的自动跳歌打断本次换源重放
                if (playErrorRetryTimer) { clearTimeout(playErrorRetryTimer); playErrorRetryTimer = null; }
                if (typeof log === 'function') {
                    log('WARN', 'Play', `Playback failed, auto switch to LOCAL library (origin "${pluginName}")`, {
                        group, title: song.title, songId: song.id
                    });
                }
                showToast('播放失败，已自动切换到本地曲库播放', 'info');
                // 用本地文件重放当前歌曲；load 成功后会自动清理重试状态
                this.load(song, true).catch(() => {});
                return true;
            }
        }

        // 2) 同音源分组内已启用的插件；只有一源则无可换（工具插件不算可切换源）
        const groupPlugins = (window.installedPlugins || []).filter(p =>
            (p.groupName || p.platform) === group && p.enabled !== false
            && !(p.config && p.config.utility === true));
        if (groupPlugins.length <= 1) return false;

        const next = groupPlugins.find(p => p.name !== pluginName && !st.tried.includes(p.name));
        if (!next) {
            // 组内所有源均已尝试仍失败：保留跟踪状态供统一失败处理读取统计后停止播放
            return false;
        }
        st.tried.push(next.name);

        // 从本地切回插件：清理本地播放残留（手动切本地或自动本地优先都可能写过）
        if (song._localSwitchOrigin || song.isLocalMatch) {
            if (song._localSwitchOrigin) delete song.filePath;
            delete song.isLocalMatch;
            delete song._localSwitchOrigin;
        }

        // 换源后，当前歌曲及队列中后续同音源分组的歌曲统一改用新源（与手动切源保持一致）
        const applyTo = (s) => {
            s.plugin = next.name;
            s.platform = next.name;
            if (typeof getMusicSourceText === 'function') s.source = getMusicSourceText(next.name);
        };
        applyTo(song);
        const list = window.currentPlaylist || [];
        for (let i = Math.max(0, window.currentIndex); i < list.length; i++) {
            const s = list[i];
            if (!s) continue;
            const pg = (typeof getPluginForMusic === 'function')
                ? getPluginForMusic(s, 'play', true)
                : (s.plugin || s.platform);
            const pl = (window.installedPlugins || []).find(p => p.name === pg);
            const sg = pl ? (pl.groupName || pl.platform) : null;
            if (sg === group) applyTo(s);
        }

        // 自动换源后记住该分组当前可用的源，避免下次播放又退回旧源
        this.saveSourcePreference(group, next.name);
        if (typeof PlayQueueAPI !== 'undefined' && window.currentPlaylist) {
            PlayQueueAPI.saveQueue(window.currentPlaylist).catch(() => {});
        }

        // 清掉可能残留的旧定时器，避免历史失败计划里的自动跳歌打断本次换源重放
        if (playErrorRetryTimer) { clearTimeout(playErrorRetryTimer); playErrorRetryTimer = null; }

        const dispName = (next.name || '').replace(/\.[^./\\]+$/, '');
        if (typeof log === 'function') {
            log('WARN', 'Play', `Playback failed, auto switch source "${pluginName}" -> "${next.name}" (current & following same-group songs)`, {
                group, title: song.title, songId: song.id
            });
        }
        showToast(`播放失败，自动换源为「${dispName}」，后续同音源歌曲一并使用`, 'info');

        // 用新源重放当前歌曲；load 成功后会自动清理重试状态
        this.load(song, true).catch(() => {});
        return true;
    },

    /**
     * 播放失败统一处理。
     * 优先尝试同音源分组内自动换源（同一首歌把整组源逐个试一遍）；
     * 若已无可换源（整组源都失败 / 单源 / 本地 / 电台），停止播放，不再自动切换下一首。
     * @param {string} reason - 失败原因（用于提示与日志）
     */
    async handlePlaybackFailure(reason) {
        // 播放失败时清空解析缓存：最常见原因是签名 URL 过期，
        // 不清的话后续重试（含用户再点播放）会反复命中同一条死链。
        // TTL 只有 60 秒，清空对其它歌曲的代价可忽略。
        if (typeof Resolver !== 'undefined' && Resolver.clearCache) {
            Resolver.clearCache();
        }

        // 先尝试自动换源（本地曲库 → 同组其它插件）：换源成功即返回，由新源重新加载播放当前歌曲
        const recovered = await this.tryAutoSourceFailover();
        if (recovered) {
            return;
        }

        // 已无源可换，停止播放（不再自动跳下一首）
        let message;
        if (autoFailoverState) {
            // 区分「同音源分组内全部源均已尝试失败」的场景
            const st = autoFailoverState;
            message = `「${st.group}」的全部 ${st.tried.length} 个源均播放失败，已停止播放`;
            autoFailoverState = null;
        } else {
            message = `播放失败${reason ? `：${reason}` : ''}，已停止播放`;
        }

        if (typeof log === 'function') {
            log('ERROR', 'Play', message, { reason });
        }
        this.stopPlayback();
        showToast(message, 'error');
    },

    /**
     * 停止播放并清空音频源（含 HLS 实例）
     */
    stopPlayback() {
        // 取消可能未触发的重试，防止停止后仍继续切歌；同时重置自动换源跟踪状态
        if (playErrorRetryTimer) { clearTimeout(playErrorRetryTimer); playErrorRetryTimer = null; }
        autoFailoverState = null;

        const player = document.getElementById('audio-player');
        if (player) {
            // 标记用户主动停止，避免清空 src 触发的 error 事件再次进入错误处理
            this.isUserStopped = true;
            player.pause();
            player.removeAttribute('src');
            player.load();
            // 主动复位标志，避免长期屏蔽后续真实错误处理
            setTimeout(() => { this.isUserStopped = false; }, 200);
        }

        // 销毁 HLS 实例（直播流残留会继续占用媒体元素）
        if (window._hlsInstance) {
            try { window._hlsInstance.destroy(); } catch (e) { /* ignore */ }
            window._hlsInstance = null;
        }

        window.isPlaying = false;
        this.updateExternalPlayButton(false);
    },

    /**
     * 初始化 Media Session API（用于移动端通知栏控制）
     */
    initMediaSession() {
        if ('mediaSession' in navigator) {
            // 设置播放控制回调
            navigator.mediaSession.setActionHandler('play', () => {
                this.togglePlay();
            });

            navigator.mediaSession.setActionHandler('pause', () => {
                this.togglePlay();
            });

            navigator.mediaSession.setActionHandler('previoustrack', () => {
                this.playPrev();
            });

            navigator.mediaSession.setActionHandler('nexttrack', () => {
                this.playNext();
            });
        }
    },

    /**
     * 更新 Media Session 元数据（通知栏显示歌曲信息）
     */
    updateMediaSessionMetadata() {
        if (!('mediaSession' in navigator)) return;

        const music = window.currentMusic;
        if (!music) {
            navigator.mediaSession.metadata = null;
            return;
        }

        // 获取封面图
        const artworkUrl = music.artwork || music.coverImg || music.cover || music.pic || music.albumArt;
        const artwork = artworkUrl ? [
            { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '128x128', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '192x192', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '384x384', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }
        ] : [];

        navigator.mediaSession.metadata = new MediaMetadata({
            title: music.title || '未知歌曲',
            artist: music.artist || '未知艺术家',
            album: music.album || '',
            artwork: artwork
        });

        this.updateMediaSessionPlaybackState();
    },

    /**
     * 更新 Media Session 播放状态
     */
    updateMediaSessionPlaybackState() {
        if (!('mediaSession' in navigator)) return;

        const player = document.getElementById('audio-player');
        if (!player) return;

        // 设置播放状态
        navigator.mediaSession.playbackState = window.isPlaying ? 'playing' : 'paused';

        // 设置播放位置信息（用于显示进度）
        if ('setPositionState' in navigator.mediaSession && player.duration) {
            try {
                navigator.mediaSession.setPositionState({
                    duration: player.duration,
                    playbackRate: player.playbackRate || 1,
                    position: player.currentTime || 0
                });
            } catch (e) {
                // 某些浏览器可能不支持
            }
        }
    },

    /**
     * 初始化外部播放器（底部播放器栏）
     */
    initExternalPlayer() {
        this.updateExternalPlayButton();
        this.updateExternalPlayerInfo();
        this.updateExternalVolumeButton();
        this.updateExternalModeButton();
        this.initPlayerQuality();
        this.initPlayerVolume();
    },

    /**
     * 绑定事件
     */
    bindEvents() {
        const player = document.getElementById('audio-player');
        if (player) {
            player.addEventListener('ended', async () => await this.handlePlaybackEnded());
            player.addEventListener('timeupdate', () => this.handleTimeUpdate());

            // 播放错误时自动播放下一首
            player.addEventListener('error', (_e) => {
                // 用户主动停止播放时不处理错误（延迟重置标志，防止连续错误）
                if (this.isUserStopped) {
                    setTimeout(() => { this.isUserStopped = false; }, 100);
                    return;
                }
                // 音频源为空时不处理错误（可能是正常停止）
                if (!player.src || player.src === '' || player.src === window.location.href) {
                    return;
                }
                // 如果没有正在播放的歌曲，不处理错误（可能是旧请求的残留错误）
                if (!window.currentMusic) {
                    return;
                }
                // 错误代码 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) 且是空src，不处理
                if (player.error && player.error.code === 4 && (!player.src || player.src === '')) {
                    return;
                }
                const errorCode = player.error ? player.error.code : 'UNKNOWN';
                const errorMessage = this.getAudioErrorMessage(errorCode);

                // 记录前台日志 - 播放错误
                if (window.currentMusic && typeof API !== 'undefined' && API.logs && API.logs.add) {
                    API.logs.add('error', 'PLAYBACK', 'Playback error', {
                        title: window.currentMusic.title,
                        artist: window.currentMusic.artist,
                        plugin: window.currentMusic.plugin || window.currentMusic.platform || '未知插件',
                        error: errorMessage
                    }).catch(() => {});
                }

                this.handlePlaybackFailure(errorMessage);
            });

            player.addEventListener('volumechange', () => {
                localStorage.setItem('playerVolume', player.volume);
                // 保存播放器状态
                if (typeof savePlayerState === 'function') {
                    savePlayerState();
                }
            });
        }

        // 绑定全局键盘快捷键
        document.addEventListener('keydown', (e) => {
            // 如果正在输入框中，不处理快捷键
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return;
            }

            switch (e.key) {
                case ' ':
                case 'Spacebar':
                    e.preventDefault();
                    this.togglePlay();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this.playPrev();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.playNext();
                    break;
            }
        });
    },

    /**
     * 初始化播放器音质设置
     */
    initPlayerQuality() {
        // 使用全局默认音质作为初始值
        const globalQuality = localStorage.getItem('audio_quality') || 'standard';
        window.currentQuality = globalQuality;
        this.updateQualityButton(window.currentQuality);
    },

    /**
     * 初始化播放器音量
     */
    initPlayerVolume() {
        const player = document.getElementById('audio-player');
        if (!player) return;

        player.volume = 0.7;
        player.muted = false;

        const savedVolume = localStorage.getItem('playerVolume');
        if (savedVolume !== null) {
            player.volume = parseFloat(savedVolume);
        }

        this.updatePlayerVolumeUI();
        this.initPlayerVolumeDrag();
    },

    /**
     * 初始化播放器音量滑块拖动
     */
    initPlayerVolumeDrag() {
        const volumeSlider = document.getElementById('player-volume-slider');
        if (!volumeSlider) return;

        volumeSlider.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isPlayerVolumeDragging = true;
            playerVolumeRect = volumeSlider.getBoundingClientRect(); // 开始拖拽时缓存位置
            this.updatePlayerVolumeFromEvent(e);
            volumeSlider.classList.add('active');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isPlayerVolumeDragging) return;
            e.preventDefault();
            this.updatePlayerVolumeFromEvent(e);
        });

        document.addEventListener('mouseup', () => {
            if (isPlayerVolumeDragging) {
                isPlayerVolumeDragging = false;
                playerVolumeRect = null; // 清除缓存
                volumeSlider.classList.remove('active');
            }
        });

        volumeSlider.addEventListener('click', (e) => {
            e.stopPropagation();
            this.updatePlayerVolumeFromEvent(e);
        });
    },

    /**
     * 从事件更新播放器音量
     */
    updatePlayerVolumeFromEvent(event) {
        const player = document.getElementById('audio-player');
        const volumeSlider = document.getElementById('player-volume-slider');
        const volumeFill = document.getElementById('player-volume-fill');

        if (!volumeSlider) return;

        // 缓存 rect 避免拖拽过程中重复计算
        if (!playerVolumeRect) {
            playerVolumeRect = volumeSlider.getBoundingClientRect();
        }
        const percent = (event.clientX - playerVolumeRect.left) / playerVolumeRect.width;
        const volume = Math.max(0, Math.min(1, percent));

        player.volume = volume;
        player.muted = volume === 0;

        if (volumeFill) {
            volumeFill.style.width = (volume * 100) + '%';
        }

        this.updatePlayerVolumeIcon(volume, player.muted);
    },

    /**
     * 更新播放器音量UI
     */
    updatePlayerVolumeUI() {
        const player = document.getElementById('audio-player');
        const volumeSlider = document.getElementById('player-volume-slider');
        const volumeFill = document.getElementById('player-volume-fill');

        if (volumeSlider && volumeFill && player) {
            const percent = player.muted ? 0 : player.volume * 100;
            volumeFill.style.width = percent + '%';
            this.updatePlayerVolumeIcon(player.volume, player.muted);
        }
    },

    /**
     * 更新音量图标
     */
    updatePlayerVolumeIcon(volume, isMuted) {
        const volumeBtn = document.getElementById('player-volume-btn');
        if (!volumeBtn) return;

        if (isMuted || volume === 0) {
            volumeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
        } else if (volume < 0.5) {
            volumeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>';
        } else {
            volumeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
        }
    },

    /**
     * 更新外部播放器播放按钮
     */
    updateExternalPlayButton(isPlaying) {
        const playBtn = document.getElementById('play-btn');
        if (playBtn) {
            playBtn.innerHTML = isPlaying ? '⏸' : '▶';
        }

        const playerPlayBtn = document.getElementById('player-play-btn');
        if (playerPlayBtn) {
            playerPlayBtn.innerHTML = isPlaying
                ? '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
                : '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        }

        // 更新移动端功能区播放按钮
        const mobilePlayBtn = document.getElementById('player-play-btn-mobile');
        if (mobilePlayBtn) {
            mobilePlayBtn.innerHTML = isPlaying
                ? '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
                : '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        }

        // 同步更新播放详情页的播放按钮
        if (typeof PlayerDetail !== 'undefined' && PlayerDetail.updatePlayButton) {
            PlayerDetail.updatePlayButton(isPlaying);
        }

        // 更新 Media Session 播放状态
        this.updateMediaSessionPlaybackState();
    },

    /**
     * 合并插件返回的歌曲详情（getMusicInfo）到原歌曲对象
     *
     * 背景：部分插件（如酷狗）的 getMusicInfo 在接口取不到封面时会返回 artwork: ''，
     * 若用 { ...song, ...info } 直接展开，会把列表里已有的封面清空，
     * 表现就是“列表/搜索结果有封面，播放器上没封面”。
     *
     * 策略：
     * 1. 只覆盖非空字段（undefined / null / 空字符串不覆盖），其它字段保持原值；
     * 2. 封面字段（artwork/cover/coverImg/pic/albumArt/image）归一化：
     *    列表里已有的封面优先保留（已验证可显示），详情接口返回的封面仅用于补全，
     *    并同步写入所有封面字段，保证只认 artwork 的地方也能读到。
     *
     * @param {Object} song 原歌曲对象
     * @param {Object} info 插件 getMusicInfo 返回的详情
     * @returns {Object} 合并后的歌曲对象
     */
    mergeMusicInfo(song, info) {
        const merged = { ...(song || {}) };
        if (!info || typeof info !== 'object') return merged;

        Object.keys(info).forEach((key) => {
            const value = info[key];
            if (isEmptyValue(value)) return;
            merged[key] = value;
        });

        // 原封面优先（列表/搜索结果里已能正常显示），详情封面只作补全
        const finalCover = pickCover(song) || pickCover(info);
        if (finalCover) {
            COVER_FIELDS.forEach((f) => { merged[f] = finalCover; });
        }

        return merged;
    },

    /**
     * 封面兜底补全（针对历史脏数据：播放队列/歌单里的歌曲 artwork 已被空值覆盖过）
     *
     * 当歌曲对象完全没有封面时，用来源插件按「标题 + 歌手」搜索一次，
     * 取标题匹配度最高的结果的封面回填，并刷新底部播放器与播放详情页的封面。
     * 全程异步、不阻塞播放，结果按 key 缓存，避免同一首歌反复搜索。
     *
     * @param {Object} music 歌曲对象（会被就地写入封面）
     * @param {string} pluginName 来源插件名
     */
    async enrichCoverIfNeeded(music, pluginName) {
        if (!music || !pluginName || pluginName === 'local' || pluginName === 'undefined' || pluginName === 'null') return;
        if (!music.title || pickCover(music)) return;

        const key = `${pluginName}|${normalizeText(music.title)}|${normalizeText(music.artist)}`;
        const cached = coverEnrichCache.get(key);
        if (cached && Date.now() - cached.ts < (cached.cover ? COVER_ENRICH_HIT_TTL : COVER_ENRICH_MISS_TTL)) {
            this.applyEnrichedCover(music, cached.cover);
            return;
        }

        let cover = null;
        try {
            const query = `${music.title} ${music.artist || ''}`.trim();
            const res = await API.music.search(query, 'music', pluginName, 1);
            const list = (res && res.success && res.data && Array.isArray(res.data.data)) ? res.data.data : [];

            const title = normalizeText(music.title);
            const artist = normalizeText(music.artist);
            let best = null;
            let bestScore = 0;
            list.forEach((item) => {
                const itemCover = pickCover(item);
                if (!itemCover) return;
                const it = normalizeText(item.title);
                const ia = normalizeText(item.artist);
                let score = 0;
                if (it === title) score += 2;
                else if (it && (it.includes(title) || title.includes(it))) score += 1;
                if (artist && ia && (ia === artist || ia.includes(artist) || artist.includes(ia))) score += 1;
                if (score > bestScore) {
                    bestScore = score;
                    best = itemCover;
                }
            });
            // 至少要有标题上的相关性，避免张冠李戴拿错封面
            cover = bestScore > 0 ? best : null;
        } catch (e) {
            cover = null;
        }

        coverEnrichCache.set(key, { cover, ts: Date.now() });
        this.applyEnrichedCover(music, cover);
    },

    /**
     * 把补全到的封面写回歌曲对象，并刷新播放器/详情页封面（仅当它仍是当前播放歌曲）
     */
    applyEnrichedCover(music, cover) {
        if (!music || !cover) return;

        COVER_FIELDS.forEach((f) => { music[f] = cover; });

        // 同步播放列表里的同一首歌，避免切歌回来又变回没封面
        if (Array.isArray(window.currentPlaylist)) {
            const idx = window.currentPlaylist.findIndex(
                (s) => s && s.id === music.id && (s.plugin || s.platform) === (music.plugin || music.platform)
            );
            if (idx >= 0) {
                COVER_FIELDS.forEach((f) => { window.currentPlaylist[idx][f] = cover; });
            }
        }

        // 只有它仍是当前歌曲时才刷新 UI，防止切歌后被旧请求覆盖
        if (!window.currentMusic || window.currentMusic !== music) return;

        // 无封面时占位图标必须可见：它平时靠 img 的 onerror 才显示，
        // 若 cover 为空则根本没有 img、onerror 不会触发，封面区会留空。
        const pc = document.getElementById('player-cover');
        if (pc) {
            pc.innerHTML = cover
                ? createImageWithFallback(cover, 'cover', '')
                  + "<div style='font-size:24px;color:var(--text-tertiary);display:none'>🎵</div>"
                : "<div style='font-size:24px;color:var(--text-tertiary);'>🎵</div>";
        }
        const dc = document.getElementById('detail-cover');
        if (dc) {
            dc.innerHTML = cover
                ? createImageWithFallback(cover, 'cover', '')
                  + "<div style='font-size:80px;color:rgba(255,255,255,0.3);display:none'>🎵</div>"
                : "<div style='font-size:80px;color:rgba(255,255,255,0.3);'>🎵</div>";
        }
    },

    /**
     * 更新外部播放器信息
     */
    async updateExternalPlayerInfo() {
        const playerTitle = document.getElementById('player-title');
        const playerArtist = document.getElementById('player-artist');
        const playerAlbum = document.getElementById('player-album');
        const playerLocalTag = document.getElementById('player-local-tag');
        const playerCover = document.getElementById('player-cover');
        const playerLikeBtn = document.getElementById('player-like-btn');
        const playerDownloadBtn = document.getElementById('player-download-btn');

        if (!window.currentMusic) {
            if (playerTitle) playerTitle.textContent = '未在播放';
            if (playerArtist) playerArtist.textContent = '-';
            if (playerAlbum) playerAlbum.textContent = '';
            const _st = document.getElementById('player-source-type');
            const _sn = document.getElementById('player-source-name');
            if (_st) _st.textContent = '';
            if (_sn) _sn.textContent = '';
            if (playerLocalTag) playerLocalTag.style.display = 'none';
            const psTag0 = document.getElementById('player-source-tag');
            if (psTag0) psTag0.style.display = 'none';
            // 隐藏分隔符
            const metaRow = playerArtist?.parentElement;
            const metaSeparator = metaRow?.querySelector('.player-meta-separator');
            if (metaSeparator) metaSeparator.style.display = 'none';
            if (playerCover) {
                playerCover.innerHTML = '<div style="font-size: 24px; color: var(--text-tertiary);">🎵</div>';
            }
            if (playerLikeBtn) {
                playerLikeBtn.classList.remove('active');
                playerLikeBtn.style.color = '';
            }
            return;
        }

        const music = window.currentMusic;

        // 设置收藏按钮的 data 属性以便 ButtonManager 识别
        if (playerLikeBtn) {
            playerLikeBtn.dataset.musicId = music.id;
            playerLikeBtn.dataset.platform = music.platform || music.plugin || '';
        }

        // 设置下载按钮的 data 属性以便 ButtonManager 识别
        if (playerDownloadBtn) {
            playerDownloadBtn.dataset.musicId = music.id;
            playerDownloadBtn.dataset.platform = music.platform || music.plugin || '';
        }

        if (playerTitle) playerTitle.textContent = music.title;
        if (playerArtist) playerArtist.textContent = music.artist || '未知艺术家';
        if (playerAlbum) playerAlbum.textContent = music.album || '';

        // 处理分隔符显示：如果没有专辑，隐藏分隔符
        const metaRow = playerArtist?.parentElement;
        const metaSeparator = metaRow?.querySelector('.player-meta-separator');
        if (metaSeparator) {
            metaSeparator.style.display = music.album ? 'inline' : 'none';
        }

        // 来源分两行（与详情页一致）：
        //   第一行 = 来源类型：网络.LX / 网络.MF / 本地 / 电台
        //   第二行 = 直接来源名（落雪音源名 / MF插件名 / 本地显示STRM）；电台第二行留空
        const sourceTypeEl = document.getElementById('player-source-type');
        const sourceNameEl = document.getElementById('player-source-name');

        // 缓存徽标（本地缓存歌曲额外提示）
        const source = window.currentMusicSource; // 'local-cache' | 'local-file' | 'remote'
        if (playerLocalTag) {
            if (source === 'local-cache') {
                playerLocalTag.textContent = '缓存';
                playerLocalTag.className = 'player-source-tag cache';
                playerLocalTag.style.display = 'inline-block';
            } else {
                playerLocalTag.style.display = 'none';
            }
        }

        if (sourceTypeEl && typeof getSourceTypeLine === 'function') {
            sourceTypeEl.textContent = getSourceTypeLine(music) || '未知来源';
            sourceTypeEl.style.display = '';
        }
        if (sourceNameEl && typeof getSourceNameLine === 'function') {
            const name = getSourceNameLine(music);
            sourceNameEl.textContent = name || '';
            sourceNameEl.style.display = name ? '' : 'none';
        }

        if (playerCover) {
            // 本地文件：即使对象缺 artwork 字段，也按 filePath 构造内嵌封面 URL
            const isLocal = music.platform === 'local' || music.plugin === 'local' || !!music.filePath;
            // 远程封面地址不再持久化入库：无原始 URL 时，用虚拟封面 ID（coverArt/virtualId/id）
            // 经 /api/cover 实时向插件获取，与 Subsonic 客户端走同一套逻辑。
            const coverId = music.coverArt || music.virtualId || (typeof music.id === 'string' ? music.id : null);
            const coverUrl = music.artwork || music.coverImg || music.cover || music.pic || music.albumArt || music.image
                || (isLocal && music.filePath
                    ? `${window.API_BASE || ''}/api/music/cover?path=${encodeURIComponent(String(music.filePath).replace(/\\/g, '/'))}`
                    : null)
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : null);
            if (coverUrl) {
                playerCover.innerHTML = createImageWithFallback(coverUrl, 'cover', '') + "<div style='font-size:24px;color:var(--text-tertiary);display:none'>🎵</div>";
            } else {
                playerCover.innerHTML = '<div style="font-size: 24px; color: var(--text-tertiary);">🎵</div>';
            }
        }

        // 更新收藏按钮状态
        if (playerLikeBtn) {
            // 优先使用新的 StateManager + ButtonManager
            if (window.StateManager && window.ButtonManager) {
                const plugin = music.platform || music.plugin;
                // 如果当前在收藏页面，强制显示为已收藏（因为从收藏菜单播放的歌曲一定是已收藏的）
                const isFavorited = window.currentPage === 'favorites' ? true : StateManager.getFavoriteStatus(music.id, plugin);
                ButtonManager.updateFavoriteButton(music.id, plugin, isFavorited);

                // 异步更新精确状态
                const actualFavorited = await FavoriteManager.isFavorited(music);
                window.isCurrentMusicLiked = actualFavorited;
                music._isLiked = actualFavorited;
                StateManager.setFavoriteStatus(music.id, plugin, actualFavorited);
            }
            // 兼容旧代码
            else if (window.FavoriteManager) {
                const isFavorited = FavoriteManager.isFavoritedSync(music);
                FavoriteManager.updatePlayerButton(isFavorited);

                // 异步更新精确状态
                const actualFavorited = await FavoriteManager.isFavorited(music);
                window.isCurrentMusicLiked = actualFavorited;
                music._isLiked = actualFavorited;
                if (actualFavorited !== isFavorited) {
                    FavoriteManager.updatePlayerButton(actualFavorited);
                }
            }
        }

        // 更新下载按钮状态（异步查询数据库）
        if (window.StateManager && window.ButtonManager) {
            const plugin = music.platform || music.plugin;
            (async () => {
                try {
                    const downloadStatus = await StateManager.getDownloadStatus(music.id, plugin);
                    if (downloadStatus !== 'pending') {
                        ButtonManager.updateDownloadButton(music.id, plugin, downloadStatus);
                    }
                } catch (e) {
                    // 忽略错误
                }
            })();
        }

        // 同步更新播放详情页信息（如果已打开）
        if (typeof PlayerDetail !== 'undefined' && PlayerDetail.isOpen) {
            await PlayerDetail.updateInfo();
        }

        // 更新 Media Session 元数据（用于通知栏显示）
        this.updateMediaSessionMetadata();
    },

    /**
     * 更新外部播放器音量按钮
     */
    updateExternalVolumeButton(isMuted) {
        const volumeBtn = document.getElementById('volume-btn');
        if (volumeBtn) {
            volumeBtn.textContent = isMuted ? '🔇' : '🔊';
        }
    },

    /**
     * 更新外部播放器播放模式按钮
     */
    updateExternalModeButton(_mode) {
        // 更新循环按钮状态和图标
        if (typeof updateRepeatButtonIcon === 'function') {
            updateRepeatButtonIcon();
        }

        // 更新随机播放按钮状态
        const shuffleBtn = document.getElementById('player-shuffle-btn');
        if (shuffleBtn) {
            shuffleBtn.classList.toggle('active', window.isShuffleMode);
        }
    },

    /**
     * 更新音质按钮
     */
    updateQualityButton(quality) {
        // 更新播放详情页音质按钮（新结构：span嵌套在button中）
        const qualityText = document.getElementById('quality-text');
        const qualityBtn = document.getElementById('quality-btn');
        if (qualityText && QUALITY_CONFIG[quality]) {
            qualityText.textContent = QUALITY_CONFIG[quality].abbr;
        }
        if (qualityBtn && QUALITY_CONFIG[quality]) {
            qualityBtn.title = QUALITY_CONFIG[quality].name;
        }

        // 更新播放器底部栏音质按钮
        const playerQualityText = document.getElementById('player-quality-text');
        const playerQualityBtn = document.getElementById('player-quality-btn');
        if (playerQualityText && QUALITY_CONFIG[quality]) {
            playerQualityText.textContent = QUALITY_CONFIG[quality].abbr;
        }
        if (playerQualityBtn && QUALITY_CONFIG[quality]) {
            playerQualityBtn.title = '音质: ' + QUALITY_CONFIG[quality].name;
        }
    },

    /**
     * 切换播放/暂停
     * 如果没有正在播放的歌曲但播放列表有歌曲，则开始播放
     */
    async togglePlay() {
        const player = document.getElementById('audio-player');

        // 如果没有音频源但播放列表有歌曲，开始播放当前歌曲（或第一首）
        if (!player.src) {
            if (window.currentPlaylist && window.currentPlaylist.length > 0) {
                window.currentPageMusicList = [...window.currentPlaylist];
                // 使用当前索引播放，如果没有则播放第一首
                const playIndex = (window.currentIndex >= 0 && window.currentIndex < window.currentPlaylist.length)
                    ? window.currentIndex
                    : 0;
                playMusic(playIndex);
                showToast(`开始播放: ${window.currentPlaylist[playIndex]?.title || '未知歌曲'}`, 'success');
            }
            return;
        }

        if (window.isPlaying) {
            // 兼容清零：播放失败已不触发自动跳歌，此处仅确保旧状态被清空
            if (playErrorRetryTimer) { clearTimeout(playErrorRetryTimer); playErrorRetryTimer = null; }
            consecutivePlayErrors = 0;
            player.pause();
            window.isPlaying = false;
            this.updateExternalPlayButton(false);

            // 记录前台日志 - 暂停播放
            if (window.currentMusic && typeof API !== 'undefined' && API.logs && API.logs.add) {
                API.logs.add('info', 'PLAYBACK', 'Playback paused', {
                    title: window.currentMusic.title,
                    artist: window.currentMusic.artist,
                    plugin: window.currentMusic.plugin || window.currentMusic.platform || '未知插件'
                }).catch(() => {});
            }
        } else {
            try {
                // 尝试直接播放（浏览器策略允许用户交互时播放）
                await player.play();
                window.isPlaying = true;
                this.updateExternalPlayButton(true);

                // 记录前台日志 - 恢复播放
                if (window.currentMusic && typeof API !== 'undefined' && API.logs && API.logs.add) {
                    API.logs.add('info', 'PLAYBACK', 'Playback resumed', {
                        title: window.currentMusic.title,
                        artist: window.currentMusic.artist,
                        plugin: window.currentMusic.plugin || window.currentMusic.platform || '未知插件'
                    }).catch(() => {});
                }
            } catch (error) {
                // 播放失败，可能是音频未准备好，等待加载完成后再试
                if (error.name === 'NotSupportedError' || error.name === 'NotAllowedError') {
                    // 浏览器策略限制，不再重试
                } else {
                    // 音频未准备好，等待 canplay 事件后重试
                    const playWhenReady = async () => {
                        try {
                            await player.play();
                            window.isPlaying = true;
                            this.updateExternalPlayButton(true);
                        } catch (e) {
                            // 播放失败
                        }
                        player.removeEventListener('canplay', playWhenReady);
                    };

                    // 如果已经在加载中，直接监听 canplay
                    if (player.readyState >= 1) {
                        player.addEventListener('canplay', playWhenReady);
                    } else {
                        // 需要重新触发加载
                        player.load();
                        player.addEventListener('canplay', playWhenReady);
                    }

                    // 设置超时
                    setTimeout(() => {
                        player.removeEventListener('canplay', playWhenReady);
                    }, 10000);
                }
            }
        }

        // 保存播放器状态
        if (typeof savePlayerState === 'function') {
            savePlayerState();
        }
    },

    /**
     * 播放上一首
     */
    async playPrev() {
        if (!window.currentPlaylist || window.currentPlaylist.length === 0) return;

        // 记录前台日志 - 播放上一首
        const prevMusic = window.currentPlaylist[(window.currentIndex - 1 + window.currentPlaylist.length) % window.currentPlaylist.length];
        if (prevMusic && typeof API !== 'undefined' && API.logs && API.logs.add) {
            API.logs.add('info', 'PLAYBACK', 'Previous track', {
                title: prevMusic.title,
                artist: prevMusic.artist,
                plugin: prevMusic.plugin || prevMusic.platform || '未知插件'
            }).catch(() => {}); // 忽略日志发送错误
        }

        let newIndex;
        if (window.isShuffleMode) {
            newIndex = Math.floor(Math.random() * window.currentPlaylist.length);
        } else {
            newIndex = (window.currentIndex - 1 + window.currentPlaylist.length) % window.currentPlaylist.length;
        }
        await playMusic(newIndex);
    },

    /**
     * 获取音频错误消息
     * @param {number} errorCode - 错误代码
     * @returns {string} 错误消息
     */
    getAudioErrorMessage(errorCode) {
        switch (errorCode) {
            case 1:
                return '获取媒体数据被中止';
            case 2:
                return '网络错误';
            case 3:
                return '音频解码错误';
            case 4:
                return '音频源不支持或不存在';
            default:
                return '未知错误';
        }
    },

    /**
     * 加载并播放歌曲（核心播放编排）
     * 优先使用本地文件播放，本地不存在时转在线播放
     * @param {Object} song - 歌曲对象
     * @param {boolean} autoPlay - 是否自动播放（默认为true）
     */
    async load(song, autoPlay = true) {
        if (!song) return;

        // 应用该音源分组的持久化源偏好（用户手动切换源 / 自动换源时记录），
        // 保证刷新、重启、从歌单或恢复队列再次播放时仍使用用户所选源
        this.applySavedSourcePreference(song);

        // 落雪（LX）歌曲：未指定音源脚本时补上「按平台记忆」的偏好
        // （不指定则由后端按顺序尝试所有已启用音源，失败自动回退）
        if (isLxSong(song)) {
            const lxPlatform = lxPlatformOf(song);
            if (!song.lxSourceFile) {
                const pref = getLxSourcePref(lxPlatform);
                if (pref) song.lxSourceFile = pref;
            }
            // 预热音源列表：供「切换音源」面板与按钮高亮使用（30s 缓存，后续歌曲不再请求）
            fetchLxSources().then(() => this.updateSourceSwitchButton()).catch(() => {});
        }

        const player = document.getElementById('audio-player');
        if (!player) return;

        // 暂停当前播放，并清空src（避免缓存问题）
        player.pause();
        player.removeAttribute('src');
        player.load();
        window.isPlaying = false;

        // 销毁上一个 HLS 实例（切换到新歌曲时避免旧直播流残留）
        if (window._hlsInstance) {
            try { window._hlsInstance.destroy(); } catch (e) { /* ignore */ }
            window._hlsInstance = null;
        }

        // 标记正在加载新歌，跳过预加载
        isLoadingNewSong = true;

        // 生成新的播放 token
        const token = ++playToken;

        // 显示加载中状态
        this.updateExternalPlayButton(false);

        // 记录播放开关
        if (typeof log === 'function') {
            log('INFO', 'Play', `Start: ${song.title}`, { token, autoPlay, filePath: song.filePath });
        }

        // 更新音质按钮显示为当前歌曲的音质设置
        const savedSongQuality = this.getSongQuality(song);
        const songQuality = song.quality || savedSongQuality;
        if (songQuality && QUALITY_CONFIG[songQuality]) {
            window.currentQuality = songQuality;
            this.updateQualityButton(songQuality);
        }

        try {
            let url = null;
            let useLocalFile = false;

            // 网络电台/直播流：直接使用 url 播放，跳过 Resolver 与音质选择
            if (song.isLive && (song.url || song.streamUrl)) {
                url = song.url || song.streamUrl;
            }

            // 1. 优先尝试使用本地文件（如果有 filePath）
            // 注意：本地音乐(plugin==='local')的 filePath 是容器绝对路径(如 /app/music/xxx.mp3)，
            // 无法通过 ${API_BASE}${filePath} 直接访问，必须交给 Resolver 走 /api/local-files/stream
            const isLocalMusic = song.plugin === 'local' || song.platform === 'local';
            if (song.filePath && !isLocalMusic) {
                // 检查本地文件是否存在
                const localFileExists = await this.checkLocalFileExists(song.filePath);

                if (localFileExists) {
                    // 本地文件存在，使用本地文件
                    url = song.filePath;
                    useLocalFile = true;
                    if (typeof log === 'function') {
                        log('INFO', 'Play', `Using local file: ${song.filePath}`, { token });
                    }
                } else {
                    // 本地文件不存在，直接停止播放（已下载的歌曲必须有本地文件才能播放）
                    showToast('本地文件已删除，无法播放', 'error');
                    if (typeof log === 'function') {
                        log('WARN', 'Play', 'Local file deleted, stopping playback', { token, filePath: song.filePath });
                    }
                    // 清除音频源，停止播放缓存
                    player.removeAttribute('src');
                    player.load();
                    this.updateExternalPlayButton(false);
                    return;
                }
            }

            // 2. 如果没有本地文件或本地文件不存在，使用在线 URL
            if (!url) {
                if (typeof Resolver === 'undefined') {
                    throw new Error('Resolver not initialized');
                }

                // 获取音质：优先使用歌曲自己的设置，其次是全局默认音质
                const savedSongQuality = this.getSongQuality(song);
                const songQuality = song.quality || savedSongQuality;
                const globalQuality = localStorage.getItem('audio_quality') || 'standard';
                const quality = songQuality || globalQuality;

                url = await Resolver.resolve(song, quality, token);

                // 防御性检查：确保 URL 有效
                if (!url || typeof url !== 'string') {
                    throw new Error(`Invalid URL returned: ${url}`);
                }

                if (typeof log === 'function') {
                    log('INFO', 'Play', `Using online URL`, { token });
                }
            }

            // 检查 token 是否过期（防止旧请求覆盖新播放）
            if (token !== playToken) {
                if (typeof log === 'function') {
                    log('DEBUG', 'Play', 'Token expired, discarding old request', { token });
                }
                return;
            }

            // 获取音乐详细信息（封面等），不阻塞播放
            const pluginName = getPluginForMusic(song, 'play', true) || song.plugin || song.platform;
            // 落雪（LX）专区歌曲走自定义音源，不经过 MusicFree 插件：
            // 曲目自带封面，调 /api/music-info 只会得到「Plugin file not found: lx:xx」
            if (pluginName && pluginName !== 'local' && !useLocalFile && !song.isLive && !isLxPlugin(pluginName)) {
                try {
                    const infoResult = await API.music.getMusicInfo(song, pluginName);
                    // 防御性检查：确保 infoResult 存在且格式正确
                    if (infoResult && infoResult.success && infoResult.data && typeof infoResult.data === 'object') {
                        // 合并音乐信息（优先使用获取到的详细信息，但空值不覆盖已有数据，避免封面被清空）
                        const mergedSong = this.mergeMusicInfo(song, infoResult.data);
                        window.currentMusic = mergedSong;
                        // 更新播放列表中的歌曲信息
                        if (window.currentPlaylist[window.currentIndex]) {
                            window.currentPlaylist[window.currentIndex] = mergedSong;
                        }
                    }
                } catch (e) {
                    // 静默处理，不影响播放
                    if (typeof log === 'function') {
                        log('DEBUG', 'Play', `getMusicInfo error: ${e.message}`, { token });
                    }
                }

                // 仍然没有封面时（历史队列/歌单数据被空值覆盖过），用来源插件搜索补全一次
                this.enrichCoverIfNeeded(window.currentMusic, pluginName).catch(() => {});
            }

            // 本地曲库优先命中：插件（网络）歌曲被后端改播本地文件 → 标记当前播放为本地来源
            // （仅用于播放器显示「本地」标识，不修改歌单/列表内容）
            if (url && typeof url === 'string' && url.includes('/api/local-files/stream')
                && !(song.plugin === 'local' || song.platform === 'local')) {
                window.currentMusicSource = 'local-file';
                if (!window.currentMusic) window.currentMusic = { ...song };
                window.currentMusic.isLocalMatch = true;
            }

            // 本地歌曲（strm / 普通音频文件）缺封面/专辑/时长时，播放时按需搜索封面/专辑/时长并落库；
            // 歌词由 PlayerDetail.loadLyrics 走 /api/lyrics 补全，这里只补封面+专辑+时长
            const isLocalFile = song.isStrm
                || song.plugin === 'local'
                || song.platform === 'local'
                || (song.realMediaUri && (song.plugin === 'local' || song.platform === 'local'))
                || (song.filePath && song.plugin !== 'radio');
            const needEnrich = isLocalFile && window.currentMusic
                && (!pickCover(window.currentMusic)
                    || !window.currentMusic.album || window.currentMusic.album === '未知专辑'
                    || !window.currentMusic.duration);
            if (needEnrich) {
                try {
                    const enrichRes = await fetch(`${API_BASE}/api/music/enrich`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ music: window.currentMusic })
                    });
                    const enrichJson = await enrichRes.json();
                    if (enrichJson && enrichJson.success) {
                        const m = window.currentMusic;
                        let uiChanged = false;
                        if (enrichJson.cover) {
                            COVER_FIELDS.forEach((f) => { m[f] = enrichJson.cover; });
                            uiChanged = true;
                        }
                        if (enrichJson.matched && enrichJson.matched.album
                            && (!m.album || m.album === '未知专辑')) {
                            m.album = enrichJson.matched.album;
                            uiChanged = true;
                        }
                        const matchedDur = Number(enrichJson.matched && enrichJson.matched.duration);
                        if (matchedDur > 0 && !m.duration) {
                            m.duration = Math.round(matchedDur);
                            uiChanged = true;
                        }
                        // 同步播放列表里的同一首，避免切歌回来又变回没封面/没专辑/没时长
                        if (Array.isArray(window.currentPlaylist) && window.currentPlaylist[window.currentIndex]) {
                            const cp = window.currentPlaylist[window.currentIndex];
                            if (enrichJson.cover) COVER_FIELDS.forEach((f) => { cp[f] = enrichJson.cover; });
                            if (enrichJson.matched && enrichJson.matched.album
                                && (!cp.album || cp.album === '未知专辑')) {
                                cp.album = enrichJson.matched.album;
                            }
                            const cpDur = Number(enrichJson.matched && enrichJson.matched.duration);
                            if (cpDur > 0 && !cp.duration) {
                                cp.duration = Math.round(cpDur);
                            }
                        }
                        // 回填成功后刷新 UI（专辑名/时长由空变为真实值）
                        if (uiChanged) {
                            this.updateExternalPlayerInfo && this.updateExternalPlayerInfo();
                        }
                    }
                } catch (e) {
                    // 静默处理，不影响播放
                }
            }

            // 本地歌曲静默补词落盘（不阻塞播放）：后端会把搜索到的歌词写入同目录同名 .lrc
            // （strm 无法内嵌歌词，只能靠 .lrc 落地供下次本地加载）。
            if (isLocalFile && window.currentMusic && window.currentMusic.filePath) {
                const lrcKey = String(window.currentMusic.filePath);
                const lrcLast = localLyricSilentTs.get(lrcKey) || 0;
                if (Date.now() - lrcLast >= LOCAL_LYRIC_SILENT_TTL) {
                    localLyricSilentTs.set(lrcKey, Date.now());
                    const lyricMusic = {
                        title: window.currentMusic.title,
                        artist: window.currentMusic.artist,
                        filePath: lrcKey
                    };
                    fetch(`${API_BASE}/api/lyrics?plugin=${encodeURIComponent('local')}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ music: lyricMusic })
                    }).then((r) => r.json().catch(() => null)).then((lj) => {
                        if (lj && lj.success && lj.data && (lj.data.rawLrc || lj.data.lyrics || lj.data.lrc)
                            && typeof log === 'function') {
                            log('INFO', 'Play', 'Local lyrics fetched & persisted to .lrc', { title: lyricMusic.title });
                        }
                    }).catch(() => { /* 补词失败不影响播放 */ });
                }
            }

            // 设置音频源（处理代理 URL / HLS 直播流）并（按需）开始播放
            const started = await this.playStream(url, autoPlay);

            if (started) {
                window.isPlaying = true;
                this.updateExternalPlayButton(true);
                // 播放成功：清零连续失败计数，取消残留的自动切歌定时器，并重置自动换源跟踪状态
                consecutivePlayErrors = 0;
                autoFailoverState = null;
                if (playErrorRetryTimer) { clearTimeout(playErrorRetryTimer); playErrorRetryTimer = null; }
                if (typeof log === 'function') {
                    log('INFO', 'Play', `Success (${useLocalFile ? 'local' : 'online'}${song.isLive ? '/live' : ''})`, { token });
                }
            } else {
                window.isPlaying = false;
                this.updateExternalPlayButton(false);
                if (typeof log === 'function') {
                    log('WARN', 'Play', `Stream not started (${useLocalFile ? 'local' : 'online'}${song.isLive ? '/live' : ''})`, { token });
                }
            }

            // 更新 UI
            await this.updateExternalPlayerInfo();
            this.updateSourceSwitchButton();

            // 如果播放详情页是打开的，同步更新详情页信息
            if (typeof PlayerDetail !== 'undefined' && PlayerDetail.isOpen) {
                await PlayerDetail.updateInfo();
                PlayerDetail.loadLyrics();
                PlayerDetail.renderPlaylist();
            }

            // 强制重新渲染播放列表（如果面板打开）
            if (this.isContentPlaylistOpen) {
                this.renderContentPlaylist();
            }

            // 添加到最近播放（在线和本地都记录；电台/直播流不计入历史）
            const isRadioPlay = song.isLive || song.plugin === 'radio' || song.platform === 'radio';
            if (!isRadioPlay) {
            try {
                // 使用严格模式获取插件，确保使用歌曲原本的来源
                // 本地文件使用 'local' 作为插件标识
                const pluginName = useLocalFile ? 'local' : (getPluginForMusic(song, 'play', true) || song.plugin || song.platform);
                if (pluginName) {
                    // 同曲 3 秒内去重：playSong 成功回调偶发双触发（点击+事件链）会重复提交最近播放
                    const historyKey = `${song.id}|${pluginName}`;
                    const nowTs = Date.now();
                    if (this._lastRecentKey === historyKey && nowTs - (this._lastRecentAt || 0) < 3000) {
                        if (typeof log === 'function') {
                            log('DEBUG', 'Play', 'Skip duplicate recent play record', { songId: song.id, plugin: pluginName });
                        }
                    } else {
                        this._lastRecentKey = historyKey;
                        this._lastRecentAt = nowTs;
                        if (typeof log === 'function') {
                            log('DEBUG', 'Play', 'Adding to recent plays', { songId: song.id, title: song.title, plugin: pluginName, source: useLocalFile ? 'local' : 'online' });
                        }
                        const result = await API.myRecent.add(song, pluginName);
                        if (typeof log === 'function') {
                            log('DEBUG', 'Play', 'Added to recent plays', { success: result.success, songId: song.id, source: useLocalFile ? 'local' : 'online' });
                        }
                    }
                } else {
                    if (typeof log === 'function') {
                        log('WARN', 'Play', 'No plugin name found for recent plays', { songId: song.id });
                    }
                }
            } catch (e) {
                // 静默处理但记录日志
                if (typeof log === 'function') {
                    log('WARN', 'Play', `Failed to add recent play: ${e.message}`, { songId: song.id, error: e.message });
                }
            }
            }

            // 加载完成，重置标志
            isLoadingNewSong = false;

            // 预加载下一首
            this.preloadNext();

        } catch (error) {
            // 出错时也重置标志
            isLoadingNewSong = false;
            // 检查 token 是否过期，避免显示旧请求的错误
            if (token !== playToken) {
                return;
            }

            // 如果是被新请求取消，不显示错误
            if (error.message === 'Request cancelled by new play') {
                return;
            }

            // 记录错误
            if (typeof log === 'function') {
                log('ERROR', 'Play', `Error: ${error.message}`, { token });
            }
            this.updateExternalPlayButton(false);

            // URL获取失败：交由统一失败处理（自动换源；源耗尽则停止播放）
            this.handlePlaybackFailure(error.message || '获取音频失败');
        }
    },

    /**
     * 检查本地文件是否存在
     * @param {string} filePath - 文件路径（可以是 /downloads/xxx 或完整 URL）
     * @returns {Promise<boolean>}
     */
    async checkLocalFileExists(filePath) {
        if (!filePath) return false;

        try {
            // 如果是相对路径 /downloads/xxx，转换为完整 URL
            let fullUrl = filePath.startsWith('http') ? filePath : `${API_BASE}${filePath}`;

            // 添加时间戳绕过缓存
            const timestamp = Date.now();
            fullUrl += (fullUrl.includes('?') ? '&' : '?') + `_t=${timestamp}`;

            // 发送 HEAD 请求检查文件是否存在
            const response = await fetch(fullUrl, {
                method: 'HEAD',
                cache: 'no-store'
            });

            const exists = response.ok;
            if (typeof log === 'function') {
                log('DEBUG', 'Player', `Local file check: ${exists ? 'EXISTS' : 'NOT FOUND'}`, { filePath, status: response.status, url: fullUrl });
            }
            return exists;
        } catch (error) {
            if (typeof log === 'function') {
                log('DEBUG', 'Player', `Local file check error: ${error.message}`, { filePath });
            }
            return false;
        }
    },

    /**
     * 预加载下一首
     */
    async preloadNext() {
        // 如果正在加载新歌，跳过预加载
        if (isLoadingNewSong) return;

        if (!window.currentPlaylist || window.currentPlaylist.length === 0) return;

        const nextIndex = (window.currentIndex + 1) % window.currentPlaylist.length;
        const nextSong = window.currentPlaylist[nextIndex];

        // 网络电台/直播流无需预加载：它是持续流且已直连 url，
        // 走 Resolver 会因“插件名是平台名(如 全国电台)而非文件名”而解析失败刷 ERROR 日志
        if (nextSong && nextSong.isLive) return;

        if (nextSong && typeof Resolver !== 'undefined') {
            Resolver.preload(nextSong, window.currentQuality || 'standard');
        }
    },

    /**
     * 播放下一首
     */
    async playNext() {
        if (!window.currentPlaylist || window.currentPlaylist.length === 0) return;

        // 记录前台日志 - 播放下一首
        const nextMusic = window.currentPlaylist[(window.currentIndex + 1) % window.currentPlaylist.length];
        if (nextMusic && typeof API !== 'undefined' && API.logs && API.logs.add) {
            API.logs.add('info', 'PLAYBACK', 'Next track', {
                title: nextMusic.title,
                artist: nextMusic.artist,
                plugin: nextMusic.plugin || nextMusic.platform || '未知插件'
            }).catch(() => {}); // 忽略日志发送错误
        }

        let newIndex;
        if (window.isShuffleMode) {
            newIndex = Math.floor(Math.random() * window.currentPlaylist.length);
        } else {
            newIndex = (window.currentIndex + 1) % window.currentPlaylist.length;
        }
        await playMusic(newIndex);
    },

    /**
     * 处理播放结束事件
     */
    async handlePlaybackEnded() {
        const repeatMode = window.repeatMode || 'off';

        switch (repeatMode) {
            case 'single':
                const player = document.getElementById('audio-player');
                if (player) {
                    player.currentTime = 0;
                    player.play();
                }
                break;
            case 'all':
            case 'list':
            default:
                await this.playNext();
                break;
        }
    },

    /**
     * 处理时间更新
     */
    handleTimeUpdate() {
        const player = document.getElementById('audio-player');
        if (!player || !player.duration) return;

        const percent = (player.currentTime / player.duration) * 100;
        const progressFill = document.getElementById('progress-fill');
        if (progressFill) {
            progressFill.style.width = percent + '%';
        }

        const timeCurrent = document.getElementById('time-current');
        const timeTotal = document.getElementById('time-total');
        if (timeCurrent) timeCurrent.textContent = formatDuration(player.currentTime);
        if (timeTotal) timeTotal.textContent = formatDuration(player.duration);

        // 同步更新播放详情页
        if (typeof PlayerDetail !== 'undefined' && PlayerDetail.isOpen) {
            PlayerDetail.updateTime(player.currentTime, player.duration);
        }

        // 保存当前播放时间到全局变量（用于恢复播放进度）
        window.currentTime = player.currentTime;

        // 每10秒保存一次播放器状态（节流）
        this.savePlayerStateThrottled();

        // 更新 Media Session 播放位置（每5秒更新一次，避免过于频繁）
        this.updateMediaSessionPositionThrottled();
    },

    /**
     * 节流更新 Media Session 播放位置
     */
    updateMediaSessionPositionThrottled() {
        const now = Date.now();
        if (!this._lastMediaSessionUpdate || now - this._lastMediaSessionUpdate > 5000) {
            this._lastMediaSessionUpdate = now;
            this.updateMediaSessionPlaybackState();
        }
    },

    /**
     * 节流保存播放器状态
     */
    savePlayerStateThrottled() {
        const now = Date.now();
        if (!this._lastSaveTime || now - this._lastSaveTime > 10000) {
            this._lastSaveTime = now;
            if (typeof savePlayerState === 'function') {
                savePlayerState();
            }
        }
    },

    /**
     * 切换静音
     */
    toggleMute() {
        const player = document.getElementById('audio-player');
        if (!player) return;

        player.muted = !player.muted;
        this.updatePlayerVolumeIcon(player.volume, player.muted);

        // 记录前台日志 - 切换静音
        if (typeof API !== 'undefined' && API.logs && API.logs.add) {
            API.logs.add('info', 'PLAYBACK', player.muted ? 'Mute enabled' : 'Mute disabled', {
                volume: Math.round(player.volume * 100) + '%'
            }).catch(() => {});
        }
    },

    /**
     * 切换播放模式
     */
    togglePlayMode() {
        const modes = ['list', 'random', 'single'];
        const currentIndex = modes.indexOf(window.repeatMode || 'list');
        const nextIndex = (currentIndex + 1) % modes.length;
        window.repeatMode = modes[nextIndex];
        window.isShuffleMode = window.repeatMode === 'random';

        // 更新循环按钮图标
        if (typeof updateRepeatButtonIcon === 'function') {
            updateRepeatButtonIcon();
        }

        this.updateExternalModeButton(window.repeatMode);
        localStorage.setItem('repeatMode', window.repeatMode);

        const modeNames = { list: '列表循环', random: '随机播放', single: '单曲循环' };
        showToast(`播放模式: ${modeNames[window.repeatMode]}`, 'info');

        // 记录前台日志 - 切换播放模式
        if (typeof API !== 'undefined' && API.logs && API.logs.add) {
            const message = window.repeatMode === 'random' ? 'Shuffle enabled' :
                           window.repeatMode === 'single' ? 'Repeat enabled' :
                           window.isShuffleMode ? 'Shuffle disabled' : 'Repeat disabled';
            API.logs.add('info', 'PLAYBACK', message, {
                mode: modeNames[window.repeatMode]
            }).catch(() => {});
        }

        // 保存播放器状态
        if (typeof savePlayerState === 'function') {
            savePlayerState();
        }
    },

    /**
     * 切换音质
     * 优先保存到当前歌曲，其次保存为全局默认
     */
    toggleQuality() {
        const qualities = ['low', 'standard', 'high', 'super'];
        const currentIndex = qualities.indexOf(window.currentQuality || 'standard');
        const nextIndex = (currentIndex + 1) % qualities.length;
        const newQuality = qualities[nextIndex];
        window.currentQuality = newQuality;

        // 如果有当前歌曲，保存到歌曲设置中
        if (window.currentMusic) {
            window.currentMusic.quality = newQuality;
            // 保存歌曲音质设置到本地存储
            this.saveSongQuality(window.currentMusic, newQuality);
            showToast(`已设置当前歌曲音质: ${QUALITY_CONFIG[newQuality].name}`, 'info');
        } else {
            // 没有当前歌曲，保存为全局默认音质
            localStorage.setItem('audio_quality', newQuality);
            showToast(`已设置默认音质: ${QUALITY_CONFIG[newQuality].name}`, 'info');
        }

        this.updateQualityButton(newQuality);
        localStorage.setItem('playerQuality', newQuality);

        // 记录前台日志 - 切换音质
        if (typeof API !== 'undefined' && API.logs && API.logs.add) {
            API.logs.add('info', 'PLAYBACK', 'Quality changed', {
                quality: QUALITY_CONFIG[newQuality]?.name || newQuality,
                song: window.currentMusic?.title,
                artist: window.currentMusic?.artist,
                plugin: window.currentMusic?.plugin || window.currentMusic?.platform || '未知插件'
            }).catch(() => {});
        }
    },

    /**
     * 保存歌曲音质设置
     * @param {Object} song - 歌曲对象
     * @param {string} quality - 音质
     */
    saveSongQuality(song, quality) {
        if (!song || !song.id) return;

        const songKey = `song_quality_${song.plugin || song.platform}_${song.id}`;
        localStorage.setItem(songKey, quality);
    },

    /**
     * 获取歌曲音质设置
     * @param {Object} song - 歌曲对象
     * @returns {string|null} 音质设置，如果没有则返回null
     */
    getSongQuality(song) {
        if (!song || !song.id) return null;

        const songKey = `song_quality_${song.plugin || song.platform}_${song.id}`;
        return localStorage.getItem(songKey);
    },

    /**
     * 清除歌曲音质设置
     * @param {Object} song - 歌曲对象
     */
    clearSongQuality(song) {
        if (!song || !song.id) return;

        const songKey = `song_quality_${song.plugin || song.platform}_${song.id}`;
        localStorage.removeItem(songKey);
    },

    // ==================== 内容区播放列表功能 ====================

    /**
     * 切换内容区播放列表显示/隐藏
     */
    toggleContentPlaylist() {
        const panel = document.getElementById('content-playlist-panel');
        if (!panel) return;

        this.isContentPlaylistOpen = !this.isContentPlaylistOpen;

        if (this.isContentPlaylistOpen) {
            panel.classList.add('open');
            this.renderContentPlaylist();
        } else {
            panel.classList.remove('open');
        }

        this.updateContentPlaylistButton();
    },

    /**
     * 更新内容区播放列表按钮状态
     */
    updateContentPlaylistButton() {
        const playlistBtn = document.getElementById('player-playlist-btn');
        if (playlistBtn) {
            if (this.isContentPlaylistOpen) {
                playlistBtn.classList.add('active');
            } else {
                playlistBtn.classList.remove('active');
            }
        }
    },

    /**
     * 渲染内容区播放列表
     */
    renderContentPlaylist() {
        const playlistBody = document.getElementById('content-playlist-body');
        const playlistCount = document.getElementById('content-playlist-count');

        if (!playlistBody) return;

        // 更新数量
        if (playlistCount) {
            const count = window.currentPlaylist ? window.currentPlaylist.length : 0;
            playlistCount.textContent = `(${count})`;
        }

        // 渲染歌曲列表
        if (!window.currentPlaylist || window.currentPlaylist.length === 0) {
            playlistBody.innerHTML = '<div style="padding: 40px 20px; text-align: center; color: var(--text-tertiary);">播放列表为空</div>';
            return;
        }

        const html = window.currentPlaylist.map((song, index) => {
            const isPlaying = index === window.currentIndex;
            const coverId = song.coverArt || song.virtualId || (typeof song.id === 'string' ? song.id : null);
            const coverUrl = song.artwork || song.cover || song.coverImg || song.pic
                || (coverId ? `${window.API_BASE || ''}/api/cover?id=${encodeURIComponent(coverId)}` : null);
            const durationValue = song.duration || song.dt || song.time;
            const duration = durationValue ? formatTime(durationValue) : '--:--';

            // 来源名统一走取名逻辑：落雪（lx:kg）等非 MusicFree 插件来源也能正确显示，
            // 且不会因 getPluginForMusic 的非严格回退而"借"到别的插件名字。
            // 标签位置窄（flex-shrink:0），用短名；完整名（含实际生效音源）放 title
            const source = (typeof getDisplaySource === 'function')
                ? getDisplaySource(song, { short: true })
                : (song.sourcePlugin || song.plugin || song.platform || '-');
            const sourceFull = (typeof getDisplaySource === 'function') ? getDisplaySource(song) : source;

            return `
                <div class="content-playlist-item ${isPlaying ? 'playing' : ''}" data-index="${index}" onclick="PlayerModule.playFromContentPlaylist(${index})">
                    <div class="content-playlist-item-index">${isPlaying ? '▶' : (index + 1)}</div>
                    <div class="content-playlist-item-cover">
                        ${createImageWithFallback(coverUrl, song.title || 'cover')}
                        <div class="content-playlist-item-default-cover" style="${coverUrl ? 'display: none;' : 'display: flex;'}">🎵</div>
                    </div>
                    <div class="content-playlist-item-info">
                        <div class="content-playlist-item-row1">
                            <div class="content-playlist-item-title">${escapeHtml(song.title)}</div>
                            <div class="content-playlist-item-row1-right">
                                <span class="content-playlist-item-duration">${duration}</span>
                                ${source ? `<span class="content-playlist-item-source" title="${escapeHtml(sourceFull)}">${escapeHtml(source)}</span>` : ''}
                            </div>
                        </div>
                        <div class="content-playlist-item-row2">
                            <div class="content-playlist-item-row2-left">
                                <span class="content-playlist-item-artist">${escapeHtml(song.artist || '未知歌手')}</span>
                                ${song.album ? `<span class="content-playlist-item-separator">·</span><span class="content-playlist-item-album">${escapeHtml(song.album)}</span>` : ''}
                            </div>
                            <button class="content-playlist-item-remove" onclick="PlayerModule.removeFromContentPlaylist(${index}); event.stopPropagation();" title="移除">✕</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        playlistBody.innerHTML = html;

        // 滚动到正在播放的歌曲
        this.scrollToCurrentInContentPlaylist();
    },

    /**
     * 滚动内容区播放列表到正在播放的歌曲
     */
    scrollToCurrentInContentPlaylist() {
        const playlistBody = document.getElementById('content-playlist-body');
        if (!playlistBody) return;

        const currentItem = playlistBody.querySelector('.content-playlist-item.playing');
        if (currentItem) {
            currentItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    },

    /**
     * 从内容区播放列表播放指定歌曲
     */
    async playFromContentPlaylist(index) {
        if (typeof playMusic === 'function') {
            await playMusic(index);
        }
    },

    /**
     * 从内容区播放列表移除歌曲
     */
    removeFromContentPlaylist(index) {
        if (index < 0 || index >= window.currentPlaylist.length) return;

        // 获取要删除的歌曲信息（用于后端同步）
        const removedSong = window.currentPlaylist[index];

        // 如果删除的是当前播放的歌单
        if (index === window.currentIndex) {
            const player = document.getElementById('audio-player');
            if (player) player.pause();
            window.isPlaying = false;
            if (typeof updatePlayButton === 'function') {
                updatePlayButton();
            }
        }

        // 移除歌曲
        window.currentPlaylist.splice(index, 1);

        // 更新当前索引
        if (index < window.currentIndex) {
            window.currentIndex--;
        } else if (index === window.currentIndex) {
            if (window.currentPlaylist.length > 0) {
                if (window.currentIndex >= window.currentPlaylist.length) {
                    window.currentIndex = window.currentPlaylist.length - 1;
                }
                // 播放下一首
                if (typeof playMusic === 'function') {
                    playMusic(window.currentIndex);
                }
            } else {
                window.currentMusic = null;
                window.currentIndex = -1;
                const player = document.getElementById('audio-player');
                if (player) {
                    // 标记为用户主动停止，避免触发错误处理
                    this.isUserStopped = true;
                    player.src = '';
                    player.pause();
                }
                window.isPlaying = false;
                if (typeof updatePlayButton === 'function') {
                    updatePlayButton();
                }
            }
        }

        // 刷新播放列表显示
        this.renderContentPlaylist();

        // 刷新详情页播放列表（如果打开）
        if (typeof PlayerDetail !== 'undefined' && PlayerDetail.renderPlaylist) {
            PlayerDetail.renderPlaylist();
        }

        // 同步到后端（异步，不阻塞UI）
        if (typeof PlayQueueAPI !== 'undefined' && removedSong) {
            PlayQueueAPI.remove(removedSong.id, removedSong.plugin || removedSong.platform).catch(_err => {
                // 忽略错误
            });
        }

        showToast('已从播放列表移除', 'info');
    },

    /**
     * 更新内容区播放列表高亮
     */
    updateContentPlaylistHighlight() {
        if (!this.isContentPlaylistOpen) return;
        this.renderContentPlaylist();
    },

    // ==================== 音源选择持久化 ====================

    /** 读取已保存的「音源分组 → 首选插件源」偏好 */
    loadSavedSourcePreference(group) {
        if (!group) return null;
        try {
            const raw = localStorage.getItem('pluginSourcePreference');
            if (raw) {
                const map = JSON.parse(raw) || {};
                return map[group] || null;
            }
        } catch (e) { /* ignore */ }
        return null;
    },

    /** 保存某音源分组的首选插件源（手动切换源 / 自动换源时记录） */
    saveSourcePreference(group, pluginName) {
        if (!group || !pluginName) return;
        try {
            const raw = localStorage.getItem('pluginSourcePreference');
            const map = raw ? (JSON.parse(raw) || {}) : {};
            map[group] = pluginName;
            localStorage.setItem('pluginSourcePreference', JSON.stringify(map));
        } catch (e) { /* ignore */ }
    },

    /**
     * 播放前应用该音源分组的持久化源偏好：
     * 若当前歌曲来源插件的分组有已保存的首选源（且插件仍启用），则改用该源播放。
     * 放在 load 最前面，覆盖手动点击、队列恢复、自动换源后重放等所有入口。
     */
    applySavedSourcePreference(song) {
        if (!song) return;
        const group = this.getSongSourceGroup(song);
        if (!group) return;
        const pref = this.loadSavedSourcePreference(group);
        if (!pref) return;
        const currentName = (typeof getPluginForMusic === 'function')
            ? getPluginForMusic(song, 'play', true)
            : (song.plugin || song.platform);
        if (currentName === pref) return;
        // 首选源必须仍存在且启用才应用
        const target = (window.installedPlugins || []).find(p => p.name === pref && p.enabled !== false);
        if (!target) return;
        const applyTo = (s) => {
            s.plugin = pref;
            s.platform = pref;
            if (typeof getMusicSourceText === 'function') s.source = getMusicSourceText(pref);
        };
        applyTo(song);
        const cur = window.currentPlaylist && window.currentPlaylist[window.currentIndex];
        if (cur && cur !== song) applyTo(cur);
    },

    /**
     * 计算歌曲所属的音源分组（按插件目录名/平台名），本地/电台返回 null
     * @param {Object} song
     * @returns {string|null}
     */
    getSongSourceGroup(song) {
        if (!song) return null;
        const pluginName = (typeof getPluginForMusic === 'function')
            ? getPluginForMusic(song, 'play', true)
            : (song.plugin || song.platform);
        if (!pluginName || pluginName === 'local' || pluginName === 'radio') return null;
        const plugin = (window.installedPlugins || []).find(p => p.name === pluginName);
        return plugin ? (plugin.groupName || plugin.platform || null) : null;
    },

    /**
     * 打开「音源切换」弹窗：列出当前歌曲同名音源分组下的插件 + 「本地」曲库选项
     */
    async openSourceSwitch() {
        const song = window.currentMusic;
        if (!song) {
            showToast('当前没有正在播放的歌曲', 'info');
            return;
        }

        // 落雪（LX）歌曲：候选是「已启用且支持该平台的音源脚本」，
        // 切换即指定优先使用的脚本（失败仍由后端自动回退其它已启用音源）
        if (isLxSong(song)) {
            return this.openLxSourceSwitch(song);
        }

        // 已切到本地的歌曲：用记忆的原插件算分组，便于切回插件
        const originPlugin = song._localSwitchOrigin || null;
        let group = this.getSongSourceGroup(song);
        if (!group && originPlugin) {
            const op = (window.installedPlugins || []).find(p => p.name === originPlugin);
            group = op ? (op.groupName || op.platform) : null;
        }
        if (!group) {
            showToast('当前音源不支持切换（仅插件音源可切换）', 'info');
            return;
        }

        // 实际在播本地：手动切到本地（plugin==='local'）或自动「本地优先」命中（isLocalMatch）
        const isLocalCurrent = !!((song.plugin === 'local' && originPlugin) || song.isLocalMatch);
        const currentPlugin = originPlugin
            || ((typeof getPluginForMusic === 'function') ? getPluginForMusic(song, 'play', true) : (song.plugin || song.platform));

        // 工具插件（插件管理页标记 utility，如「酷我封面获取」）不参与音源切换展示
        const plugins = (window.installedPlugins || [])
            .filter(p => (p.groupName || p.platform) === group)
            .filter(p => !(p.config && p.config.utility === true));

        // 查询本地曲库匹配（未命中也正常展示弹窗，本地项置灰）
        let localMatch = null;
        try {
            const r = await API.music.localMatch(song);
            if (r && r.success && r.data) localMatch = r.data;
        } catch { localMatch = null; }
        window.__localSwitchMatch = localMatch;

        if (plugins.length === 0 && !localMatch && !isLocalCurrent) {
            showToast(`「${group}」音源下没有可切换的源`, 'info');
            return;
        }

        const existing = document.getElementById('source-switch-modal');
        if (existing) existing.remove();

        const localItem = `
                <div class="source-switch-item ${isLocalCurrent ? 'active' : ''} ${localMatch ? '' : 'disabled'}"
                     ${localMatch ? `onclick="switchPlayerSourceToLocal()"` : ''}>
                    <div class="source-switch-info">
                        <div class="source-switch-name">本地</div>
                        <div class="source-switch-meta">${isLocalCurrent ? '当前音源' : (localMatch ? '已匹配本地曲库 · 点击切换' : '本地曲库未找到匹配歌曲')}</div>
                    </div>
                    ${isLocalCurrent ? '<div class="source-switch-check">✓</div>' : ''}
                </div>`;

        const items = localItem + plugins.map(p => {
            const display = p.name.replace(/\.[^./\\]+$/, '');
            const isCurrent = !isLocalCurrent && p.name === currentPlugin;
            const disabled = p.enabled === false;
            return `
                <div class="source-switch-item ${isCurrent ? 'active' : ''} ${disabled ? 'disabled' : ''}"
                     data-plugin-name="${escapeHtml(p.name)}"
                     ${disabled ? '' : `onclick="switchPlayerSource('${escapeHtml(p.name)}')"`}>
                    <div class="source-switch-info">
                        <div class="source-switch-name">${escapeHtml(display)}</div>
                        <div class="source-switch-meta">${disabled ? '已禁用' : (isCurrent ? '当前音源' : '点击切换')}</div>
                    </div>
                    ${isCurrent ? '<div class="source-switch-check">✓</div>' : ''}
                </div>`;
        }).join('');

        const overlay = document.createElement('div');
        overlay.id = 'source-switch-modal';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content" style="width: 360px; max-width: 92%;">
                <div class="modal-header">
                    <h3 class="modal-title">切换音源 · ${escapeHtml(group)}</h3>
                    <button class="modal-close" onclick="closeSourceSwitchModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="source-switch-list">${items}</div>
                    <div class="source-switch-tip">「本地」按歌名+歌手匹配 NAS 本地曲库，仅切换当前歌曲；插件项切换后当前歌曲与后续同音源歌曲将一起换源。</div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSourceSwitchModal(); });
    },

    /**
     * 落雪（LX）歌曲的「切换音源」面板：列出「已安装且支持该平台」的音源脚本，
     * 选中即写回 song.lxSourceFile 作为优先源（失败仍由后端自动回退其它已启用音源）。
     * @param {Object} song 当前 LX 歌曲
     */
    async openLxSourceSwitch(song) {
        const platform = lxPlatformOf(song);
        const list = await fetchLxSources();
        const supported = (list || []).filter((s) => Array.isArray(s.platforms) && s.platforms.includes(platform));
        if (!supported.length) {
            showToast('没有支持该平台的落雪音源（请到「设置 → LX 音源」导入并启用）', 'info');
            return;
        }
        const enabledList = supported.filter((s) => s.enabled && s.state === 'ready');
        const current = song.lxSourceFile || getLxSourcePref(platform) || (enabledList[0] && enabledList[0].file) || '';

        const items = supported.map((s) => {
            const name = (s.meta && s.meta.name) || s.file;
            const isCurrent = s.file === current;
            const notEnabled = !s.enabled;
            const failed = s.enabled && s.state === 'error';
            const metaText = notEnabled ? '未启用（到「设置 → LX 音源」启用）'
                : failed ? '初始化失败，暂不可用'
                    : isCurrent ? '当前音源' : '点击切换';
            const cls = `${isCurrent ? 'active' : ''} ${(notEnabled || failed) ? 'disabled' : ''}`;
            const click = (notEnabled || failed) ? '' : `onclick="switchPlayerLxSource('${escapeHtml(s.file)}')"`;
            return `
                <div class="source-switch-item ${cls}" data-lx-file="${escapeHtml(s.file)}" ${click}>
                    <div class="source-switch-info">
                        <div class="source-switch-name">${escapeHtml(name)}</div>
                        <div class="source-switch-meta">${metaText}</div>
                    </div>
                    ${isCurrent ? '<div class="source-switch-check">✓</div>' : ''}
                </div>`;
        }).join('');

        const existing = document.getElementById('source-switch-modal');
        if (existing) existing.remove();

        const platformName = (typeof LX_PLATFORM_NAMES !== 'undefined' && LX_PLATFORM_NAMES[platform]) || platform;
        const overlay = document.createElement('div');
        overlay.id = 'source-switch-modal';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content" style="width: 360px; max-width: 92%;">
                <div class="modal-header">
                    <h3 class="modal-title">切换音源 · 落雪（${escapeHtml(platformName)}）</h3>
                    <button class="modal-close" onclick="closeSourceSwitchModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="source-switch-list">${items}</div>
                    <div class="source-switch-tip">可同时启用多个落雪音源：此处选中的优先使用，它失败时会自动回退到其它已启用音源。</div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSourceSwitchModal(); });
    },

    /**
     * 切换落雪音源：当前歌曲及队列中后续同平台 LX 歌曲统一改用所选脚本，并按时平台记忆
     * @param {string} file 音源脚本文件名
     */
    async switchPlayerLxSource(file) {
        const song = window.currentMusic;
        if (!song || !file || !isLxSong(song)) return;
        const platform = lxPlatformOf(song);
        // 同时清掉「上次实际生效的脚本」，避免切换后仍显示旧的生效源
        const applyTo = (s) => { s.lxSourceFile = file; delete s.lxResolvedFile; };
        applyTo(song);
        const list = window.currentPlaylist || [];
        for (let i = Math.max(0, window.currentIndex); i < list.length; i++) {
            const s = list[i];
            if (s && isLxSong(s) && lxPlatformOf(s) === platform) applyTo(s);
        }
        saveLxSourcePref(platform, file);
        // 解析缓存按 id+平台 存放，不清会命中切换前的旧地址
        if (typeof Resolver !== 'undefined' && Resolver.clearCache) Resolver.clearCache();
        if (typeof PlayQueueAPI !== 'undefined' && window.currentPlaylist) {
            PlayQueueAPI.saveQueue(window.currentPlaylist).catch(() => {});
        }
        this.updateExternalPlayerInfo();
        await this.load(song, true);
        this.updateContentPlaylistHighlight();
        this.updateSourceSwitchButton();
        closeSourceSwitchModal();
        showToast(`已切换到落雪音源：${file.replace(/\.[^./\\]+$/, '')}`, 'info');
    },

    /**
     * 切换到本地曲库播放当前歌曲：记住原插件（可再切回），仅影响当前歌曲
     */
    async switchPlayerSourceToLocal() {
        const song = window.currentMusic;
        const match = window.__localSwitchMatch;
        if (!song || !match || !match.filePath) return;

        // 记住原插件，便于从本地切回（弹窗按原插件分组展示）
        if (!song._localSwitchOrigin) {
            song._localSwitchOrigin = (typeof getPluginForMusic === 'function')
                ? getPluginForMusic(song, 'play', true)
                : (song.plugin || song.platform);
        }
        song.plugin = 'local';
        song.platform = 'local';
        song.filePath = match.filePath;
        song.isLocalMatch = true;

        if (typeof PlayQueueAPI !== 'undefined' && window.currentPlaylist) {
            PlayQueueAPI.saveQueue(window.currentPlaylist).catch(() => {});
        }

        this.updateExternalPlayerInfo();
        await this.load(song, true);
        this.updateContentPlaylistHighlight();
        this.updateSourceSwitchButton();
        closeSourceSwitchModal();
        showToast('已切换到本地曲库播放', 'info');
    },

    /**
     * 执行音源切换：当前歌曲及其后续同音源歌曲一起改用所选插件，并重载当前歌曲
     * @param {string} pluginName 目标插件文件名
     */
    async switchPlayerSource(pluginName) {
        const song = window.currentMusic;
        if (!song || !pluginName) return;
        let group = this.getSongSourceGroup(song);
        // 已切到本地的歌曲：用记忆的原插件算分组，允许切回插件
        if (!group && song._localSwitchOrigin) {
            const op = (window.installedPlugins || []).find(p => p.name === song._localSwitchOrigin);
            group = op ? (op.groupName || op.platform) : null;
        }
        if (!group) return;

        const target = (window.installedPlugins || []).find(p => p.name === pluginName);
        if (!target || target.enabled === false) {
            showToast('该音源已禁用，无法切换', 'error');
            return;
        }

        const applyTo = (s) => {
            s.plugin = pluginName;
            s.platform = pluginName;
            if (typeof getMusicSourceText === 'function') s.source = getMusicSourceText(pluginName);
        };

        // 当前歌曲：清理本地播放残留（手动切本地或自动本地优先都可能写过这些字段；
        // filePath 是 NAS 匹配路径，不清除会误触「已下载本地文件」播放分支）
        if (song._localSwitchOrigin || song.isLocalMatch) {
            if (song._localSwitchOrigin) delete song.filePath;
            delete song.isLocalMatch;
            delete song._localSwitchOrigin;
        }

        // 当前歌曲
        applyTo(song);

        // 后续同音源歌曲一起切换
        const list = window.currentPlaylist || [];
        const start = Math.max(0, window.currentIndex);
        for (let i = start; i < list.length; i++) {
            const s = list[i];
            if (!s) continue;
            const pg = (typeof getPluginForMusic === 'function')
                ? getPluginForMusic(s, 'play', true)
                : (s.plugin || s.platform);
            const pl = (window.installedPlugins || []).find(p => p.name === pg);
            const sg = pl ? (pl.groupName || pl.platform) : null;
            if (sg === group) applyTo(s);
        }

        // 记录该音源分组的首选源并持久化播放队列，保证刷新/重启后仍使用所选源
        this.saveSourcePreference(group, pluginName);
        if (typeof PlayQueueAPI !== 'undefined' && window.currentPlaylist) {
            PlayQueueAPI.saveQueue(window.currentPlaylist).catch(() => {});
        }

        // 更新播放器音源显示，并重载当前歌曲以切换音源
        this.updateExternalPlayerInfo();
        await this.load(song, true);
        this.updateContentPlaylistHighlight();
        this.updateSourceSwitchButton();

        // 用户手动换源成功：重置自动换源跟踪，避免沿用此前的失败尝试记录
        autoFailoverState = null;
        closeSourceSwitchModal();
        showToast(`已切换到音源：${pluginName.replace(/\.[^./\\]+$/, '')}`, 'info');
    },

    /**
     * 更新音源切换按钮（桌面 + 移动端）的高亮状态：按钮始终显示；
     * 仅当当前歌曲属于含 ≥2 个已启用插件的音源分组时点击才有意义，
     * 且若当前源不是组内第一个启用源（已手动/自动换过源）时高亮提醒。
     */
    updateSourceSwitchButton() {
        const song = window.currentMusic;
        let firstEnabledName = null;
        let currentName = null;

        if (isLxSong(song)) {
            // 落雪（LX）：同平台存在 ≥2 个已启用且就绪的音源时才高亮；
            // 当前指定的不是第一个可用音源（已手动/自动换过源）时高亮提醒
            const platform = lxPlatformOf(song);
            const enabled = getLxSourcesCached().filter((s) => s.enabled && s.state === 'ready'
                && Array.isArray(s.platforms) && s.platforms.includes(platform));
            if (enabled.length > 1) {
                firstEnabledName = enabled[0].file;
                currentName = song.lxSourceFile || getLxSourcePref(platform) || firstEnabledName;
            }
            ['player-source-switch-btn', 'player-source-switch-btn-mobile'].forEach((id) => {
                const btn = document.getElementById(id);
                if (!btn) return;
                btn.classList.toggle('active', !!currentName && currentName !== firstEnabledName);
            });
            return;
        }

        const group = this.getSongSourceGroup(song);
        if (group) {
            const enabled = (window.installedPlugins || []).filter(p => (p.groupName || p.platform) === group && p.enabled !== false
                && !(p.config && p.config.utility === true));
            if (enabled.length > 1) {
                firstEnabledName = enabled[0].name;
                currentName = (typeof getPluginForMusic === 'function')
                    ? getPluginForMusic(song, 'play', true)
                    : (song && (song.plugin || song.platform));
            }
        }

        ['player-source-switch-btn', 'player-source-switch-btn-mobile'].forEach((id) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            // 按钮始终可见；仅在没有同组可切换源时不高亮
            btn.classList.toggle('active', !!currentName && currentName !== firstEnabledName);
        });
    }
};

// 导出到全局作用域
window.PlayerModule = PlayerModule;
window.initExternalPlayer = () => PlayerModule.init();
window.togglePlay = () => PlayerModule.togglePlay();
window.playPrev = () => PlayerModule.playPrev();
window.playNext = () => PlayerModule.playNext();
window.toggleMute = () => PlayerModule.toggleMute();
window.togglePlayMode = () => PlayerModule.togglePlayMode();
window.toggleQuality = () => PlayerModule.toggleQuality();
window.updateExternalPlayerInfo = () => PlayerModule.updateExternalPlayerInfo();
window.updateExternalPlayButton = (isPlaying) => PlayerModule.updateExternalPlayButton(isPlaying);
window.toggleContentPlaylist = () => PlayerModule.toggleContentPlaylist();
window.renderContentPlaylist = () => PlayerModule.renderContentPlaylist();
window.updateContentPlaylistHighlight = () => PlayerModule.updateContentPlaylistHighlight();
window.updatePlayerVolumeUI = () => PlayerModule.updatePlayerVolumeUI();
window.updateExternalVolumeButton = (isMuted) => PlayerModule.updateExternalVolumeButton(isMuted);
window.togglePlayerMute = () => PlayerModule.toggleMute();
window.openSourceSwitch = () => PlayerModule.openSourceSwitch();
window.switchPlayerSource = (name) => PlayerModule.switchPlayerSource(name);
window.switchPlayerLxSource = (file) => PlayerModule.switchPlayerLxSource(file);
window.switchPlayerSourceToLocal = () => PlayerModule.switchPlayerSourceToLocal();
window.closeSourceSwitchModal = function() {
    const m = document.getElementById('source-switch-modal');
    if (m) m.remove();
};

/**
 * 打开播放器更多菜单
 */
window.openPlayerMoreMenu = function() {
    const menu = document.getElementById('player-more-menu');
    if (!menu) return;
    
    // 更新菜单项状态
    const shuffleBtn = document.getElementById('more-btn-shuffle');
    const repeatBtn = document.getElementById('more-btn-repeat');
    const likeBtn = document.getElementById('more-btn-like');
    
    if (shuffleBtn) {
        shuffleBtn.style.color = window.shuffleMode ? 'var(--primary-color)' : 'var(--text-color)';
    }
    if (repeatBtn) {
        repeatBtn.style.color = window.repeatMode !== 'none' ? 'var(--primary-color)' : 'var(--text-color)';
    }
    if (likeBtn && window.currentMusic) {
        likeBtn.style.color = window.isCurrentMusicLiked ? '#ff4757' : 'var(--text-color)';
    }
    
    menu.style.display = 'block';
    
    // 点击其他地方关闭菜单
    setTimeout(() => {
        document.addEventListener('click', closePlayerMoreMenuOnClickOutside);
    }, 10);
};

/**
 * 关闭播放器更多菜单
 */
window.closePlayerMoreMenu = function() {
    const menu = document.getElementById('player-more-menu');
    if (menu) {
        menu.style.display = 'none';
    }
    document.removeEventListener('click', closePlayerMoreMenuOnClickOutside);
};

/**
 * 点击外部关闭菜单
 */
function closePlayerMoreMenuOnClickOutside(event) {
    const menu = document.getElementById('player-more-menu');
    const moreBtn = document.getElementById('player-more-btn');
    
    if (menu && !menu.contains(event.target) && (!moreBtn || !moreBtn.contains(event.target))) {
        closePlayerMoreMenu();
    }
}


