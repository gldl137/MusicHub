'use strict';

// ==================== 洛雪专区 API ====================
// 路由归属：/api/lx/*
// 一期只提供「平台 / 排行榜 / 热门歌单」浏览能力（播放解析在二期接入自定义源）。

const ctx = require('../lib/context');
const { logger, authMiddleware, createReqId } = ctx;
const lx = require('../lxmusic');
const lxSources = require('../lxmusic/sources');

// 启动即加载 LX 音源（异步初始化，不阻塞）；未导入任何音源时为空操作
try { lxSources.ensureLoaded(); } catch (e) {
  logger.warn('LX', 'lx-routes', `LX 音源加载失败：${e.message}`);
}

// 轻量内存缓存：仅抗抖动（60 秒），保证榜单/标签与官网实时一致
const CACHE_TTL = 60 * 1000;
const cache = new Map();
function withCache(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then((data) => {
    cache.set(key, { data, ts: Date.now() });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return data;
  });
}

module.exports = function (app) {
  // 全部 /api/lx/* 需要登录
  app.use('/api/lx', authMiddleware);

  // 支持的平台列表
  app.get('/api/lx/platforms', (_req, res) => {
    res.json({ success: true, data: lx.getPlatforms() });
  });

  // ==================== LX 自定义音源管理 ====================

  // 音源列表（含状态、声明平台与音质；并附诊断信息便于排查“已安装但不显示”）
  app.get('/api/lx/sources', (_req, res) => {
    try {
      const data = lxSources.listSources();
      const meta = lxSources.diagnose();
      res.json({ success: true, data, meta });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 导入音源：body { content } 直接粘贴 / { url } 从网址下载 / 可选 fileName
  app.post('/api/lx/sources', async (req, res) => {
    const reqId = createReqId();
    const { content, url, fileName } = req.body || {};
    try {
      const data = await lxSources.addSource({ content, url, fileName });
      logger.info('LX', reqId, `导入音源 ${data.file}`);
      res.json({ success: true, data });
    } catch (err) {
      logger.warn('LX', reqId, `导入音源失败：${err.message}`);
      res.json({ success: false, error: err.message });
    }
  });

  // 单个音源详情（含脚本内容）
  app.get('/api/lx/sources/:file', (req, res) => {
    try {
      const data = lxSources.getSource(req.params.file);
      if (!data) return res.json({ success: false, error: '音源不存在' });
      res.json({ success: true, data });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 删除音源
  app.delete('/api/lx/sources/:file', (req, res) => {
    try {
      lxSources.removeSource(req.params.file);
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 启用 / 停用
  app.post('/api/lx/sources/:file/enabled', (req, res) => {
    try {
      const data = lxSources.setEnabled(req.params.file, !!(req.body || {}).enabled);
      res.json({ success: true, data });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 重新初始化（失败后重试）
  app.post('/api/lx/sources/:file/reload', (req, res) => {
    try {
      const data = lxSources.reload(req.params.file);
      res.json({ success: true, data });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 测试解析：body { source, quality?, keyword? }
  // 未提供 musicInfo 时用本平台搜索一首歌作为样本，验证「音源 → 播放地址」是否可用
  app.post('/api/lx/sources/:file/test', async (req, res) => {
    const reqId = createReqId();
    const { source, quality = 'standard', keyword = '周杰伦' } = req.body || {};
    try {
      if (!source) return res.json({ success: false, error: '缺少 source（平台）' });
      const { resolveLx } = require('../lxmusic/resolver');
      const { probeAudioContent } = require('../MusicFree/resolver-core');
      const r = await lx.search(source, keyword, 1);
      const sample = (r.list || [])[0];
      if (!sample) return res.json({ success: false, error: '取样搜索无结果，换个关键词再试' });
      // 只测这一个音源（onlyFile），且用与播放链路相同的「真音频」判定：
      // 既不会被「别的已启用音源能用」掩盖，也不会把转发接口返回的 JSON 当成播放地址。
      const out = await resolveLx({
        music: sample,
        source,
        quality,
        reqId,
        onlyFile: req.params.file,
        probe: (u) => probeAudioContent(u),
      });
      if (!out.success) {
        logger.warn('LX', reqId, `测试解析失败（${req.params.file}）| ${out.error}`);
        return res.json({ success: false, error: out.error, data: { sample: `${sample.title} - ${sample.artist}` } });
      }
      res.json({ success: true, data: { url: out.data.url, quality: out.data.quality, from: out.data.from, sample: `${sample.title} - ${sample.artist}` } });
    } catch (err) {
      logger.warn('LX', reqId, `测试解析失败：${err.message}`);
      res.json({ success: false, error: err.message });
    }
  });

  // 歌曲搜索（与 MF 插件搜索等价，供 LX 页头搜索框使用）
  app.get('/api/lx/search/:source', async (req, res) => {
    const { source } = req.params;
    const { keyword, page } = req.query;
    const reqId = createReqId();
    try {
      const data = await lx.search(source, keyword, page);
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `搜索失败 ${source}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 排行榜：某平台的榜单列表
  app.get('/api/lx/leaderboard/:source', async (req, res) => {
    const { source } = req.params;
    const reqId = createReqId();
    try {
      const data = await withCache(`boards:${source}`, () => lx.getBoards(source));
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `获取榜单列表失败 ${source}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 排行榜：榜单内歌曲
  app.get('/api/lx/leaderboard/:source/detail', async (req, res) => {
    const { source } = req.params;
    const { id, page } = req.query;
    const reqId = createReqId();
    if (!id) return res.json({ success: false, error: '缺少榜单 id' });
    try {
      const data = await lx.getBoardSongs(source, id, page);
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `获取榜单歌曲失败 ${source}/${id}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 热门歌单：标签
  app.get('/api/lx/songlist/tags/:source', async (req, res) => {
    const { source } = req.params;
    const reqId = createReqId();
    try {
      const data = await withCache(`tags:${source}`, () => lx.getSongListTags(source));
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `获取歌单标签失败 ${source}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 热门歌单：歌单详情（必须放在 /songlist/:source 之前）
  app.get('/api/lx/songlist/detail/:source', async (req, res) => {
    const { source } = req.params;
    const { id, page } = req.query;
    const reqId = createReqId();
    if (!id) return res.json({ success: false, error: '缺少歌单 id' });
    try {
      const data = await lx.getSongListDetail(source, id, page);
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `获取歌单详情失败 ${source}/${id}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 热门歌单：歌单搜索（?keyword=&page=）
  app.get('/api/lx/songlist/search/:source', async (req, res) => {
    const { source } = req.params;
    const { keyword, page } = req.query;
    const reqId = createReqId();
    try {
      const data = await lx.searchSongLists(source, keyword, page);
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `歌单搜索失败 ${source}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });

  // 热门歌单：歌单列表（?sortId=&tagId=&page=）
  app.get('/api/lx/songlist/:source', async (req, res) => {
    const { source } = req.params;
    const { sortId, tagId, page } = req.query;
    const reqId = createReqId();
    try {
      const data = await lx.getSongLists(source, sortId, tagId, page);
      res.json({ success: true, data });
    } catch (err) {
      logger.error('LX', reqId, `获取歌单列表失败 ${source}`, { error: err.message });
      res.json({ success: false, error: err.message });
    }
  });
};
