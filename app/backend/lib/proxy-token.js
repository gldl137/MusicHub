'use strict';

// ==================== 代理防盗链：无状态短期签名 token ====================
// 设计目标（对标"本地临时签名防盗链"）：
//   1) 前端不再传完整外部 URL，只传本服务签发的 token；
//   2) token 内编码「目标 URL + 过期时间」，并用服务端密钥做 HMAC 签名；
//   3) 服务端校验签名 + 过期时间（fail-closed），过期/篡改直接拒绝；
//   4) 关键安全点：目标 URL 在签发前已通过 guardProxyTarget（SSRF + 域名白名单）校验，
//      且代理接口只认 token、不再接受原始 url 参数，杜绝"前端直传外链"导致的开放代理。
//
// token 形如 `<base64url(payload)>` + '.' + `<base64url(HMAC_SHA256(payload))>`
// payload = { u: 目标URL, exp: 过期Unix秒 }

const crypto = require('crypto');
const logger = require('../core/logger');

// 密钥：生产环境必须配置固定 PROXY_TOKEN_SECRET；未配置时生成本进程随机密钥
// （重启后已签发 token 失效，短时效场景下可接受，但跨实例/重启互通需配置固定值）。
const SECRET = process.env.PROXY_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PROXY_TOKEN_SECRET) {
  logger.warn('PROXY', 'init',
    'PROXY_TOKEN_SECRET 未配置，使用进程内随机密钥（重启后已签发 token 失效）。生产环境请配置固定密钥。');
}

const DEFAULT_TTL = Number(process.env.PROXY_TOKEN_TTL || 300); // 默认 5 分钟
const MAX_TTL = 600; // 上限 10 分钟，防止过长有效期被囤积滥用

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj)));
}
function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

/** 签发 token（同步）。ttl 超过上限会被截断到 MAX_TTL。 */
function createProxyToken(targetUrl, ttl = DEFAULT_TTL) {
  const exp = Math.floor(Date.now() / 1000) + Math.min(Math.max(1, ttl | 0), MAX_TTL);
  const payload = b64urlJson({ u: String(targetUrl), exp });
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * 校验 token。
 * @returns {{ok:boolean, url?:string, error?:string}}
 */
function verifyProxyToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) {
    return { ok: false, error: 'invalid token' };
  }
  const idx = token.indexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  // 恒定时间比较，防时序侧信道
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad signature' };
  }

  let data;
  try {
    data = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch {
    return { ok: false, error: 'bad payload' };
  }
  if (!data || typeof data.u !== 'string') return { ok: false, error: 'bad payload' };
  if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'expired' };
  }
  return { ok: true, url: data.u };
}

module.exports = { createProxyToken, verifyProxyToken, DEFAULT_TTL, MAX_TTL };
