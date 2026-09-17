/**
 * 订阅下载服务
 * 调用统一下载服务 (DownloadService) 处理实际下载
 * 从API实时获取完整数据（与手动按钮相同逻辑）
 */

const path = require('path');
const fs = require('fs');
const DownloadService = require('./download-service');

const SERVICE_MODULE = 'SUBSCRIPTION_DOWNLOAD';

// ============ 语言识别（用于“排除语言”过滤）============
// 语言别名 -> 标准标签
const LANG_ALIASES = {
    english: ['english', '英文', '英语', 'eng', 'en'],
    japanese: ['japanese', '日文', '日语', 'jp', 'ja'],
    korean: ['korean', '韩文', '韩语', 'kr', 'ko'],
    chinese: ['chinese', '中文', '华语', '国语', '普通话', 'cmn', 'zh'],
    cantonese: ['cantonese', '粤语', '粤文', 'yue', 'ct']
};
const ALIAS_TO_TAG = {};
for (const [tag, aliases] of Object.entries(LANG_ALIASES)) {
    for (const a of aliases) ALIAS_TO_TAG[a] = tag;
}

// 将用户输入/文本中的语言别名归一化为标准标签
function normalizeLangTag(raw) {
    return ALIAS_TO_TAG[String(raw || '').trim().toLowerCase()] || null;
}

// 根据歌曲的 language 字段与标题，识别其可能的语言标签集合
function detectSongLangTags(language, title) {
    const tags = new Set();
    const lang = String(language || '').toLowerCase();
    const titleStr = String(title || '');

    // 1) language 字段直接命中别名（如 "en"/"ja"/"粤语"/"yue"）
    for (const aliases of Object.values(LANG_ALIASES)) {
        for (const a of aliases) {
            if (lang.includes(a)) {
                const t = normalizeLangTag(a);
                if (t) tags.add(t);
            }
        }
    }

    // 2) 标题字符脚本检测
    const hasHangul = /[가-힣]/u.test(titleStr);
    const hasKana = /[ぁ-ゖァ-ヺ]/u.test(titleStr);
    const hasHan = /[一-鿿]/u.test(titleStr);
    const cjkCount = (titleStr.match(/[一-鿿ぁ-ゖァ-ヺ가-힣]/gu) || []).length;
    const latinCount = (titleStr.match(/[A-Za-z]/gu) || []).length;

    if (hasHangul) tags.add('korean');
    if (hasKana) tags.add('japanese');
    // 纯汉字（无假名/谚文）视为中文/华语
    if (hasHan && !hasKana && !hasHangul) tags.add('chinese');
    // 完全无 CJK/假名/谚文，且含拉丁字母 -> 视为英文
    if (latinCount > 0 && cjkCount === 0) tags.add('english');

    return tags;
}

// 下载目录（与server.js保持一致）
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '..', '..', 'downloads');

// 获取下载目录的绝对路径
function getAbsoluteDownloadPath(relativePath) {
    if (!relativePath || relativePath === './downloads' || relativePath === 'downloads') {
        // 使用默认下载目录
        return DOWNLOAD_DIR;
    }
    if (path.isAbsolute(relativePath)) {
        return relativePath;
    }
    return path.resolve(process.cwd(), relativePath);
}

class SubscriptionDownloadService {
    constructor(database, logger, config) {
        this.db = database;
        this.logger = logger;
        this.config = config || {};

        // 初始化统一下载服务
        this.downloadService = new DownloadService({
            logger: logger,
            userVars: config.userVars || {},
            downloadSettings: {
                quality: 'high',
                qualityFallback: 'lower'
            }
        });
    }

    /**
     * 下载单个订阅的歌曲
     * 从API实时获取完整数据（与手动按钮相同逻辑）
     * @param {Object} subscription - 订阅对象
     * @param {Object} options - 选项 { delay: 500, onProgress: fn, onSongComplete: fn, force: false }
     * @returns {Promise<Object>} - 下载结果 { downloaded, skipped, failed, totalSongs }
     */
    async downloadSubscription(subscription, options = {}) {
        const delay = options.delay || 2000;
        const onProgress = options.onProgress || null;
        const force = options.force || false;
        const result = { downloaded: 0, skipped: 0, failed: 0, totalSongs: 0, alreadyDownloaded: 0 };

        this.logger.info(SERVICE_MODULE, 'downloadSubscription', 'Starting download', {
            subscriptionId: subscription.id,
            title: subscription.title
        });

        // ========== 第一步：从API获取完整原始数据（与手动按钮相同）==========
        const { platform, toplist_id: toplistId, title, source_type, user_id } = subscription;
        let apiSongs = [];
        try {
            const { runPlugin } = require('../MusicFree/runner');
            const pluginsDir = this.config.pluginsDir || './plugins';
            // 使用 config 中的用户变量（兼容 server.js 传入的函数或对象）
            const userVars = typeof this.config.userVars === 'function'
                ? this.config.userVars()
                : (this.config.userVars || {});

            const isPlaylist = source_type === 'playlist';
            const method = isPlaylist ? 'getMusicSheetInfo' : 'getTopListDetail';
            const methodArgs = isPlaylist
                ? [{ id: toplistId }, 1]
                : [{ id: toplistId, title }, 1];

            const apiResult = await runPlugin(platform, method, methodArgs, userVars, pluginsDir, 'subscribe-download');

            if (apiResult && apiResult.musicList) {
                apiSongs = apiResult.musicList;
            }
        } catch (err) {
            this.logger.error(SERVICE_MODULE, 'downloadSubscription', 'Failed to get API data', {
                platform, toplistId, error: err.message
            });
            return result;
        }

        if (apiSongs.length === 0) {
            this.logger.info(SERVICE_MODULE, 'downloadSubscription', 'No songs from API');
            return result;
        }

        // ========== 第三步：过滤并准备下载列表（使用API完整数据）==========
        const toDownload = [];

        // 排除规则（来自下载设置）：歌手为子串匹配；语言基于 language 字段别名+标题字符脚本识别（见 detectSongLangTags）
        const excludeArtists = (options.excludeArtists || [])
            .map(a => String(a || '').trim().toLowerCase())
            .filter(Boolean);
        const excludeLanguages = (options.excludeLanguages || [])
            .map(l => String(l || '').trim().toLowerCase())
            .filter(Boolean);
        const excludeLangTags = new Set(excludeLanguages.map(normalizeLangTag).filter(Boolean));

        for (const apiSong of apiSongs) {
            const musicId = String(apiSong.id);

            // 排除歌手（歌曲歌手包含任一排除项则跳过）
            const songArtist = String(apiSong.artist || '').toLowerCase();
            if (excludeArtists.some(name => songArtist.includes(name))) {
                result.skipped++;
                continue;
            }

            // 排除语言（识别歌曲语言标签，命中任一排除语言则跳过）
            const songTags = detectSongLangTags(apiSong.language, apiSong.title);
            if ([...songTags].some(t => excludeLangTags.has(t))) {
                result.skipped++;
                continue;
            }

            // 下载记录去重：已在下载记录中完成过的文件不再重复下载
            try {
                const existing = await this.db.getDownload(musicId, subscription.platform);
                if (existing && existing.status === 'completed') {
                    result.alreadyDownloaded++;
                    result.skipped++;
                    continue;
                }
            } catch {
                // 查询失败时不过滤，继续走正常下载流程
            }

            // 使用API完整数据
            toDownload.push({
                ...apiSong,  // ✅ 完整原始数据
                plugin: platform,
                quality: subscription.download_quality || 'standard'
            });
        }

        result.totalSongs = apiSongs.length;

        // 初始进度：把"已下载过的文件数"反映到进度基数（0/N 中的 0 显示为已下载数）
        if (onProgress) {
            onProgress({
                current: result.alreadyDownloaded,
                total: apiSongs.length,
                title: '',
                downloaded: result.alreadyDownloaded,
                skipped: result.skipped,
                failed: result.failed,
                message: `已下载记录匹配 ${result.alreadyDownloaded} 首，待下载 ${toDownload.length} 首`
            });
        }

        this.logger.info(SERVICE_MODULE, 'downloadSubscription', 'Download list prepared', {
            apiTotal: apiSongs.length,
            toDownload: toDownload.length
        });

        if (toDownload.length === 0) {
            return result;
        }

        // 预登记：本轮待下载歌曲先写成 pending 记录，使「下载管理 → 下载中」能看到完整任务列表，
        // 每首下载完成后状态翻转为 completed（同时出现在「已下载」），不再只有“下载中一闪而过”
        for (const s of toDownload) {
            try {
                await this.db.addDownload(
                    { id: s.id, title: s.title, artist: s.artist, album: s.album },
                    subscription.platform,
                    subscription.download_quality || 'standard'
                );
            } catch (err) {
                this.logger.warn(SERVICE_MODULE, 'enqueue', 'Failed to pre-register download record', {
                    title: s.title, error: err.message
                });
            }
        }

        // ========== 第四步：逐个下载（使用API完整数据）==========
        for (let i = 0; i < toDownload.length; i++) {
            const song = toDownload[i];

            if (onProgress) {
                onProgress({
                    current: i + 1,
                    total: toDownload.length,
                    title: song.title,
                    downloaded: result.alreadyDownloaded + result.downloaded,
                    skipped: result.skipped,
                    failed: result.failed
                });
            }

            try {
                const success = await this._downloadSongWithApiData(song, subscription, { force });
                if (success) {
                    result.downloaded++;
                } else {
                    result.failed++;
                }

                // 每首完成后回调：订阅侧据此实时回写统计（前端卡片进度随之增长）
                if (typeof options.onSongComplete === 'function') {
                    try {
                        await options.onSongComplete({
                            downloaded: result.alreadyDownloaded + result.downloaded,
                            totalSongs: result.totalSongs,
                            failed: result.failed,
                            title: song.title
                        });
                    } catch (err) {
                        this.logger.warn(SERVICE_MODULE, 'onSongComplete', 'Progress callback failed', { error: err.message });
                    }
                }

                if (delay > 0 && i < toDownload.length - 1) {
                    await new Promise(r => setTimeout(r, delay));
                }
            } catch (err) {
                result.failed++;
                this.logger.error(SERVICE_MODULE, 'downloadSubscription', `Download error`, { error: err.message });
            }
        }

        this.logger.info(SERVICE_MODULE, 'downloadSubscription', 'Completed', result);
        return result;
    }

    /**
     * 使用API完整数据下载单首歌曲
     */
    async _downloadSongWithApiData(song, subscription, options = {}) {
        const force = options.force || false;

        try {
            this.logger.debug(SERVICE_MODULE, 'downloadSong', 'Starting download', {
                title: song.title,
                song_id: song.id,
                platform: subscription.platform
            });

            // 下载路径
            const downloadPathSetting = await this.db.getSetting('download_path', './downloads');
            const downloadPath = getAbsoluteDownloadPath(downloadPathSetting);
            const fileName = `${song.title} - ${song.artist}.mp3`.replace(/[\\/:*?"<>|]/g, '_');
            const filePath = path.join(downloadPath, fileName);

            // 确保目录存在
            if (!fs.existsSync(downloadPath)) {
                fs.mkdirSync(downloadPath, { recursive: true });
            }

            // 检查文件是否存在
            const fileExists = fs.existsSync(filePath);
            const fileSize = fileExists ? fs.statSync(filePath).size : 0;
            const isValidFile = fileSize > 0;

            if (fileExists && isValidFile && !force) {
                this.logger.debug(SERVICE_MODULE, 'downloadSong', `File exists, skipping`);
                await this._recordDownload(song, subscription, filePath, 'completed');
                return true;
            }

            // 添加下载记录
            await this._recordDownload(song, subscription, filePath, 'pending');

            // 使用API完整数据直接下载
            const downloadResult = await this.downloadService.downloadSong({
                music: song,  // ✅ 完整API数据
                plugin: subscription.platform,
                quality: subscription.download_quality || 'standard',
                filePath,
                reqId: `subscription-${subscription.id}`,
                maxRetries: 3,
                source: `榜单订阅-下载`,
                onProgress: (status) => {
                    if (status === 'downloading') {
                        this._recordDownload(song, subscription, filePath, 'downloading');
                    }
                }
            });

            if (downloadResult.success) {
                await this._recordDownload(song, subscription, downloadResult.filePath || filePath, 'completed');
                this.logger.debug(SERVICE_MODULE, 'downloadSong', `Success`, { title: song.title });
                return true;
            } else {
                await this._recordDownload(song, subscription, filePath, 'failed');
                this.logger.error(SERVICE_MODULE, 'downloadSong', `Failed`, { title: song.title, error: downloadResult.error });
                return false;
            }

        } catch (err) {
            this.logger.error(SERVICE_MODULE, 'downloadSong', `Error`, { title: song.title, error: err.message });
            return false;
        }
    }

    /**
     * 记录下载状态
     */
    async _recordDownload(song, subscription, filePath, status) {
        try {
            const music = {
                id: song.id,
                title: song.title,
                artist: song.artist,
                album: song.album
            };
            await this.db.addDownload(music, subscription.platform, subscription.download_quality || 'standard');
            await this.db.updateDownloadStatus(
                song.id,
                subscription.platform,
                {
                    status: status,
                    filePath: filePath,
                    fileSize: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
                }
            );
        } catch (err) {
            this.logger.warn(SERVICE_MODULE, 'recordDownload', `Failed`, { error: err.message });
        }
    }
}

module.exports = SubscriptionDownloadService;
