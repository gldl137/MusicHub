'use strict';

/**
 * 封面补全队列（歌手头像 / 专辑封面）
 *
 * 背景：本地库可能有数百歌手 / 专辑缺封面。若由前端逐卡片即时联网补图（或扫描时同步全量补），
 * 会同时发起大量“下载原图 + sharp 转码 + 写库”，打满 CPU/IO、占住 sqlite，导致请求超时。
 *
 * 设计：
 *  - 全局【单并发闸】：任何时刻只有 1 个抓取/转码任务在跑；
 *  - 待补任务进 FIFO 队列（按 kind+key 去重）；
 *  - 每完成一个任务让出 STEP_DELAY_MS，批次最多 BATCH_MAX 个后暂停数秒再续，
 *    避免持续占用 CPU/DB；
 *  - 失败/未命中按 miss 短窗口跳过，避免反复重试同一个搜不到的对象；
 *  - handlers 由 local-music 注册（ensureArtistCover / ensureRealAlbumCover），本模块无业务依赖。
 */

const logger = require('../core/logger');

const MODULE = 'COVER-FILL-QUEUE';

// kind -> handler，由 local-music 启动时注册
const handlers = { artist: null, album: null };

const queue = [];          // { kind, name, artist }
const inQueue = new Set(); // 去重（已在队列）
const triedAt = new Map(); // key -> ts（未命中/搜索失败的短窗口）
const MISS_RETRY_MS = 24 * 60 * 60 * 1000; // 未命中 24h 内不再重试（跨重启持久化，避免重启整库联网风暴）
const QUEUE_CAP = 2000;    // 单轮入队上限
const BATCH_MAX = 25;      // 每轮 pump 最多执行任务数（之后暂停让 CPU/DB 呼吸）
const PAUSE_BETWEEN_BATCH_MS = 5000; // 批次间暂停
const STEP_DELAY_MS = 350; // 任务间让出时间（限速，保护外部源与本地转码）

let running = false; // 单并发闸：正在执行一个任务

// 跨重启防风暴：宿主注入 load/save，把「未命中时间戳」持久化（进程内存重启即清零，
// 若不持久化，每次重启后库中几百个搜不到的歌手/专辑又会整批重新联网搜索下载）。
let store = { load: null, save: null };
let storeLoaded = false;
let saveTimer = null;

async function ensureStoreLoaded() {
  if (storeLoaded || typeof store.load !== 'function') { storeLoaded = true; return; }
  storeLoaded = true;
  try {
    const saved = await store.load();
    if (saved && typeof saved === 'object') {
      let n = 0;
      for (const [k, ts] of Object.entries(saved)) {
        const t = Number(ts);
        if (t > 0 && !triedAt.has(k)) { triedAt.set(k, t); n++; }
      }
      if (n) logger.debug(MODULE, 'init', 'Persisted cover-fill miss window loaded', { restored: n });
    }
  } catch (e) {
    logger.debug(MODULE, 'init', 'Load persisted miss window failed', { error: e && e.message });
  }
}

/** 节流保存未命中表（避免每次 miss 都触发一次 DB 写） */
function schedulePersist() {
  if (typeof store.save !== 'function' || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snap = {};
    for (const [k, t] of triedAt) snap[k] = t;
    Promise.resolve(store.save(snap)).catch(() => {});
  }, 5000);
}

/** 由宿主注入持久化存取；clearCache 清理歌手头像/封面后宿主可重置，允许立即重试 */
function setStore(next) {
  store = (next && typeof next === 'object') ? next : { load: null, save: null };
}

/** 启动时预热持久化未命中表（fire-and-forget，早于首批入队完成） */
function prime() {
  ensureStoreLoaded();
}

function keyOf(kind, name, artist) {
  return kind + '|' + (artist ? String(artist) + '\u0000' : '') + String(name);
}
function recentOf(kind, name, artist) {
  const k = keyOf(kind, name, artist);
  const t = triedAt.get(k);
  return !!t && (Date.now() - t < MISS_RETRY_MS);
}
function markTried(kind, name, artist) {
  triedAt.set(keyOf(kind, name, artist), Date.now());
  if (triedAt.size > 4000) {
    // 简单清理：清掉最老的约一半
    const sorted = [...triedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < 2000 && sorted[i]; i++) triedAt.delete(sorted[i][0]);
  }
  schedulePersist();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 由 local-music 注册：kind = 'artist' | 'album' */
function register(kind, fn) {
  if (typeof fn === 'function') handlers[kind] = fn;
}

function isHandled(kind) {
  return typeof handlers[kind] === 'function';
}

/** 入队（非阻塞）。已在队列/近期未命中/无 handler 时返回 false；
 * opts.force=true 时忽略未命中窗口（手动补图按钮使用，允许立即重试搜不到的歌手/专辑） */
function enqueue(kind, name, artist, opts) {
  ensureStoreLoaded();
  const force = !!(opts && opts.force);
  if (!isHandled(kind) || !name) return false;
  if (!force && recentOf(kind, name, artist)) return false;
  const k = keyOf(kind, name, artist);
  if (inQueue.has(k)) return true;
  if (queue.length >= QUEUE_CAP) return false;
  queue.push({ kind, name, artist: artist || '' });
  inQueue.add(k);
  pump();
  return true;
}

/** 后台推进：单并发闸，逐任务执行，批次上限 + 暂停 */
async function pump() {
  if (running) return;
  running = true;
  try {
    let done = 0;
    let ok = 0, failed = 0, missed = 0, skipped = 0;
    while (queue.length && done < BATCH_MAX) {
      const task = queue.shift();
      const k = keyOf(task.kind, task.name, task.artist);
      inQueue.delete(k);
      if (!isHandled(task.kind) || recentOf(task.kind, task.name, task.artist)) continue;
      try {
        const res = task.kind === 'artist'
          ? await handlers.artist(task.name)
          : await handlers.album(task.name, task.artist);
        // filled=已补入库；failed=搜到但下载失败；cleared/skipped=未命中或无需补（按 miss 窗口跳过，避免反复试同一个）
        if (String(res || '').includes('filled')) ok++;
        else {
          if (res === 'failed') failed++;
          else if (res === 'skipped') skipped++;
          else missed++;
          markTried(task.kind, task.name, task.artist);
        }
      } catch (e) {
        failed++;
        markTried(task.kind, task.name, task.artist);
        logger.warn(MODULE, 'pump', `${task.kind} fill failed`, { name: task.name, artist: task.artist, error: e && e.message });
      }
      done++;
      await sleep(STEP_DELAY_MS); // 限速让出
    }
    logger.info(MODULE, 'pump', `【下载完毕】批次(${done}项: 歌手头像/专辑封面) 成功:${ok} 失败:${failed} 未搜到:${missed} 跳过:${skipped} 剩余排队:${queue.length}`);
    if (queue.length) {
      await sleep(PAUSE_BETWEEN_BATCH_MS); // 批次间暂停，避免持续占用 CPU/DB
      pump();
    }
  } finally {
    running = false;
  }
}

/**
 * “按需回源兜底”：请求路径上 DB 未命中时调用。
 * 受同一单并发闸约束：闸空闲则立即补这一个（保留“查询到即落库”）；
 * 闸忙或近期未命中则仅入队并返回 false，让调用方返回占位，绝不并发打源。
 * @returns {Promise<boolean>} true=已补到（落库）
 */
async function fetchImmediate(kind, name, artist) {
  if (!isHandled(kind) || !name) return false;
  if (running) {
    enqueue(kind, name, artist);
    return false;
  }
  if (recentOf(kind, name, artist)) return false;
  running = true;
  try {
    const res = kind === 'artist'
      ? await handlers.artist(name)
      : await handlers.album(name, artist);
    if (String(res || '').includes('filled')) return true;
    markTried(kind, name, artist);
    return false;
  } catch (e) {
    markTried(kind, name, artist);
    logger.warn(MODULE, 'immediate', `${kind} fetch failed`, { name, artist, error: e && e.message });
    return false;
  } finally {
    running = false;
    pump();
  }
}

/** 当前是否有任务在抓取（供接口快速判断，可选） */
function isBusy() {
  return running;
}

/** 待处理任务数 */
function pendingCount() {
  return queue.length;
}

module.exports = { register, enqueue, fetchImmediate, isBusy, pendingCount, setStore, prime };
