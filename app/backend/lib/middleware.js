// 共享鉴权与请求ID中间件层（从 server.js 抽离）
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const logger = require('../core/logger');

// 会话 Cookie 名称（HttpOnly）：供 <audio>/<img>/hls.js 等无法携带 Authorization 头的
// 同源媒体请求自动携带，从而让代理路由也能鉴权。token 放在 Cookie 里而非 URL 中，
// 可避免被访问日志 / Referer 泄漏。
const SESSION_COOKIE = 'musichub_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 天，与 JWT 有效期一致

// DATA_DIR 与 server.js 保持一致：backend/lib -> 项目根/data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

function createReqId() {
  return 'req_' + randomUUID().slice(0, 8);
}

function generateJWTSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function loadOrGenerateJWTSecret() {
  // 1. 优先从环境变量读取
  if (process.env.JWT_SECRET) {
    logger.info('AUTH', 'system', 'JWT_SECRET loaded from environment variable');
    return process.env.JWT_SECRET;
  }

  // 2. 尝试从文件读取
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      const secret = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
      if (secret) {
        logger.info('AUTH', 'system', 'JWT_SECRET loaded from file');
        return secret;
      }
    }
  } catch (err) {
    logger.warn('AUTH', 'system', 'Failed to read JWT_SECRET from file', { error: err.message });
  }

  // 3. 自动生成新的密钥
  const newSecret = generateJWTSecret();
  try {
    fs.writeFileSync(JWT_SECRET_FILE, newSecret, 'utf8');
    // 设置文件权限为只读（仅所有者可读写）
    try {
      fs.chmodSync(JWT_SECRET_FILE, 0o600);
    } catch {
      // Windows 可能不支持 chmod，忽略错误
    }
    logger.warn('AUTH', 'system', '========================================');
    logger.warn('AUTH', 'system', 'JWT_SECRET auto-generated for first run');
    logger.warn('AUTH', 'system', `Secret file: ${JWT_SECRET_FILE}`);
    logger.warn('AUTH', 'system', 'To use a custom secret, set JWT_SECRET environment variable');
    logger.warn('AUTH', 'system', '========================================');
    return newSecret;
  } catch (err) {
    logger.error('AUTH', 'system', 'Failed to save auto-generated JWT_SECRET', { error: err.message });
    // 如果无法保存到文件，生成临时密钥（每次启动会变化，用户需要重新登录）
    logger.warn('AUTH', 'system', 'Using temporary JWT_SECRET (will change on restart)');
    return newSecret;
  }
}

const JWT_SECRET = loadOrGenerateJWTSecret();

// 生成 JWT Token
function generateToken(user) {
  const payload = {
    userId: user.id,
    username: user.username,
    role: user.role,
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7天
  };
  // 简单的 JWT 实现（实际生产环境应使用 jsonwebtoken 库）
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payloadEncoded}`).digest('base64url');
  return `${header}.${payloadEncoded}.${signature}`;
}

// 验证 JWT Token
function verifyToken(token) {
  try {
    const [header, payload, signature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    if (signature !== expectedSignature) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (decoded.exp < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

// 解析 Cookie 头（项目未启用 cookie-parser，这里手动解析即可满足会话 Cookie 需求）
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// 从请求中提取 JWT：优先 Authorization 头（前端 API 调用），其次会话 Cookie（媒体/代理请求）
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
  return null;
}

// 认证中间件
function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: '未登录' });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: '登录已过期' });
  }
  req.user = decoded;
  next();
}

// 管理员权限中间件
function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: '没有权限' });
  }
  next();
}

module.exports = {
  createReqId, generateToken, verifyToken, authMiddleware, adminMiddleware,
  SESSION_COOKIE, SESSION_MAX_AGE
};
