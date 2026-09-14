'use strict';

/**
 * 零依赖 HTTP 响应压缩中间件（gzip，基于 Node 内置 zlib）。
 *
 * 背景：OpenSubsonic 客户端（Amcfy 等）进入页面会重新拉取全量列表
 * （getIndexes / getArtists / search3 空查询 / getAlbumList2 / getPlaylists），
 * 响应都是 JSON/XML 明文，库大时单次数 MB，且重复拉取频繁。
 * 文本类响应 gzip 后通常只剩 10%~20%，带宽与客户端解析耗时都会明显下降。
 *
 * 设计要点：
 * 1. 只压缩文本类响应（json/xml/js/css/html...），音频流与图片本身已是压缩格式，跳过；
 * 2. 小于 MIN_COMPRESS_BYTES 不压缩（压缩收益不抵 CPU 开销）；
 * 3. 绕过 res.send 直接发送时自行补 ETag 与 Content-Length，保证 304 协商仍可用
 *    （Express 的 ETag 是在 res.send 内部生成的，直接 res.end 会丢失，故这里自己算）；
 * 4. 任何异常都回落原生 res.send，绝不影响正常响应。
 *
 * 可通过环境变量关闭：GZIP_ENABLED=false
 */

const zlib = require('zlib');

// 小于该字节数不压缩
const MIN_COMPRESS_BYTES = Number(process.env.GZIP_MIN_BYTES || 1024);
// 大于该字节数不压缩（避免大包同步 gzip 长时间占用事件循环）
const MAX_COMPRESS_BYTES = Number(process.env.GZIP_MAX_BYTES || 8 * 1024 * 1024);

// 已知不需要压缩的路径（音频/视频流、下载、封面）
const SKIP_PATH_PREFIXES = [
  '/rest/stream',
  '/rest/download',
  '/downloads/',
  '/api/local-files/stream',
  '/api/proxy/audio',
  '/api/music/cover'
];
const SKIP_PATH_RE = /^\/rest\/(stream|download|getcoverart)$/i;

function shouldSkip(req) {
  const raw = req.originalUrl || req.url || '';
  const pathname = String(raw).split('?')[0].toLowerCase();
  if (SKIP_PATH_RE.test(pathname)) return true;
  return SKIP_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 只压缩文本类响应 */
function isCompressibleContentType(res) {
  const type = String(res.getHeader('Content-Type') || '').toLowerCase();
  if (!type) return true;
  return /json|xml|javascript|css|html|svg|text\//.test(type);
}

/** 弱 ETag（与 Express 一致的 W/"length-crc" 形态，基于未压缩内容计算） */
function weakEtag(buf) {
  const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(buf) : buf.length;
  return `W/"${buf.length.toString(16)}-${(crc >>> 0).toString(16)}"`;
}

/** 追加 Vary: Accept-Encoding（已有 Vary 时合并） */
function appendVary(res) {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', 'Accept-Encoding');
    return;
  }
  const value = String(existing);
  if (!/accept-encoding/i.test(value)) res.setHeader('Vary', `${value}, Accept-Encoding`);
}

function gzipResponseMiddleware(req, res, next) {
  if (process.env.GZIP_ENABLED === 'false') return next();

  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/i.test(acceptEncoding)) return next();
  // HEAD 无响应体；流媒体/下载路径不压缩
  if (req.method === 'HEAD' || shouldSkip(req)) return next();

  try {
    appendVary(res);
  } catch { /* 头设置失败不影响响应 */ }

  const origSend = res.send;
  let handled = false;

  res.send = function (body) {
    if (handled) return origSend.call(this, body);
    handled = true;
    try {
      if (this.headersSent) return origSend.call(this, body);
      if (this.getHeader('Content-Encoding')) return origSend.call(this, body);
      if (!isCompressibleContentType(this)) return origSend.call(this, body);

      let buf = null;
      if (Buffer.isBuffer(body)) buf = body;
      else if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
      if (!buf) return origSend.call(this, body);
      if (buf.length < MIN_COMPRESS_BYTES || buf.length > MAX_COMPRESS_BYTES) {
        return origSend.call(this, body);
      }

      const etag = weakEtag(buf);
      this.setHeader('ETag', etag);
      // 内容未变化：直接 304，省掉整包传输（列表接口重复拉取收益最大）
      if (req.headers['if-none-match'] === etag) {
        this.removeHeader('Content-Type');
        this.removeHeader('Content-Length');
        return this.status(304).end();
      }

      const gz = zlib.gzipSync(buf, { level: 6 });
      if (gz.length >= buf.length) return origSend.call(this, body);

      this.setHeader('Content-Encoding', 'gzip');
      this.setHeader('Content-Length', String(gz.length));
      return this.end(gz);
    } catch {
      return origSend.call(this, body);
    }
  };

  next();
}

module.exports = { gzipResponseMiddleware, weakEtag, shouldSkip };
