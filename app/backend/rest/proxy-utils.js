'use strict';

// ==================== 音频/图片代理通用工具（纯 JS，不依赖数据库/sqlite3） ====================
// 供 routes/proxy.js 与 OpenSubsonic（rest/opensubsonic.js）网络歌曲播放复用。
// 注意：本模块禁止 require 任何依赖 sqlite3/context 的模块，保持可独立加载（冒烟测试用）。

const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('../core/logger');
const proxyDns = require('dns').promises;

// 从 IPv4 映射地址（::ffff:127.0.0.1 或 ::ffff:7f00:1）中提取点分十进制 IPv4
function extractIpv4FromMapped(ipv6) {
  const rest = ipv6.slice('::ffff:'.length);
  if (rest.includes('.')) return rest; // 已经是点分十进制
  const groups = rest.split(':').filter(Boolean);
  if (groups.length === 2) {
    try {
      const bytes = groups.flatMap((g) => {
        const n = parseInt(g, 16);
        return [(n >> 8) & 0xff, n & 0xff];
      });
      if (bytes.length === 4) return bytes.join('.');
    } catch { /* ignore */ }
  }
  return null;
}

// 判断 IP 是否为私有/回环/链路本地/元数据地址（含 IPv4 映射地址 ::ffff:x.x.x.x）
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1); // 去掉 IPv6 方括号
  if (ip.startsWith('::ffff:')) {
    const v4 = extractIpv4FromMapped(ip);
    if (v4) return isPrivateIp(v4);
    return true; // 无法解析的映射地址，按私有拒绝（fail closed）
  }
  if (ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.') || ip.startsWith('100.64.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

// 域名白名单（可选项，在已有「内网/协议拦截」之上再叠加一层 allowlist）。
// 配置方式：环境变量 PROXY_ALLOW_HOSTS=cnr.cn,example.com（逗号分隔，支持后缀匹配，
// 如配置 cnr.cn 即允许 ngcdn001.cnr.cn 等所有子域）。
// 未配置时返回 true（不限制），仅依赖下方内网/协议拦截，保持向后兼容。
const PROXY_ALLOW_HOSTS = (process.env.PROXY_ALLOW_HOSTS || '')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

function isHostAllowed(host) {
  if (PROXY_ALLOW_HOSTS.length === 0) return true;
  return PROXY_ALLOW_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

/**
 * 解析并校验代理目标 URL（SSRF 防护，fail-closed）。
 * 同时返回已校验的 IP 与地址族，供调用方把 DNS 固定到该 IP，
 * 防止「校验通过后 → 实际请求前」的 DNS 重绑定（TOCTOU）绕过。
 * @returns {Promise<{safe:boolean, ip?:string, family?:number, parsed?:URL}>}
 */
async function guardProxyTarget(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { safe: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false };
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量带方括号，先归一化
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal') ||
    host.endsWith('.svc') || host.endsWith('.metadata') ||
    host === 'metadata.google.internal'
  ) {
    return { safe: false };
  }

  // 域名白名单：已配置 PROXY_ALLOW_HOSTS 时，仅放行白名单内（含子域）主机
  if (!isHostAllowed(host)) {
    return { safe: false };
  }

  let ip = host;
  let family = 4;
  const isDottedIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  if (host.includes(':') && !isDottedIpv4) {
    family = 6; // IPv6 字面量（含 ::ffff: 映射），无需 DNS 解析
  }
  // 域名：解析一次并据此判定；解析失败直接拒绝（fail closed）
  if (!isDottedIpv4 && !host.includes(':')) {
    try {
      const result = await proxyDns.lookup(host);
      ip = result.address;
      family = result.family || 4;
    } catch {
      return { safe: false };
    }
  }
  if (isPrivateIp(ip)) {
    return { safe: false };
  }
  return { safe: true, ip, family, parsed };
}

// 仅做布尔判断的兼容包装（路由层快速拦截用）
async function isUnsafeProxyUrl(targetUrl) {
  const r = await guardProxyTarget(targetUrl);
  return !r.safe;
}

// 统一出站守卫：在校验通过后返回把 DNS 固定到已校验 IP 的 agent，
// 供「插件安装/更新 / 下载服务 / 封面代理」等所有后端代发外部请求的地方复用，
// 既能复用 SSRF 校验（guardProxyTarget 已含内网/协议/白名单），又消除 DNS 重绑定（TOCTOU）窗口。
// @returns {Promise<{safe:boolean, agent?:object, parsed?:URL, ip?:string, family?:number}>}
async function resolveProxyGuard(targetUrl, reqId = '') {
  const guard = await guardProxyTarget(targetUrl);
  if (!guard.safe) {
    logger.warn('SSRF', reqId, 'Blocked outbound request to disallowed URL', { url: String(targetUrl).substring(0, 120) });
    return { safe: false };
  }
  const agent = pinnedAgent(guard.ip, guard.family, guard.parsed.protocol);
  return { safe: true, agent, parsed: guard.parsed, ip: guard.ip, family: guard.family };
}

// 构造把 DNS 固定到已校验 IP 的 agent，杜绝 DNS 重绑定
function pinnedAgent(ip, family, protocol) {
  // 兼容两种 lookup 调用约定：
  // - 传统：cb(null, address, family)
  // - Node 20+ 默认启用 Happy Eyeballs(autoSelectFamily)，会以 { all: true } 调用并
  //   期望回传地址数组；若仍按旧约定回传字符串，Node 会把字符串逐字符拆开当作地址列表，
  //   导致 "Invalid IP address: undefined"。故 all 为真时返回数组。
  const lookup = (hostname, options, cb) => {
    const entry = { address: ip, family };
    if (options && options.all) {
      return cb(null, [entry]);
    }
    return cb(null, entry.address, entry.family);
  };
  const Agent = protocol === 'https:' ? https.Agent : http.Agent;
  // 不校验上游 TLS 证书（rejectUnauthorized=false）：兼容内网自签证书的 OpenList/插件源等
  // 私有部署场景。代价是放弃对上游的证书校验（存在 MITM 风险），仅建议在内网/可信网络使用。
  return new Agent({ lookup, rejectUnauthorized: false });
}

/**
 * 音频流代理核心（供 /api/proxy/audio 与 OpenSubsonic stream 网络播放复用）。
 * 转发 Range 请求头，透传上游状态/Content-Type/Content-Range 等，流式返回。
 * @param {object} req
 * @param {object} res
 * @param {string} url - 目标音频 URL（已剥离 _setHeaders）
 * @param {string|object} [setHeaders] - 需要附加的请求头（_setHeaders 原始值或已解析对象）
 * @param {string} [reqId]
 * @param {number} [maxBytes] - 可选：单次响应最大字节数，超出即中止（防流量放大）
 */
async function proxyAudioStream(req, res, url, setHeaders, reqId, maxBytes, silent) {
  try {
    let headers = {};
    if (setHeaders) {
      if (typeof setHeaders === 'string') {
        try { headers = JSON.parse(decodeURIComponent(setHeaders)); } catch { /* Ignore */ }
      } else if (typeof setHeaders === 'object') {
        headers = setHeaders;
      }
    }

    // SSRF 防护 + DNS 固定（防重绑定）：任何入口（/api/proxy/audio 或 OpenSubsonic stream）都先校验
    const guard = await guardProxyTarget(url);
    if (!guard.safe) {
      logger.warn('API', reqId, `Audio proxy blocked unsafe URL`, { url: String(url).substring(0, 60) });
      return res.status(400).json({ error: 'Disallowed or invalid URL' });
    }
    const agent = pinnedAgent(guard.ip, guard.family, guard.parsed.protocol);

    const rangeHeader = req.headers && req.headers['range'];
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
    }

    const response = await axios({
      method: 'get',
      url: url,
      headers: headers,
      httpAgent: agent,
      httpsAgent: agent,
      responseType: 'stream',
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 300 || status === 206
    });

    // 电台/直播 HLS 分片高频转发时不逐条记录成功日志（silent=true），避免刷屏；
    // 错误与拦截仍由上层 warn/error 单独记录。普通点歌/OpenSubsonic 代理保持原样。
    if (!silent) {
      logger.debug('API', reqId, `Audio proxy success`, { status: response.status, contentType: response.headers['content-type'] });
    }

    res.status(response.status);

    const contentType = response.headers['content-type'];
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const contentLength = response.headers['content-length'];
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const acceptRanges = response.headers['accept-ranges'];
    if (acceptRanges) {
      res.setHeader('Accept-Ranges', acceptRanges);
    } else if (response.status === 206) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    const contentRange = response.headers['content-range'];
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    if (response.status === 200 && rangeHeader) {
      const totalLength = response.headers['content-length'];
      if (totalLength) {
        const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]);
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : parseInt(totalLength) - 1;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${totalLength}`);
          res.setHeader('Content-Length', (end - start + 1).toString());
          res.status(206);
        }
      }
    }

    // 防流量放大：若指定 maxBytes，边流边计数，超限立即销毁上游并关闭响应
    if (maxBytes && Number.isFinite(maxBytes)) {
      let total = 0;
      let capped = false;
      response.data.on('data', (chunk) => {
        if (capped) return;
        total += chunk.length;
        if (total > maxBytes) {
          capped = true;
          logger.warn('API', reqId, `Audio proxy payload exceeded maxBytes, aborted`, { url: String(url).substring(0, 60) });
          try { response.data.destroy(); } catch { /* ignore */ }
          try { res.end(); } catch { /* ignore */ }
        }
      });
    }

    response.data.pipe(res);
  } catch (error) {
    logger.error('API', reqId, `Audio proxy error`, { error: error.message });
    res.status(500).json({ error: 'Failed to proxy audio', message: error.message });
  }
}

/**
 * 按图片 URL 域名推断防盗链 Referer（供封面代理下载使用）。
 * 酷狗/酷我/咪咕/QQ/网易等图床对 Referer 有校验：直连或只带图片 CDN 自身 origin 会被 403，
 * 必须带各自主站域名 Referer 才能取到图。与 opensubsonic.getCoverArt 的封面代理逻辑保持一致，
 * 避免「排行榜/热门歌单/LX 专区」的歌单封面因缺正确 Referer 而全部 403 空白。
 * @param {string} url
 * @returns {string|null}
 */
function refererForUrl(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('kuwo')) return 'https://www.kuwo.cn/';
  if (u.includes('kugou')) return 'https://www.kugou.com/';
  if (u.includes('y.qq') || u.includes('yqq') || u.includes('qq.com')) return 'https://y.qq.com/';
  if (u.includes('163') || u.includes('music.126') || u.includes('netease')) return 'https://music.163.com/';
  if (u.includes('migu') || u.includes('咪咕') || u.includes('music.migu')) return 'https://music.migu.cn/';
  if (u.includes('douyin') || u.includes('douyinmusic') || u.includes('douban')) return 'https://music.douyin.com/';
  if (u.includes('bilibili') || u.includes('bili') || u.includes('bilisound')) return 'https://www.bilibili.com/';
  return null;
}

module.exports = { isPrivateIp, isUnsafeProxyUrl, guardProxyTarget, pinnedAgent, resolveProxyGuard, proxyAudioStream, refererForUrl };
