'use strict';

/**
 * 明文密码持久化缓存（仅用于 OpenSubsonic 的 token 鉴权）。
 *
 * 背景：本项目用户密码以 bcrypt 哈希存储，无法直接校验 Subsonic 的
 * t = md5(password + salt) token 鉴权，因此需缓存明文密码：
 *   - OpenSubsonic 使用 p（明文）鉴权成功后自动写入；
 *   - Web 前端登录成功（routes/auth.js）也会写入；
 *   - 之后该用户的 t+s token 鉴权即可通过。
 *
 * 缓存持久化到 data/opensubsonic-passwords.json，重启后仍可校验 token，
 * 无需客户端重新设置密码。文件权限限制为仅属主可读写（0600）。
 * 密码变更（routes/auth.js set()）会覆盖旧值；已删除用户的残留条目无副作用
 * （token 鉴权前会先校验用户是否存在）。
 *
 * 安全加固：
 *   - 按用户名隔离，天然有上限（每用户一条），不会无限增长；
 *   - 可选 TTL（OPENSUBSONIC_PLAINTEXT_TTL 秒，默认 0=不过期）：到期自动失效，
 *     缩短明文密码在内存/磁盘上的驻留窗口，到期后客户端需重新用明文密码登录。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'opensubsonic-passwords.json');

// 明文密码驻留上限（秒）。0 = 永不过期（保持原有行为）。
const TTL = parseInt(process.env.OPENSUBSONIC_PLAINTEXT_TTL, 10) || 0;

const cache = new Map(); // username -> { pw, ts }

// 启动时加载持久化缓存（文件损坏/不可读时忽略，等待下一次明文鉴权重建）
try {
  if (fs.existsSync(CACHE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        // 兼容旧格式（纯字符串）与新格式（{pw,ts}）
        if (typeof v === 'string' && v) cache.set(k, { pw: v, ts: 0 });
        else if (v && typeof v.pw === 'string' && v.pw) cache.set(k, { pw: v.pw, ts: v.ts || 0 });
      }
    }
  }
} catch {
  /* ignore */
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(
      [...cache.entries()].map(([k, v]) => [k, { pw: v.pw, ts: v.ts }])
    );
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), { mode: 0o600 });
    try { fs.chmodSync(CACHE_FILE, 0o600); } catch { /* Windows 下权限位被忽略 */ }
  } catch {
    // 持久化失败不影响内存缓存工作
  }
}

function set(username, password) {
  if (username && password) {
    cache.set(username, { pw: password, ts: Date.now() });
    persist();
  }
}

function get(username) {
  const e = cache.get(username);
  if (!e) return null;
  if (TTL > 0 && Date.now() - e.ts > TTL * 1000) {
    cache.delete(username);
    persist();
    return null;
  }
  return e.pw;
}

function remove(username) {
  if (cache.delete(username)) persist();
}

function has(username) {
  return cache.has(username);
}

module.exports = { set, get, remove, has };
