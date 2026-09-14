'use strict';

/**
 * 落雪（LX）自定义音源 —— 管理（目录 / 配置 / 实例生命周期）
 * ================================================================
 * - 脚本目录：data/plugins/LX/*.js
 * - 启用状态与元信息：config.json 的 lxSources 字段
 * - 运行实例：按需创建 LxSourceInstance 并 init，成功后缓存复用
 *
 * 对外：listSources / addSource / removeSource / setEnabled / getCandidates / testResolve
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const logger = require('../core/logger');
const { DATA_DIR, loadLxSourceConfig, saveLxSourceConfig } = require('../lib/config');
const { LxSourceInstance } = require('./lx-runner');

// 落雪音源脚本统一放在 data/plugins/LX/ 下，与 MusicFree 插件（data/plugins/MF/）分目录存放
const SOURCES_DIR = path.join(DATA_DIR, 'plugins', 'LX');
const MAX_SOURCE_SIZE = 2 * 1024 * 1024; // 单文件上限 2MB

// file -> { file, code, meta, inst, state, error, sources, updateAlert }
const registry = new Map();
let loaded = false;

function ensureDir() {
  if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

/** 文件名安全化：只保留基本字符，避免目录穿越 */
function safeFileName(name, fallback = 'lx-source.js') {
  let n = String(name || '').trim();
  n = n.replace(/[\\/]/g, '_').replace(/\.\./g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_');
  if (!n) n = fallback;
  if (!/\.js$/i.test(n)) n += '.js';
  return n.slice(0, 120);
}

/** 解析脚本头部注释里的元信息（@name/@version/@author/@description/@homepage） */
function parseMeta(code, fallbackName) {
  const head = String(code || '').slice(0, 4000);
  const pick = (tag) => {
    const m = head.match(new RegExp(`@${tag}\\s+([^\\r\\n*]+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    name: pick('name') || fallbackName,
    version: pick('version'),
    author: pick('author'),
    description: pick('description'),
    homepage: pick('homepage'),
  };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  ensureDir();
  let files = [];
  try {
    files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith('.js'));
  } catch { /* 目录不可读 */ }

  for (const file of files) {
    const cfg = loadLxSourceConfig()[file] || {};
    registry.set(file, {
      file,
      code: null,
      meta: { name: cfg.name || file, author: cfg.author || '', version: cfg.version || '', description: cfg.description || '' },
      enabled: cfg.enabled !== false, // 默认启用
      inst: null,
      state: 'idle',
      error: null,
      sources: {},
      updateAlert: null,
    });
  }
  // 启动后异步预热启用的音源（不阻塞主流程）
  for (const [, entry] of registry) {
    if (entry.enabled) warmup(entry);
  }
}

/** 读取脚本内容（带缓存） */
function readCode(entry) {
  if (entry.code != null) return entry.code;
  const p = path.join(SOURCES_DIR, entry.file);
  entry.code = fs.readFileSync(p, 'utf8');
  return entry.code;
}

/** 创建实例并初始化（幂等；失败记录状态，不影响其它音源） */
function warmup(entry) {
  if (!entry || !entry.enabled) return;
  if (entry.state === 'ready' || entry.state === 'loading') return;
  let code;
  try {
    code = readCode(entry);
  } catch (e) {
    entry.state = 'error';
    entry.error = `读取脚本失败：${e.message}`;
    return;
  }
  entry.state = 'loading';
  entry.error = null;
  const meta = { ...entry.meta, ...parseMeta(code, entry.file) };
  entry.meta = meta;

  const inst = new LxSourceInstance({ name: entry.file, code, meta });
  entry.inst = inst;
  inst.init()
    .then(() => {
      if (entry.inst !== inst) { inst.dispose(); return; } // 期间被禁用/替换
      entry.state = 'ready';
      entry.sources = inst.sources;
      entry.updateAlert = inst.updateAlert || null;
      logger.info('LX', 'lx-sources', `音源已就绪：${entry.file}`, { sources: Object.keys(inst.sources) });
    })
    .catch((e) => {
      if (entry.inst !== inst) return;
      entry.state = 'error';
      entry.error = (e && e.message) || String(e);
      entry.sources = {};
      logger.warn('LX', 'lx-sources', `音源初始化失败：${entry.file}`, { error: entry.error });
    });
}

/** 释放实例（禁用/删除时调用） */
function release(entry) {
  if (entry.inst) {
    try { entry.inst.dispose(); } catch { /* ignore */ }
  }
  entry.inst = null;
  entry.state = 'idle';
  entry.sources = {};
  entry.error = null;
}

/**
 * 把磁盘目录同步进内存注册表。
 * 覆盖两种「已安装但列表看不到」的场景：
 *   1) 运行期被手动拷进 data/lx-sources/ 的文件
 *   2) 之前写入失败/进程状态不同步，导致文件在磁盘但不在注册表
 * 同时清理「磁盘上已被删除」的注册项。
 * @returns {{added:string[], removed:string[]}}
 */
function syncFromDisk() {
  ensureDir();
  let files = [];
  try {
    files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith('.js'));
  } catch {
    return { added: [], removed: [] };
  }
  const all = loadLxSourceConfig();
  const added = [];
  for (const file of files) {
    if (registry.has(file)) continue;
    const cfg = all[file] || {};
    const entry = {
      file,
      code: null,
      meta: { name: cfg.name || file, author: cfg.author || '', version: cfg.version || '', description: cfg.description || '' },
      enabled: cfg.enabled !== false,
      inst: null,
      state: 'idle',
      error: null,
      sources: {},
      updateAlert: null,
    };
    registry.set(file, entry);
    added.push(file);
    if (entry.enabled) warmup(entry);
  }
  const removed = [];
  const onDisk = new Set(files);
  for (const file of [...registry.keys()]) {
    if (!onDisk.has(file)) {
      release(registry.get(file));
      registry.delete(file);
      removed.push(file);
    }
  }
  if (added.length || removed.length) {
    logger.info('LX', 'lx-sources', '音源目录已同步', { added, removed });
  }
  return { added, removed };
}

/** 诊断信息：便于定位「音源为什么不显示 / 不可用」 */
function diagnose() {
  ensureLoaded();
  let diskFiles = [];
  try {
    diskFiles = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith('.js'));
  } catch { /* 目录不可读 */ }
  const entries = [...registry.values()];
  return {
    dir: SOURCES_DIR,
    diskFiles,
    registryCount: entries.length,
    readyCount: entries.filter((e) => e.state === 'ready' && e.enabled).length,
    states: entries.map((e) => ({ file: e.file, enabled: e.enabled, state: e.state, error: e.error })),
  };
}

/** 列表（含状态、声明的平台与音质） */
function listSources() {
  ensureLoaded();
  syncFromDisk();
  return [...registry.values()].map((e) => ({
    file: e.file,
    enabled: e.enabled,
    state: e.state,
    error: e.error,
    meta: e.meta,
    sources: e.sources,
    platforms: Object.keys(e.sources || {}),
    updateAlert: e.updateAlert,
  }));
}

/** 读取单个音源（含脚本内容，供查看） */
function getSource(file) {
  ensureLoaded();
  const e = registry.get(file);
  if (!e) return null;
  return {
    file: e.file,
    enabled: e.enabled,
    state: e.state,
    error: e.error,
    meta: e.meta,
    sources: e.sources,
    code: entryCodeSafe(e),
  };
}

function entryCodeSafe(entry) {
  try { return readCode(entry); } catch { return ''; }
}

/**
 * 文件名去重：多个音源可以共存，同名不覆盖。
 * latest.js 已存在 → latest(2).js、latest(3).js …
 * （下载的音源常常都叫 latest.js / index.js，直接覆盖会让用户永远只剩一个音源）
 */
function uniqueFileName(file) {
  const ext = path.extname(file) || '.js';
  const base = file.slice(0, file.length - ext.length);
  let candidate = file;
  let i = 1;
  while (fs.existsSync(path.join(SOURCES_DIR, candidate)) || registry.has(candidate)) {
    i += 1;
    candidate = `${base}(${i})${ext}`;
  }
  return candidate;
}

/**
 * 导入音源
 * 语义：**新增**，不覆盖。可安装多个音源并在列表中并排共存；
 * 文件名冲突时自动另存为 xxx(2).js（下载来源常常都叫 latest.js）。
 * @param {object} opts
 * @param {string} [opts.content] 脚本内容
 * @param {string} [opts.url]     脚本下载地址
 * @param {string} [opts.fileName] 目标文件名
 * @returns {Promise<object>} 新增后的音源信息
 */
async function addSource({ content, url, fileName } = {}) {
  ensureLoaded();
  let code = content;
  if (!code && url) {
    const resp = await axios.get(url, {
      timeout: 20000,
      responseType: 'text',
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36' },
      transformResponse: [(d) => d],
    });
    code = typeof resp.data === 'string' ? resp.data : String(resp.data);
  }
  if (!code || typeof code !== 'string' || !code.trim()) throw new Error('音源内容为空');
  if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_SIZE) throw new Error('音源文件过大（>2MB）');

  // 语法预检：避免导入一个跑不起来的脚本后满屏报错
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    throw new Error('脚本语法错误：' + e.message);
  }

  // 文件命名优先级：显式 fileName > 脚本头部 @name > URL 文件名 > 兜底
  // LX 自定义音源直链普遍叫 latest.js / index.js，若按 URL 命名会让所有音源同名，
  // 故优先采用脚本内声明的 @name（如「野花🌷」），同名时再由 uniqueFileName 加序号去重。
  const metaName = parseMeta(code, '').name;
  let name = fileName || metaName;
  if (!name && url) {
    try {
      const u = new URL(url);
      name = decodeURIComponent(path.posix.basename(u.pathname));
    } catch { /* ignore */ }
  }

  ensureDir();
  const wanted = safeFileName(name || 'lx-source.js');
  const file = uniqueFileName(wanted);
  const renamed = file !== wanted ? file : null;

  fs.writeFileSync(path.join(SOURCES_DIR, file), code, 'utf8');

  const meta = parseMeta(code, file);
  const all = loadLxSourceConfig();
  all[file] = { ...(all[file] || {}), enabled: true, ...meta };
  saveLxSourceConfig(all);

  // 新导入即启用（可多个同时启用），初始化异步进行；失败落到 error 状态，不影响其它音源
  const entry = {
    file,
    code,
    meta,
    enabled: true,
    inst: null,
    state: 'idle',
    error: null,
    sources: {},
    updateAlert: null,
  };
  registry.set(file, entry);
  warmup(entry);

  if (renamed) {
    logger.info('LX', 'lx-sources', `文件名冲突，已另存为新音源：${wanted} → ${file}`);
  }
  logger.info('LX', 'lx-sources', `音源已新增：${file}`, { total: registry.size });
  return { file, renamed, meta, state: entry.state, enabled: entry.enabled, total: registry.size };
}

/** 删除音源（文件 + 配置 + 实例） */
function removeSource(file) {
  ensureLoaded();
  const e = registry.get(file);
  if (!e) throw new Error('音源不存在');
  release(e);
  registry.delete(file);
  try {
    const p = path.join(SOURCES_DIR, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    logger.warn('LX', 'lx-sources', `删除音源文件失败：${file}`, { error: err.message });
  }
  const all = loadLxSourceConfig();
  delete all[file];
  saveLxSourceConfig(all);
  return true;
}

/** 启用/停用 */
function setEnabled(file, enabled) {
  ensureLoaded();
  const e = registry.get(file);
  if (!e) throw new Error('音源不存在');
  e.enabled = !!enabled;
  const all = loadLxSourceConfig();
  all[file] = { ...(all[file] || {}), enabled: e.enabled };
  saveLxSourceConfig(all);
  if (e.enabled) {
    warmup(e);
  } else {
    release(e);
  }
  return { file, enabled: e.enabled };
}

/**
 * 取出可用于指定平台/动作的音源实例（已启用且初始化成功）
 * @param {string} source kw/kg/tx/wy/mg
 * @param {string} action musicUrl
 * @returns {Array<{file:string, inst:LxSourceInstance, qualitys:string[]}>}
 */
function getCandidates(source, action = 'musicUrl') {
  ensureLoaded();
  const out = [];
  for (const [, e] of registry) {
    if (!e.enabled) continue;
    // 还没就绪的顺手催一下（首次调用可能正在加载）
    if (e.state === 'idle') warmup(e);
    if (e.state !== 'ready' || !e.inst) continue;
    if (!e.inst.supports(source, action)) continue;
    out.push({ file: e.file, inst: e.inst, qualitys: e.inst.qualitysOf(source) });
  }
  return out;
}

/** 是否有任何已就绪的音源（用于前端提示） */
function hasReady() {
  ensureLoaded();
  for (const [, e] of registry) if (e.state === 'ready' && e.enabled) return true;
  return false;
}

/** 重新初始化（用于「重试」按钮） */
function reload(file) {
  ensureLoaded();
  const e = registry.get(file);
  if (!e) throw new Error('音源不存在');
  release(e);
  e.code = null; // 丢弃内容缓存，重新从磁盘读
  warmup(e);
  return { file, state: e.state };
}

module.exports = {
  SOURCES_DIR,
  ensureLoaded,
  syncFromDisk,
  diagnose,
  listSources,
  getSource,
  addSource,
  removeSource,
  setEnabled,
  getCandidates,
  hasReady,
  reload,
  parseMeta,
};
