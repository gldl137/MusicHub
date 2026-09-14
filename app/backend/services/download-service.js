/**
 * 统一下载服务
 * 所有下载功能（普通下载、订阅下载）都调用此服务
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveProxyGuard } = require('../rest/proxy-utils');

const SERVICE_MODULE = 'DownloadCore';
// 单次下载字节上限：防「流量放大 / 磁盘写满」类攻击（正常单曲远小于此值）
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// 从插件返回结果中提取 LRC 文本（与 OpenSubsonic 保持一致）
function extractLrcText(result) {
  if (!result) return null;
  if (typeof result === 'string') return result.trim() ? result : null;
  if (typeof result === 'object') {
    for (const k of ['rawLrc', 'lyrics', 'lrc', 'value']) {
      if (typeof result[k] === 'string' && result[k].trim()) return result[k];
    }
    if (result.data) return extractLrcText(result.data);
  }
  return null;
}

// 判断歌词文本是否为占位/无意义内容（如“暂无歌词”“纯音乐”等）
function isPlaceholderLyrics(text) {
  if (!text) return true;
  const content = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*\]/g, '').trim())
    .filter(Boolean)
    .join('')
    .replace(/[\s ]/g, '');
  if (!content) return true; // 全是标签，无实际歌词内容
  const placeholders = new Set([
    '暂无歌词', '暂无', '无歌词', '纯音乐', '纯音乐请欣赏',
    '此歌曲为没有填词的纯音乐', '歌词加载中', '加载歌词失败', '暂无歌词请稍后'
  ]);
  if (placeholders.has(content)) return true;
  if (/^纯音乐[，,]?\s*请欣赏?$/.test(content)) return true;
  return false;
}

class DownloadService {
    constructor(config) {
        this.config = config || {};
        this.logger = config.logger || console;
        this.downloadSettings = config.downloadSettings || {
            quality: 'standard',
            qualityFallback: 'lower'
        };
        this.downloadingSet = new Set();
    }

    /**
     * 下载单首歌曲（带重试机制）
     * @param {Object} options - 下载选项
     * @param {Object} options.music - 歌曲信息 { id, title, artist, album }
     * @param {string} options.plugin - 插件名
     * @param {string} options.quality - 音质
     * @param {string} options.filePath - 文件保存路径
     * @param {string} options.reqId - 请求ID
     * @param {number} options.maxRetries - 最大重试次数
     * @param {Function} options.onProgress - 进度回调
     * @param {Function} options.updateStatus - 状态更新回调
     * @param {string} options.source - 下载来源（用于日志标识）
     * @returns {Promise<Object>} - { success, filePath, error }
     */
    async downloadSong(options) {
        const {
            music,
            plugin,
            quality = 'standard',
            filePath,
            reqId = 'system',
            onProgress = null,
            updateStatus = null,
            source = 'unknown'
        } = options;

        if (!music || !music.id || !plugin || !filePath) {
            return { success: false, error: 'Missing required parameters' };
        }

        let actualFilePath = filePath;

        const userVars = typeof this.config.userVars === 'function'
      ? this.config.userVars()
      : (this.config.userVars || {});
        const fallbackMode = this.downloadSettings.qualityFallback || 'lower';
        const { ResolverCore } = require('../MusicFree/resolver-core');

        // 记录下载开始
        const fileName = path.basename(filePath);
        this.logger.info(SERVICE_MODULE, reqId, `[${source}] START | ${music.title} - ${music.artist || 'Unknown'} | ${fileName}`);

        try {
            if (onProgress) onProgress('resolving', { title: music.title });

            const resolveResult = await ResolverCore.resolve(
                music,
                plugin,
                quality,
                userVars,
                reqId,
                fallbackMode
            );

            if (!resolveResult.success || !resolveResult.data || !resolveResult.data.url) {
                throw new Error(resolveResult.error || 'Failed to resolve URL');
            }

            const url = resolveResult.data.url;
            this.logger.debug(SERVICE_MODULE, reqId, `[${source}] URL | ${url}`);

            // 根据URL的实际格式更新文件路径
            const actualExt = this.getExtensionFromUrl(url);
            const currentExt = path.extname(actualFilePath);
            if (actualExt !== currentExt) {
                actualFilePath = actualFilePath.replace(currentExt, actualExt);
            }

            if (onProgress) onProgress('downloading', { filePath: actualFilePath });
            if (updateStatus) updateStatus({ status: 'downloading', progress: 0 });

            // 执行下载
            await this.downloadFileToServer(url, actualFilePath, music, plugin, (progress) => {
                if (onProgress) onProgress('progress', { progress, title: music.title });
                if (updateStatus && progress % 10 === 0) {
                    updateStatus({ progress });
                }
            }, (totalLength) => {
                // 连接建立后，响应头已告知文件大小，直接写入数据库
                if (updateStatus && totalLength > 0) {
                    updateStatus({ status: 'downloading', progress: 0, fileSize: totalLength });
                }
            });

            // 下载成功
            this.logger.info(SERVICE_MODULE, reqId, `[${source}] SUCCESS | ${music.title} - ${music.artist || 'Unknown'}`);

            // 同时下载歌词（设置开启时）：抓取歌词并写同名 .lrc 到下载目录
            if (this.downloadSettings && this.downloadSettings.downloadLyrics) {
              try {
                const lrc = await this.fetchLyricsForDownload(music, reqId);
                if (lrc) {
                  const lrcPath = actualFilePath.replace(/\.[^.\\/]+$/, '') + '.lrc';
                  fs.writeFileSync(lrcPath, lrc, 'utf8');
                  this.logger.info(SERVICE_MODULE, reqId, `[${source}] LYRICS | wrote ${path.basename(lrcPath)} (${lrc.length} chars)`);
                } else {
                  this.logger.debug(SERVICE_MODULE, reqId, `[${source}] LYRICS | no lyrics found`);
                }
              } catch (lyricErr) {
                this.logger.warn(SERVICE_MODULE, reqId, `[${source}] LYRICS | failed: ${lyricErr.message}`);
              }
            }

            if (onProgress) onProgress('completed', { filePath: actualFilePath, title: music.title });
            if (updateStatus) updateStatus({ status: 'completed', progress: 100 });

            return { success: true, filePath: actualFilePath };

        } catch (error) {
            this.logger.error(SERVICE_MODULE, reqId, `[${source}] FAILED | ${music.title} | ${error.message}`);
            if (onProgress) onProgress('failed', { error: error.message, title: music.title });
            if (updateStatus) updateStatus({ status: 'failed', errorMsg: `${error.message}` });

            return { success: false, error: error.message, filePath: actualFilePath };
        }
    }

    /**
     * 抓词用于「同时下载歌词」：按「歌词搜索插件」配置顺序调用 getLyric，返回 LRC 文本或 null。
     * 与 OpenSubsonic 的 fetchLyricsByPlugin 规则一致：只认 lyric_plugins / lyric_plugin 配置，
     * 未配置则不搜词；占位歌词视为无效继续下一个插件；任何异常都降级返回 null（不影响音频下载结果）。
     */
    async fetchLyricsForDownload(music, reqId) {
        try {
            if (!music || !music.title) return null;
            // 延迟引入 context，避免与 context→download-service 的循环依赖在加载期互相阻塞
            const ctx = require('../lib/context');
            if (!ctx || typeof ctx.runPlugin !== 'function') return null;
            const userVars = (ctx.userConfigs && ctx.userConfigs.default) || {};

            // 读取歌词搜索插件配置（最多 3 个，按设置顺序）
            let plugins = [];
            try {
                const arr = ctx.config.getConfigSetting('lyric_plugins');
                if (Array.isArray(arr)) {
                    plugins = arr.map((p) => String(p).trim()).filter(Boolean).slice(0, 3);
                } else {
                    const legacy = String(ctx.config.getConfigSetting('lyric_plugin') || '').trim();
                    if (legacy) plugins = [legacy];
                }
            } catch { /* 配置读取失败按未配置处理 */ }
            if (!plugins.length) return null;

            const song = { ...music };
            for (const p of plugins) {
                try {
                    const result = await ctx.runPlugin(p, 'getLyric', [song], userVars, ctx.PLUGINS_DIR);
                    const text = extractLrcText(result);
                    if (text && !isPlaceholderLyrics(text)) return text;
                } catch { /* 跳过无 getLyric 或调用失败的插件 */ }
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * 下载文件到服务器
     */
    async downloadFileToServer(url, filePath, music, plugin, onProgress = null, onSize = null) {
        if (this.downloadingSet.has(url)) {
            return;
        }
        this.downloadingSet.add(url);

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const writer = fs.createWriteStream(filePath);
        let lastDataTime = Date.now();
        let downloadedLength = 0;
        let stallTimeout = null;
        let isDownloadStalled = false;
        let response = null;
        const STALL_TIMEOUT = 20000;

        const checkStall = () => {
            if (isDownloadStalled) return;
            const now = Date.now();
            if (now - lastDataTime >= STALL_TIMEOUT) {
                isDownloadStalled = true;
                writer.destroy(new Error(`Download stalled: no progress for ${STALL_TIMEOUT}ms`));
                if (response && response.data) {
                    response.data.destroy();
                }
            } else {
                stallTimeout = setTimeout(checkStall, 1000);
            }
        };

        try {
            let requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            };

            try {
                const urlObj = new URL(url);
                const setHeadersParam = urlObj.searchParams.get('_setHeaders');
                if (setHeadersParam) {
                    const customHeaders = JSON.parse(decodeURIComponent(setHeadersParam));
                    requestHeaders = { ...requestHeaders, ...customHeaders };
                }
            } catch {
                // 没有自定义 headers
            }

            // SSRF 防护 + DNS 固定：下载地址来自解析结果（插件/订阅提供），必须把关，
            // 否则可让服务器向内网/元数据地址发请求。
            const guard = await resolveProxyGuard(url, SERVICE_MODULE);
            if (!guard.safe) {
                throw new Error('Download URL blocked by security policy (SSRF)');
            }

            response = await axios({
                method: 'GET',
                url: url,
                responseType: 'stream',
                timeout: 300000,
                headers: requestHeaders,
                httpAgent: guard.agent,
                httpsAgent: guard.agent
            });

            const totalLength = parseInt(response.headers['content-length'] || 0);
            if (onSize) onSize(totalLength);
            let lastProgress = 0;

            stallTimeout = setTimeout(checkStall, 1000);

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                lastDataTime = Date.now();
                // 防流量放大：超出单次下载上限立即终止并清理
                if (downloadedLength > MAX_DOWNLOAD_BYTES) {
                    response.data.destroy(new Error(`Download exceeds max allowed size (${MAX_DOWNLOAD_BYTES} bytes)`));
                    writer.destroy(new Error(`Download exceeds max allowed size (${MAX_DOWNLOAD_BYTES} bytes)`));
                    return;
                }
                if (totalLength > 0) {
                    const progress = Math.floor((downloadedLength / totalLength) * 100);
                    if (progress >= lastProgress + 10) {
                        lastProgress = progress;
                        if (onProgress) onProgress(progress);
                    }
                }
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    if (stallTimeout) clearTimeout(stallTimeout);
                    this.downloadingSet.delete(url);

                    if (fs.existsSync(filePath)) {
                        const stats = fs.statSync(filePath);
                        if (stats.size > 0) {
                            resolve();
                        } else {
                            fs.unlinkSync(filePath);
                            reject(new Error('Downloaded file is empty'));
                        }
                    } else {
                        reject(new Error('File not found after download'));
                    }
                });

                writer.on('error', (err) => {
                    if (stallTimeout) clearTimeout(stallTimeout);
                    this.downloadingSet.delete(url);
                    this.cleanupFile(filePath);
                    reject(err);
                });

                response.data.on('error', (err) => {
                    if (stallTimeout) clearTimeout(stallTimeout);
                    this.downloadingSet.delete(url);
                    this.cleanupFile(filePath);
                    reject(err);
                });
            });

        } catch (error) {
            if (stallTimeout) clearTimeout(stallTimeout);
            this.downloadingSet.delete(url);
            this.cleanupFile(filePath);
            throw error;
        }
    }

    cleanupFile(filePath) {
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch {
                // 忽略清理错误
            }
        }
    }

    getExtensionFromUrl(url) {
        if (!url) return '.mp3';

        try {
            const urlWithoutParams = url.split('?')[0];
            const pathname = new URL(urlWithoutParams).pathname;
            const ext = path.extname(pathname);
            const validExts = ['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.wma'];
            if (ext && validExts.includes(ext.toLowerCase())) {
                return ext.toLowerCase();
            }
        } catch {
            const match = url.match(/\.(mp3|flac|m4a|wav|aac|ogg|wma)(?:\?|$)/i);
            if (match) {
                return '.' + match[1].toLowerCase();
            }
        }

        return '.mp3';
    }
}

module.exports = DownloadService;
