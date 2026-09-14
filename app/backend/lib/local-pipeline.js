'use strict';

/**
 * 本地歌曲元数据补全流水线（Step1-Step8，单曲内部严格串行）
 *
 * 核心约束：
 *  1. 只补缺失：每步执行前先校验目标字段，已有有效值直接跳过，绝不覆盖已有数据。
 *  2. 单曲内部 Step1-8 严格串行；多曲之间全局并发上限 3（防插件并发过高导致连接失效）。
 *  3. 四类触发：monitor(自动入库) / manual(手动扫描) / fill(手动补全) / play(播放触发补缺失)。
 *  4. 图片按原图 MD5 全局去重：单曲与专辑共用 cache/cover/，歌手头像 cache/art/；
 *     磁盘已存在同名 MD5 文件直接复用，不重复下载转码。
 *  5. 每一步打印起止日志，并输出「使用的插件列表 + 命中的插件」。
 *
 * 步骤职责：
 *  Step1 文件元数据入库（专辑名缺失时用插件按 歌名+歌手 补全）
 *  Step1.5 时长补录（时长缺失时用插件按 歌名+歌手 搜到真实时长，strm 文件主要靠此步骤获得时长）
 *  Step2 单曲封面（有内嵌封面则跳过；否则 歌名+歌手 搜索，cover_plugins）
 *  Step3 专辑封面（严格 歌手+专辑名 搜 type='album'，无结果留空，绝不拿单曲封面冒充）
 *  Step4 歌手头像（仅歌手名，artist_image_plugins）
 *  Step5 歌词（有内嵌歌词则跳过；否则 歌名+歌手，lyric_plugins）
 *  Step6 图片下载/转码/MD5 去重（投递图片下载队列，成功后回写且仅填空）
 *  Step7 歌词持久化（仅 NULL 时写入）
 *  Step8 完成标记
 */

const localLibraryDb = require('./local-library-db');
const lrcUtils = require('./lrc-utils');
const {
  searchAlbumName,
  searchMissingMeta,
  searchTrackCover,
  searchAlbumCoverByAlbum,
  searchArtistAvatar,
  searchSongLyrics,
  downloadAndBind,
  searchTrackDuration
} = require('./local-enrich');
const logger = require('../core/logger');
const { getConfigSetting } = require('./config');

// 元数据占位值（视为空）：与 local-library-db / local-music 阶段0 判定保持一致
const PLACEHOLDER_ARTIST = new Set(['未知艺术家', '未知歌手', '未知']);
const PLACEHOLDER_ALBUM = new Set(['未知专辑', '未知']);

const MODULE = 'LOCAL-PIPELINE';

// 触发来源标签（日志 + 前端详情展示）
const TRIGGER_LABEL = {
  monitor: '[自动入库-monitor]',
  manual: '[手动扫描]',
  fill: '[手动补全]',
  play: '[播放触发补缺失]'
};
function tagOf(trigger) {
  return TRIGGER_LABEL[trigger] || '[未知来源]';
}

// 全局并发上限
const MAX_CONC = 3;
// 看门狗上限：整轮流水线最多等待这么久，避免任何意外死锁/插件事件循环阻塞永久挂起调用方
const RUN_WATCHDOG_MS = 20 * 60 * 1000;
// 停滞看门狗：流水线超过该时长无任何「任务完成 / 取页」进展即判定卡死，强制清理运行时状态，
// 避免某环节异常挂起导致 isRunning() 永远为真、后续 monitor 永久被挡。
const PIPELINE_STALL_MS = 3 * 60 * 1000;

// ---------------- 进度状态（前端环形 UI / 详情弹窗）----------------
const status = {
  state: 'IDLE',        // IDLE | RUNNING | ABORTED
  trigger: null,
  triggerLabel: '',
  currentSong: '',
  currentStep: '',
  done: 0,
  total: 0,
  failed: 0,
  queued: 0,
  percent: 0,
  message: '',
  updatedAt: 0
};

let aborted = false;
const queue = [];              // { row, trigger, only, playKey }
const queuedKeys = new Set();  // 非播放触发的去重（rel_path）
let active = 0;
let draining = false;

// 专属「编排锁」：标记是否已有一次编排运行（runMetaStages 调用）在进行中。
// 与「在途任务数 active / 队列 queue / 分页 feeder」解耦——即使某首歌的 step1-8 网络请求
// 真挂死（active 卡 >0），只要本次编排运行结束就会把它置回 false，后续 monitor 不会再被永久挡住。
// 入口守卫只看它，finally 兜底释放，保证 100% 复位。
let pipelineRunning = false;
// 运行期间又有 monitor 变更到达 → 标记待补跑；本轮 finally 结束后延时再跑一次，避免丢变更事件。
let pendingMonitorRerun = false;
// monitor 本轮扫描到的「新增」歌曲 rel_path 集合：运行时自动入库仅处理这些，
// 不把历史遗留的 raw_parsed backlog 一并处理（历史由开机增量/手动扫描负责）。
// 运行期间又有变更到达被挡时，累积进此集合，使补跑只覆盖「本轮新增 + 期间到达」。
let lastMonitorChangedRelPaths = [];

// 分页流式取待处理（风险1）：feeder 每批只取一小页，避免一次性把全库 3000 首全载进内存队列。
// 内存中始终只保留「当前页 + 正在跑的 3 首」，中途停止时只需释放这一小批。
let feeder = null;             // async () => rows[] （下一页；空数组表示已取完）
let feederDone = false;
let currentOnly = 'all';       // 当前扫描的 only 模式（仅填空判定用）
let currentOverwrite = false;  // 仅手动元数据补全（only='meta'）时为 true：允许插件完整覆盖现有元数据
let currentRunTrigger = 'manual'; // 本轮运行的真实 trigger（beginRun 时锁定），供 step 日志兜底，避免标签丢失成「[未知来源]」
let lastProgressAt = Date.now();   // 最近一次「任务完成 / 取页」时间戳，停滞看门狗据此判定是否卡死

// 单首 step 明细日志总开关（默认关闭，避免 3000 首存量扫描时日志刷屏）。
// true=输出每首 step1-8 明细（调试用）；false=只保留汇总/异常日志。
// 可通过 config.verbose_scan_log 或 setVerboseScanLog() 开启。
let verboseScanLog = false;
try {
  const _cfg = require('./config');
  const _v = _cfg.getConfigSetting('verbose_scan_log', false);
  verboseScanLog = _v === true || _v === 'true' || _v === 1;
} catch (_e) { /* 配置不可用则保持默认 false */ }
// 日志空操作对象：verboseScanLog=false 时逐首 step 日志走它，零输出。
const LOG_NOOP = { info() {}, warn() {}, debug() {}, error() {}, trace() {} };

/** 运行时开启/关闭单首 step 明细日志（调试用）。on=true 输出每首 step1-8 明细；默认 false 仅保留汇总/异常。 */
function setVerboseScanLog(on) {
  verboseScanLog = !!on;
}
const PAGE_SIZE = 20;          // 每页预取数量

// 播放触发限流（风险3）：同一首 60s 内只提交一次；播放触发队列最多保留 5 个任务，
// 防止快速切歌把队列塞满。高优先级（插到队头），但仍受并发 3 与上限 5 约束。
const PLAY_DEDUPE_MS = 60 * 1000;
const PLAY_MAX = 5;
const playPending = new Set();   // 正在排队/处理的播放触发歌曲 rel_path
const playEnqueueAt = new Map(); // rel_path -> 最近提交时间戳（60s 去重）

function getStatus() {
  return { ...status };
}

function isRunning() {
  // 编排锁视角：是否有一次编排运行在进行中。与在途任务(可能卡死的僵尸)解耦，
  // 这样即便某首歌的网络请求挂死(active 卡 >0)，本轮编排结束置 false 后，后续触发也能正常进入。
  return pipelineRunning;
}

function requestAbort() {
  aborted = true;
  pipelineRunning = false;
  queue.length = 0;
  queuedKeys.clear();
  feeder = null;
  feederDone = true;
  playPending.clear();
  playEnqueueAt.clear();
  status.state = 'ABORTED';
  status.queued = 0;
  status.message = '用户已停止任务（队列已清空）';
  status.updatedAt = Date.now();
  logger.info(MODULE, 'queue', '收到停止指令：队列已清空，进行中的歌曲在当前步骤结束后退出');
  return true;
}

function setIdle() {
  status.state = 'IDLE';
  status.trigger = null;
  status.triggerLabel = '';
  status.currentSong = '';
  status.currentStep = '';
  status.done = 0;
  status.total = 0;
  status.failed = 0;
  status.queued = 0;
  status.percent = 0;
  status.message = '';
  status.updatedAt = Date.now();
}

/** 阶段0（本地解析）进度由扫描侧上报 */
function reportStage0(done, total) {
  status.message = `本地解析 ${done}/${total}`;
  status.updatedAt = Date.now();
  if (done === 1) logger.info(MODULE, 'stage0', '阶段0：本地解析（读取文件/标签）', { total });
}

// ---------------- 任务队列（并发上限 3）----------------
function beginRun(trigger) {
  aborted = false;
  pipelineRunning = true;
  status.state = 'RUNNING';
  status.trigger = trigger;
  currentRunTrigger = trigger || 'manual';
  status.triggerLabel = tagOf(trigger);
  status.updatedAt = Date.now();
}

/** 单曲入队（播放触发用 highPriority 插队）。
 *  - 播放触发(trigger='play')：内置 60s 去重 + 队列上限 5（风险3），不计入总进度 total。
 *  - 其他触发：原 rel_path 去重逻辑。 */
function enqueueSong(row, trigger, highPriority) {
  if (!row) return false;
  const key = String(row.rel_path || row.id || '');
  if (!key) return false;
  if (trigger === 'play') {
    const now = Date.now();
    if (playEnqueueAt.has(key) && now - playEnqueueAt.get(key) < PLAY_DEDUPE_MS) {
      logger.debug(MODULE, 'play', '播放触发去重：60s 内已提交过，跳过', { key });
      return false;
    }
    if (playPending.size >= PLAY_MAX) {
      logger.warn(MODULE, 'play', '播放触发队列已满（最多 5），丢弃本次请求', { key });
      return false;
    }
    playEnqueueAt.set(key, now);
    playPending.add(key);
    // 播放触发语义固定为「补缺失」（封面/头像/歌词全跑）：
    // 不继承 currentOnly/currentOverwrite（残留自上一轮手动补全），否则播放补缺失可能被降级成
    // only='meta'（跳过封面/歌词）甚至 overwrite=true（用插件结果覆盖元数据）。
    if (highPriority) queue.unshift({ row, trigger, only: 'all', overwrite: false, playKey: key });
    else queue.push({ row, trigger, only: 'all', overwrite: false, playKey: key });
    status.queued = queue.length;
    status.updatedAt = Date.now();
    drain();
    return true;
  }
  // 非播放触发：rel_path 去重
  if (queuedKeys.has(key)) return false;
  queuedKeys.add(key);
  if (highPriority) queue.unshift({ row, trigger, only: currentOnly, playKey: null });
  else queue.push({ row, trigger, only: currentOnly, playKey: null });
  status.total += 1;
  status.queued = queue.length;
  status.updatedAt = Date.now();
  drain();
  return true;
}

/** 批量入队（已入队的自动去重）；供直接批量提交使用（非分页路径） */
function enqueueSongs(rows, trigger) {
  let added = 0;
  for (const row of rows || []) {
    const key = String((row && (row.rel_path || row.id)) || '');
    if (!key || queuedKeys.has(key)) continue;
    queuedKeys.add(key);
    queue.push({ row, trigger, only: currentOnly, playKey: null });
    added += 1;
  }
  if (added) {
    status.total += added;
    status.queued = queue.length;
    status.updatedAt = Date.now();
    logger.info(MODULE, 'queue', `${tagOf(trigger)} 入队 ${added} 首（队列排队 ${queue.length}，并发上限 ${MAX_CONC}）`);
    drain();
  }
  return added;
}

/**
 * 调度泵：始终保持最多 MAX_CONC 个任务在跑。
 * 同时实现「分页流式取待处理」（风险1）：当内存队列偏低且 feeder 未取完时，异步预取下一页，
 * 保证内存中始终只保留一小批（当前页 + 正在跑的 3 首），不一次性把全库 3000 首压入队列。
 */
async function pump() {
  try {
    while (true) {
      if (aborted) break;
    // 顶部补充：队列偏低时从分页 feeder 预取一小批
    if (feeder && !feederDone && queue.length < PAGE_SIZE) {
      let rows;
      try {
        rows = await feeder();
      } catch (e) {
        logger.warn(MODULE, 'feeder', '分页取待处理记录失败', { error: e && e.message });
        rows = [];
      }
      if (!rows || rows.length === 0) {
        feederDone = true;
      } else {
        for (const row of rows) {
          const key = String((row && (row.rel_path || row.id)) || '');
          if (!key || queuedKeys.has(key)) continue;
          queuedKeys.add(key);
          // 用本轮锁定来源 currentRunTrigger（beginRun 时设定，forceReset 不清空），
          // 不受后续状态归位清空影响，否则 status.trigger 被置空后 tagOf(null) 兜底成「[未知来源]」。
          queue.push({ row, trigger: currentRunTrigger, only: currentOnly, playKey: null });
        }
        status.queued = queue.length;
        lastProgressAt = Date.now();
      }
      continue; // 重新评估（可能继续取下一页或启动任务）
    }
    if (active >= MAX_CONC) break;
    if (queue.length === 0) break;
    const task = queue.shift();
    const key = String((task.row && (task.row.rel_path || task.row.id)) || '');
    queuedKeys.delete(key);
    status.queued = queue.length;
    active += 1;
    const t = task.trigger;
    const only = task.only;
    runSongPipeline(task.row, t, only, task.overwrite)
      .catch((e) => {
        status.failed += 1;
        logger.warn(MODULE, 'pipeline', `${tagOf(t)} 歌曲流水线异常`, { error: e && e.message });
      })
      .finally(() => {
        active = Math.max(0, active - 1);
        lastProgressAt = Date.now();
        if (task.playKey) playPending.delete(task.playKey);
        status.done += 1;
        status.percent = status.total > 0 ? Math.min(100, Math.round((status.done / status.total) * 1000) / 10) : 0;
        status.updatedAt = Date.now();
        // 每首进度心跳降为 DEBUG：避免一首一行刷爆 INFO；需诊断「在跑但慢」vs「卡死」时开 DEBUG 即可观察。
        logger.debug(MODULE, 'queue', `${tagOf(t)} 已完成 ${status.done}/${status.total}（active=${active}, queued=${queue.length}）`);
        if (active === 0 && queue.length === 0 && (!feeder || feederDone) && !aborted) {
          const ok = status.done - status.failed;
          logger.info(MODULE, 'queue', `${tagOf(t)} 本轮处理完成：成功 ${ok} 个，失败 ${status.failed} 个（共 ${status.done} 首）`);
          setIdle();
        }
        drain();
      });
    }
  } catch (e) {
    // 任何同步异常（如取页逻辑出错）都记录并复位调度状态，避免 unhandled rejection + draining 卡死导致永久调度瘫痪。
    logger.error(MODULE, 'pump', '调度泵异常，已复位调度状态', { error: e && e.message });
  } finally {
    draining = false;
  }
}

/** 触发一次调度泵（并发安全：已在泵循环中则跳过） */
function drain() {
  if (draining) return;
  draining = true;
  pump();
}

function waitIdle(maxMs) {
  const cap = (typeof maxMs === 'number' && maxMs > 0) ? maxMs : RUN_WATCHDOG_MS;
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      // aborted 时（停滞看门狗 forceReset / 用户停止）立即结束等待，使 runMetaStages 的 finally 能及时释放
      // 编排锁 pipelineRunning，避免僵尸在途任务(active 卡 >0)把入口锁再拖到 RUN_WATCHDOG_MS 上限才放开。
      if (aborted || (active === 0 && queue.length === 0 && (!feeder || feederDone))) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > cap) {
        // 看门狗：到点强制结束等待（流水线仍在后台跑，只是不再阻塞调用方）
        clearInterval(timer);
        logger.warn(MODULE, 'queue', 'waitIdle 触发看门狗上限，强制结束等待（可能存在任务卡死，流水线继续后台运行）', { active, queued: queue.length, feederDone });
        resolve();
      }
    }, 200);
  });
}

const nonEmpty = (v) => !!(v && String(v).trim());

/**
 * 单曲流水线 Step1-Step8（严格串行）
 * 任一步骤网络异常均被捕获，仅该项留空，不中断后续步骤。
 */
async function runSongPipeline(row, trigger, only, overwrite) {
  // 若传入的 trigger 无法识别（如被并发/状态归位清空成 null），回退到本轮 beginRun 锁定的真实来源，
  // 避免逐首 step 日志掉成「[未知来源]」误导排查。
  const T = (TRIGGER_LABEL[trigger] ? tagOf(trigger) : tagOf(currentRunTrigger));
  // 单首 step 明细日志：verboseScanLog=false 时走 LOG_NOOP（零输出），避免存量歌曲刷屏；
  // 仅调试模式（verboseScanLog=true）下输出本首 step1-8 逐条明细。汇总/异常日志不受影响。
  const log = verboseScanLog ? logger : LOG_NOOP;
  const relPath = String(row.rel_path || '');
  // title / artist / album 用 let：Step1 插件补空后会就地更新，供后续步骤（封面/专辑封面/歌词）使用
  let title = String(row.title || '').trim();
  let artist = String(row.artist || '').trim();
  let album = String(row.album || '').trim();
  if (PLACEHOLDER_ALBUM.has(album)) album = '';   // 未知专辑 / 未知 → 视为空
  if (PLACEHOLDER_ARTIST.has(artist)) artist = ''; // 未知艺术家 / 未知歌手 / 未知 → 视为空

  status.currentSong = title ? `${title} - ${artist}` : relPath;
  const pendingDownloads = []; // 风险6：单歌曲内部局部缓冲区，step2-4 收集 url，step6 就地消费

  // ---------- Step1 文件元数据入库（核心字段完整则零插件请求）----------
  // 阶段0 已按优先级完成：本地音频 = ID3 内嵌标签 > 目录路径；strm = 目录路径。
  // 核心字段（艺术家、专辑、歌曲标题）全部非空 → 直接跳过插件，不发起任何请求；
  // 只有存在空缺字段时才请求插件补空，且插件只填空、绝不覆盖已有有效值。
  // 用户手动补全（only='meta' + overwrite）例外：允许插件完整覆盖现有元数据。
  const onlyMode = String(only || 'all');
  const metaOnly = onlyMode === 'meta';
  // overwrite 参数：播放触发等 per-task 显式传入（恒 false）；未传时回退到本轮全局 currentOverwrite
  const overwriteMeta = metaOnly && !!(overwrite !== undefined ? overwrite : currentOverwrite);
  status.currentStep = 'step1 文件元数据入库';
  log.info(MODULE, 'step1', `${T} step1-start 文件元数据入库 path=${relPath}`);
  let albumByPlugin = false;
  let step1Matched = null; // 复用给 Step1.5：本次已联网搜到的匹配对象，可直接取时长（零额外请求）
  {
    const missing = [];
    if (!nonEmpty(title)) missing.push('title');
    if (!nonEmpty(artist) || PLACEHOLDER_ARTIST.has(artist)) missing.push('artist');
    if (!nonEmpty(album)) missing.push('album');
    if (overwriteMeta) {
      const r = await searchMissingMeta(title, artist, ['title', 'artist', 'album'], true);
      if (r.matched) step1Matched = r.matched;
      const patch = {};
      if (r.title) patch.title = r.title;
      if (r.artist) patch.artist = r.artist;
      if (r.album) patch.album = r.album;
      if (Object.keys(patch).length) {
        await localLibraryDb.updateSongMetaFields(relPath, patch, true, 'plugin');
        if (patch.title) title = patch.title;
        if (patch.artist) artist = patch.artist;
        if (patch.album) { album = patch.album; albumByPlugin = true; }
      }
      log.info(MODULE, 'step1', `${T} step1-手动覆盖元数据 使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '无'}｜写入:[${Object.keys(patch).join(',') || '无'}]`);
    } else if (missing.length === 0) {
      // 核心字段已完整：跳过插件（零请求），避免无谓消耗接口额度导致限流/失效
      log.info(MODULE, 'step1', `${T} step1-end 结果：核心字段(歌名/歌手/专辑)已完整 → 跳过插件，零请求`);
    } else if (!title) {
      log.info(MODULE, 'step1', `${T} step1-end 结果：歌名为空，无法检索，跳过（等待用户手动编辑）`);
    } else {
      const r = await searchMissingMeta(title, artist, missing, false);
      if (r.matched) step1Matched = r.matched;
      const patch = {};
      if (r.title && missing.includes('title')) patch.title = r.title;
      if (r.artist && missing.includes('artist')) patch.artist = r.artist;
      if (r.album && missing.includes('album')) patch.album = r.album;
      if (Object.keys(patch).length) {
        await localLibraryDb.updateSongMetaFields(relPath, patch, false, 'plugin');
        if (patch.title) title = patch.title;
        if (patch.artist) artist = patch.artist;
        if (patch.album) { album = patch.album; albumByPlugin = true; }
      }
      log.info(MODULE, 'step1', `${T} step1-补空 缺失:[${missing.join(',')}] 使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '无'}｜补到:[${Object.keys(patch).join(',') || '无'}]`);
    }
    log.info(MODULE, 'step1', `${T} step1-end 结果：歌名=${title || '空'},歌手=${artist || '空'},专辑=${album || '空'}｜插件改动=${albumByPlugin}`);
  }

  // ---------- Step1.5 时长补录（strm 无内嵌时长，只能靠插件搜索结果回填）----------
  // strm 本体是文本流容器，ffmpeg 读不到真实时长，必须由插件搜索结果补录；
  // 普通音频时长来自文件标签（阶段0），缺失（损坏/无标签）时同样走此补录。
  // 已有真实时长（含播放时客户端写回的真实时长）一律不覆盖。
  status.currentStep = 'step1.5 时长补录';
  // 时长补录策略（配置 duration_fill_mode）：
  //  reuse（默认）：只在 Step1 已为补元数据发起过检索时复用该结果取时长（零额外请求）；
  //                核心字段完整而未发起检索时，不再为时长单独联网——严格遵守「能不调用就不调用」。
  //  always：时长缺失就联网搜索（插件额度充足时用）。
  //  off：完全不为时长联网（时长等播放时由客户端写回）。
  const durationMode = String(getConfigSetting('duration_fill_mode', 'reuse') || 'reuse');
  if (Number(row.duration) > 0) {
    log.info(MODULE, 'step1.5', `${T} step1.5-end 结果：已有时长 ${row.duration}s，跳过补录`);
  } else if (onlyMode === 'lyric' || onlyMode === 'image' || onlyMode === 'meta') {
    log.info(MODULE, 'step1.5', `${T} step1.5-end 结果：本模式(${onlyMode})不做时长补录，跳过`);
  } else if (!title) {
    log.info(MODULE, 'step1.5', `${T} step1.5-end 结果：歌名为空，跳过`);
  } else if (durationMode === 'off') {
    log.info(MODULE, 'step1.5', `${T} step1.5-end 结果：按配置(duration_fill_mode=off)不为时长联网，跳过`);
  } else if (durationMode === 'reuse' && !step1Matched) {
    log.info(MODULE, 'step1.5', `${T} step1.5-end 结果：核心字段完整未发起检索，按 reuse 策略不为时长单独联网，跳过`);
  } else {
    // 优先复用 Step1 已搜到的匹配对象（零额外请求）；该插件结果若无时长字段
    // （实测酷我_念心/弥音QQ 无 duration），则继续逐个插件搜索直到取到时长（如 Migu）。
    const r = await searchTrackDuration(title, artist, [step1Matched]);
    let filled = false;
    if (r.duration > 0) {
      await localLibraryDb.updateSongDuration(relPath, r.duration);
      filled = true;
    }
    log.info(MODULE, 'step1.5', `${T} step1.5-end 结果：${filled ? `补录到时长 ${r.duration}s` : '未搜到时长'}｜使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '(复用Step1结果)'}${row.is_strm ? '（strm 文件：无本地时长，依赖本次补录）' : ''}`);
  }

  // ---------- Step2 单曲封面（有内嵌封面则跳过，否则歌名+歌手搜索 cover_plugins）----------
  status.currentStep = 'step2 单曲封面';
  log.info(MODULE, 'step2', `${T} step2-start 单曲封面处理 song=${title} artist=${artist}`);
  if (metaOnly) {
    log.info(MODULE, 'step2', `${T} step2-end 结果：仅元数据模式，跳过封面搜索`);
  } else if (nonEmpty(row.cover_relpath)) {
    log.info(MODULE, 'step2', `${T} step2-end 结果：已有单曲封面/内嵌封面，跳过搜索`);
  } else if (!title) {
    log.info(MODULE, 'step2', `${T} step2-end 结果：歌名为空，跳过`);
  } else {
    const r = await searchTrackCover(title, artist);
    if (r.url) {
      // 收集到局部缓冲区，step6 就地下载（不投递全局队列）
      pendingDownloads.push({ kind: 'cover', url: r.url, bind: (rel, hash) => localLibraryDb.bindSongCover(relPath, rel, hash) });
    }
    log.info(MODULE, 'step2', `${T} step2-end 结果：搜索到url=${!!r.url}｜使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '无'}`);
  }

  // ---------- Step3 专辑封面（严格 歌手+专辑名，绝不拿单曲封面冒充）----------
  status.currentStep = 'step3 专辑封面';
  log.info(MODULE, 'step3', `${T} step3-start 专辑封面处理 artist=${artist} album=${album || '空'}`);
  if (metaOnly) {
    log.info(MODULE, 'step3', `${T} step3-end 结果：仅元数据模式，跳过专辑封面搜索`);
  } else if (nonEmpty(row.album_cover_relpath)) {
    log.info(MODULE, 'step3', `${T} step3-end 结果：已有专辑封面，跳过`);
  } else if (!album) {
    log.info(MODULE, 'step3', `${T} step3-end 结果：专辑名为空，跳过（不发起网络请求）`);
  } else {
    const r = await searchAlbumCoverByAlbum(album, artist);
    if (r.url) {
      pendingDownloads.push({ kind: 'cover', url: r.url, bind: (rel, hash) => localLibraryDb.bindAlbumCover(album, artist, rel, hash) });
    }
    log.info(MODULE, 'step3', `${T} step3-end 结果：搜索得到url=${!!r.url}｜使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '无'}`);
  }

  // ---------- Step4 歌手头像（仅歌手名，artist_image_plugins）----------
  status.currentStep = 'step4 歌手头像';
  log.info(MODULE, 'step4', `${T} step4-start 歌手头像处理 artist=${artist}`);
  if (metaOnly) {
    log.info(MODULE, 'step4', `${T} step4-end 结果：仅元数据模式，跳过歌手头像搜索`);
  } else if (nonEmpty(row.artist_cover_relpath)) {
    log.info(MODULE, 'step4', `${T} step4-end 结果：已有歌手头像，跳过`);
  } else if (!artist) {
    log.info(MODULE, 'step4', `${T} step4-end 结果：歌手名为空，跳过`);
  } else {
    const r = await searchArtistAvatar(artist);
    if (r.url) {
      pendingDownloads.push({ kind: 'artist', url: r.url, bind: (rel, hash) => localLibraryDb.bindArtistCover(artist, rel, hash) });
    }
    log.info(MODULE, 'step4', `${T} step4-end 结果：搜索得到url=${!!r.url}｜使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '无'}`);
  }

  // ---------- Step5 歌词（有内嵌歌词则跳过）----------
  status.currentStep = 'step5 歌词';
  log.info(MODULE, 'step5', `${T} step5-start 歌词处理 song=${title} artist=${artist}`);
  let lyricText = null;
  if (metaOnly) {
    log.info(MODULE, 'step5', `${T} step5-end 结果：仅元数据模式，跳过歌词搜索`);
  } else if (nonEmpty(row.lyric_raw)) {
    log.info(MODULE, 'step5', `${T} step5-end 结果：已有歌词（内嵌或已入库），跳过搜索`);
  } else if (!title) {
    log.info(MODULE, 'step5', `${T} step5-end 结果：歌名为空，跳过`);
  } else {
    const r = await searchSongLyrics(title, artist);
    lyricText = r.lyrics;
    log.info(MODULE, 'step5', `${T} step5-end 结果：搜到网络歌词=${!!lyricText}｜使用插件:[${(r.plugins || []).join(',') || '无'}] 命中插件:${r.plugin || '无'}`);
  }

  // ---------- Step6 图片下载 / 转码 / MD5 去重（就地消费，无全局队列）----------
  status.currentStep = 'step6 图片下载转码';
  const imgKinds = pendingDownloads.map((d) => d.kind);
  log.info(MODULE, 'step6', `${T} step6-start 图片任务 数=${pendingDownloads.length} 类型=[${imgKinds.join(',') || '无'}]`);
  // 风险6：图片直接在单歌流水线内 await 下载，受并发 3 限流；重启不会遗留悬空全局任务。
  for (const d of pendingDownloads) {
    await downloadAndBind(d.url, d.kind, d.bind);
  }
  log.info(MODULE, 'step6', `${T} step6-end 结果：图片已就地下载转码并绑定（track/album→cover/，artist→art/；磁盘已存在按 MD5 复用；成功后回写数据库且仅填空）`);

  // ---------- Step7 歌词持久化（仅 NULL 时写入）----------
  status.currentStep = 'step7 歌词持久化';
  log.info(MODULE, 'step7', `${T} step7-start 歌词持久化 song=${title}`);
  if (lyricText && String(lyricText).trim()) {
    let structJson = null;
    try {
      const struct = lrcUtils.parseLrcStruct(String(lyricText));
      structJson = struct ? JSON.stringify(struct) : null;
    } catch { structJson = null; }
    await localLibraryDb.bindLyrics(relPath, String(lyricText), structJson);
    log.info(MODULE, 'step7', `${T} step7-end 结果：写入成功=true｜文本为空跳过=false`);
  } else {
    log.info(MODULE, 'step7', `${T} step7-end 结果：写入成功=false｜文本为空跳过=true`);
  }

  // ---------- Step8 完成标记 + 失败冷却（风险4）----------
  status.currentStep = 'step8 完成';
  await localLibraryDb.setTrackMeta(relPath, null, 'meta_filled');
  // 仍缺失字段 → 记录失败原因 + 最后尝试时间（24h 冷却内不再重试）；
  // 已补满 → 清除失败标记，避免被冷却误伤。
  const missing = await getMissingFields(relPath, only);
  if (missing.length) {
    await localLibraryDb.setEnrichFailed(relPath, missing.join(','));
  } else {
    await localLibraryDb.clearEnrichFailed(relPath);
  }
  log.info(MODULE, 'step8', `${T} step8-complete 歌曲处理全部完成 title=${title}｜仍缺失:[${missing.join(',') || '无'}]`);
}

/** 读取歌曲当前各封面/歌词绑定状态，按 only 返回仍缺失的字段名列表（供失败冷却判定） */
async function getMissingFields(relPath, only) {
  const st = await localLibraryDb.getEnrichStatus(relPath);
  if (!st) return [];
  const mode = String(only || 'all');
  const miss = [];
  if (mode === 'meta') {
    // 仅元数据模式：按核心字段（歌名/歌手/专辑）判定是否仍缺失
    const t = String(st.title || '').trim();
    const a = String(st.artist || '').trim();
    const al = String(st.album || '').trim();
    if (!t) miss.push('title');
    if (!a || PLACEHOLDER_ARTIST.has(a)) miss.push('artist');
    if (!al || PLACEHOLDER_ALBUM.has(al)) miss.push('album');
    return miss;
  }
  if (mode !== 'lyric') {
    if (!nonEmpty(st.cover_relpath)) miss.push('cover');
    if (!nonEmpty(st.album_cover_relpath)) miss.push('album_cover');
    if (!nonEmpty(st.artist_cover_relpath)) miss.push('artist_cover');
  }
  if (mode !== 'image') {
    if (!nonEmpty(st.lyric_raw)) miss.push('lyric');
  }
  return miss;
}

/**
 * 强制清理运行时状态（停滞看门狗 / 兜底归位用）：解除对 isRunning() 的占用，使后续 monitor 可继续。
 * 不强行清零 active（在途任务由其各自 finally 递减并自然归位），仅置 aborted 并清空队列/feeder；
 * 状态一律归位 IDLE（isRunning() 不依赖 status.state，故不影响并发判断）。
 */
function forceReset() {
  aborted = true;
  pipelineRunning = false;
  queue.length = 0;
  queuedKeys.clear();
  feeder = null;
  feederDone = true;
  status.state = 'IDLE';
  status.trigger = null;
  status.triggerLabel = '';
  status.message = '流水线已结束';
  status.updatedAt = Date.now();
}

/**
 * 运行补全流水线（分页流式：不一次性把全库 3000 首加载进内存，每页只预取一小批）。
 * @param {Object} [opts] { trigger?:'monitor'|'manual'|'fill'|'play', only?:'all'|'image'|'lyric'|'meta',
 *                          overwrite?:boolean, relPaths?:string[] }
 *   only='meta' 为「元数据补全」模式：只处理核心字段（歌名/歌手/专辑）缺失的歌曲（overwrite=true 时处理全部），
 *   不搜封面/头像/歌词；overwrite=true 时允许插件完整覆盖现有元数据（用户手动补全专用）。
 */
async function runMetaStages(opts) {
  const o = opts || {};
  const trigger = o.trigger || 'manual';
  const only = o.only || 'all';
  // monitor 仅处理本轮扫描到的「新增」歌曲（changedRelPaths），不拖历史 backlog；
  // 不带 changedRelPaths 的 monitor（如开机增量抓 backlog）则处理全部 raw_parsed。
  const changedRelPaths = (o.changedRelPaths && Array.isArray(o.changedRelPaths)) ? o.changedRelPaths : [];
  // 手动元数据补全：可指定只处理这批 rel_path（前端按歌曲 id 选择），并允许覆盖已有元数据
  const metaRelPaths = (o.relPaths && Array.isArray(o.relPaths)) ? o.relPaths : [];
  const metaOverwrite = !!o.overwrite && only === 'meta';
  const metaMode = only === 'meta';
  // 入口守卫只看「是否有编排运行在跑」（pipelineRunning）。与在途任务数解耦，
  // 因此即便上一首歌的网络请求挂死(active 卡 >0)，只要上轮编排结束置 false，本轮即可进入，不会被永久挡住。
  if (isRunning()) {
    // 运行期间又有 monitor 变更到达：标记待补跑，本轮 finally 结束后自动再跑一次，避免丢变更事件。
    // 同时累积这批新增的 rel_path，使补跑只覆盖「本轮新增 + 期间到达」，不扩大范围到历史。
    if (trigger === 'monitor') {
      pendingMonitorRerun = true;
      if (changedRelPaths.length) {
        const set = new Set(lastMonitorChangedRelPaths);
        changedRelPaths.forEach((p) => set.add(p));
        lastMonitorChangedRelPaths = Array.from(set);
      }
    }
    logger.warn(MODULE, 'run', `${tagOf(trigger)} 请求被忽略：流水线已在运行中（将按待补跑机制处理，不丢变更）`);
    return getStatus();
  }
  // 本次 monitor 处理的就是这批新增（覆盖上一轮累积，避免带入历史 backlog）
  if (trigger === 'monitor') lastMonitorChangedRelPaths = changedRelPaths;
  beginRun(trigger);
  currentOnly = only;
  currentOverwrite = metaOverwrite;
  // 停滞看门狗：超过 PIPELINE_STALL_MS 无任何进展（无任务完成 / 无取页）即强制清理运行时状态，
  // 避免某环节异常挂起导致 isRunning() 永远为真、后续 monitor 永久被挡。
  const stallTimer = setInterval(() => {
    if (status.state !== 'RUNNING' || aborted) return;
    if (Date.now() - lastProgressAt > PIPELINE_STALL_MS) {
      logger.warn(MODULE, 'run', `${tagOf(trigger)} 停滞看门狗触发：超过 ${PIPELINE_STALL_MS / 1000}s 无进展，强制清理运行时状态（active=${active}, queued=${queue.length}, feederDone=${feederDone}）`);
      forceReset();
    }
  }, 15000);
  if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();
  try {
    // 大批量 rel_path 过滤准备（>500 时建临时表，规避 SQLite 变量上限导致 IN 静默失效）
    await localLibraryDb.prepareRelPathFilter(metaMode ? metaRelPaths : changedRelPaths);
    // 进度总数（手动/补全含 24h 失败冷却排除；monitor 仅 raw_parsed，且可选按 changedRelPaths 仅限本轮新增）
    const total = metaMode
      ? await localLibraryDb.countMetaFillSongs(metaOverwrite, metaRelPaths)
      : await localLibraryDb.countIncompleteSongs(only, trigger, changedRelPaths);
    status.total = total;
    status.done = 0;
    status.failed = 0;
    status.percent = 0;
    status.queued = 0;
    status.message = '';
    // 分页 feeder：每批只从 DB 取 PAGE_SIZE 条，处理完一批再取下一批（风险1）
    feeder = makeFeeder(only, trigger, changedRelPaths, metaOverwrite, metaRelPaths);
    feederDone = false;
    aborted = false;
    lastProgressAt = Date.now();
    logger.info(MODULE, 'run', `${tagOf(trigger)} 开始：待处理约 ${total} 首（only=${only}，分页流式，并发上限 ${MAX_CONC}）`);
    drain();
    await waitIdle();
  } catch (e) {
    // 任何异常（取待处理记录失败 / waitIdle 异常等）都不会再卡锁：finally 兜底释放。
    logger.warn(MODULE, 'run', `${tagOf(trigger)} 流水线异常，强制归位`, { error: e && e.message });
  } finally {
    clearInterval(stallTimer);
    // 兜底归位：无论成功、异常、还是提前 return，一律释放编排锁，保证后续 monitor 不再被永久挡住。
    forceReset();
    // 运行期间若又有 monitor 变更到达（pendingMonitorRerun），本轮结束延时再跑一次，避免丢变更事件。
    // 若此刻仍忙则内部会再次标记 pendingMonitorRerun，形成 500ms 间隔的补跑循环直至清空。
    if (pendingMonitorRerun) {
      pendingMonitorRerun = false;
      setTimeout(() => {
        runMetaStages({ trigger: 'monitor', only: 'all', changedRelPaths: lastMonitorChangedRelPaths }).catch(() => {});
      }, 500);
    }
  }
  return getStatus();
}

/** 构造分页取待处理记录的 feeder（monitor 取 raw_parsed，可选按 changedRelPaths 仅限本轮新增；
 *  手动/补全取缺失且非冷却期歌曲；only='meta' 取核心字段缺失（或 overwrite 时全部）的歌曲）。
 *  关键：用 keyset 游标（id > lastId）而非 OFFSET——被处理完成的行会立刻离开过滤集，
 *  OFFSET 窗口随完成后移会静默跳过未入队的行；keyset 每行只会被取到一次，不会漏。 */
function makeFeeder(only, trigger, changedRelPaths, overwrite, relPaths) {
  let lastId = ''; // id 为 TEXT（'tr-'+md5），游标必须按字符串推进；数字化会 NaN 卡死在 0 → feeder 活锁
  return async () => {
    let rows;
    if (only === 'meta') {
      rows = await localLibraryDb.getMetaFillSongsPaged(lastId, PAGE_SIZE, !!overwrite, relPaths);
    } else if (trigger === 'monitor') {
      rows = await localLibraryDb.getRawParsedSongsPaged(lastId, PAGE_SIZE, changedRelPaths);
    } else {
      rows = await localLibraryDb.getIncompleteSongsPaged(lastId, PAGE_SIZE, only, trigger);
    }
    rows = rows || [];
    if (rows.length) {
      const nextId = rows[rows.length - 1].id;
      if (nextId != null && String(nextId) !== String(lastId)) {
        lastId = String(nextId);
      } else {
        // 防御：游标未推进（同页重复返回）则直接结束取页，避免 pump 空转活锁
        feederDone = true;
      }
    }
    return rows;
  };
}

module.exports = {
  getStatus,
  isRunning,
  requestAbort,
  setIdle,
  reportStage0,
  runMetaStages,
  enqueueSong,
  enqueueSongs,
  setVerboseScanLog
};
