'use strict';

// ==================== 插件管理 API ====================
// 路由归属：/api/plugins/*
// 业务逻辑（枚举/安装/更新/删除/配置）已归入 MusicFree/plugin-manager.js，
// 本文件只负责 HTTP 路由、鉴权与请求参数搬运。updateAllPlugins 供 wecom 复用，通过 module.exports 导出。

const ctx = require('../lib/context');
const { logger, authMiddleware, adminMiddleware, createReqId, cron, runAutoUpdatePlugins, userConfigs, runPlugin } = ctx;
const radioLib = require('../lib/radio');
const radioCoverRoutes = require('./radio');
const { invalidateRadioStationCache } = require('../rest/opensubsonic');
const database = ctx.database;
const { getAutoUpdateConfig, updateAutoUpdateConfig } = database;

// MusicFree 插件管理核心（专属目录内）
const pluginManager = require('../MusicFree/plugin-manager');
const {
  updateAllPlugins,
  getPluginList,
  getSupportedPlugins,
  installPluginFromBuffer,
  installPluginFromUrl,
  updateSinglePlugin,
  deletePlugin,
  savePluginConfigEntry,
  togglePlugin,
  reorderPlugins,
  loadPluginDetail
} = pluginManager;

const multer = require('multer');


module.exports = function (app) {
  // 安全：插件管理属敏感操作。所有 /api/plugins 路由
  // 先要求登录；写操作再在各路由签名上叠加 adminMiddleware。
  app.use('/api/plugins', authMiddleware);
  // 电台列表同样属登录态接口（含插件定位信息，不对外匿名暴露）
  // 但封面图片 GET /api/radio/cover 需公开：前端用 <img> 标签加载，无法携带 Authorization 头，
  // 一旦要求登录会返回 401 导致封面永不显示。故仅对该公开接口放行，其余 /api/radio 路由仍需登录。
  app.use('/api/radio', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/cover') return next();
    return authMiddleware(req, res, next);
  });

  // 获取所有电台（数据库驱动）。按 省市台 / 分类 / 网络台 三个维度聚合，
  // 复用与插件时代一致的分组结构（dimension + subTitle + stations），前端无需大幅改动。
  function buildRadioResponse(stations) {
    const byDim = { '省市台': {}, '分类': {}, '网络台': {}, '未分类': {} };
    const add = (dim, key, s) => {
      if (!key) return;
      if (!byDim[dim][key]) byDim[dim][key] = { subTitle: key, emoji: '📻', stations: [] };
      byDim[dim][key].stations.push({
        id: s.id, name: s.name, url: s.url,
        province: s.province, category: s.category, network: s.network,
        genre: s.genre, bitrate: s.bitrate, plugin: 'radio'
      });
    };
    for (const s of stations) {
      add('省市台', s.province, s);
      add('分类', s.category, s);
      add('网络台', s.network, s);
      // 三个维度都没选的电台归入「未分类」菜单；只要选了任意一个就离开
      if (!s.province && !s.category && !s.network) {
        add('未分类', '未分类', s);
      }
    }
    const groups = [];
    for (const dim of ['省市台', '分类', '网络台', '未分类']) {
      for (const sub of Object.values(byDim[dim])) {
        groups.push({ title: sub.subTitle, emoji: sub.emoji, dimension: dim, subTitle: sub.subTitle, stations: sub.stations });
      }
    }
    return [{ plugin: 'radio', platform: '广播电台', file: 'database', enabled: true, groups }];
  }

  app.get('/api/radio/stations', async (_req, res) => {
    try {
      const stations = await database.getRadioStationsDB();
      res.json({ success: true, data: buildRadioResponse(stations) });
    } catch (err) {
      logger.error('RADIO', createReqId(), 'Get radio stations error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 新建电台（管理员）
  app.post('/api/radio/stations', adminMiddleware, async (req, res) => {
    try {
      const d = req.body || {};
      if (!d.name || !d.url) return res.json({ success: false, error: '名称和播放地址必填' });
      const st = await database.createRadioStation(d);
      invalidateRadioStationCache();
      res.json({ success: true, data: st });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 更新电台（管理员）
  app.put('/api/radio/stations/:id', adminMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const st = await database.updateRadioStation(id, req.body || {});
      if (!st) return res.json({ success: false, error: '电台不存在' });
      invalidateRadioStationCache();
      res.json({ success: true, data: st });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 删除电台（管理员）
  app.delete('/api/radio/stations/:id', adminMiddleware, async (req, res) => {
    try {
      await database.deleteRadioStation(parseInt(req.params.id, 10));
      invalidateRadioStationCache();
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 重排某分组（维度 + 子项）内电台顺序（管理员）
  // body: { dimension, subTitle, orderedIds: string[] }
  app.post('/api/radio/stations/reorder', adminMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const dimension = body.dimension;
      const subTitle = body.subTitle;
      const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds.map((x) => String(x)) : null;
      if (!dimension || subTitle == null || !orderedIds) {
        return res.json({ success: false, error: 'dimension / subTitle / orderedIds 无效' });
      }
      const ok = await radioLib.reorderRadioStationsGroup(dimension, subTitle, orderedIds);
      invalidateRadioStationCache();
      res.json({ success: !!ok });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 电台排序同步（跨设备） ====================
  // 分类（子菜单）顺序与插件来源电台的分组内顺序不在数据库行里，用 settings KV 存 JSON，
  // 让电脑 / 手机等所有端读取同一份排序，保持一致。
  // data: { subOrder: { 维度: [subTitle...] }, stationOrder: { '维度::子项': [电台id...] } }
  app.get('/api/radio/orders', async (req, res) => {
    try {
      // 注意：database.getSetting 会自动 JSON.parse 存储值，这里不能再 parse 一次
      const normalize = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      const subOrder = normalize(await database.getSetting('radio_sub_order', null));
      const stationOrder = normalize(await database.getSetting('radio_station_order', null));
      res.json({ success: true, data: { subOrder, stationOrder } });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 保存排序（整体覆盖对应部分；不加管理员限制，排序属于视图偏好，所有端均可同步）
  // saveSetting 对对象会自动 JSON.stringify，直接传对象即可
  app.post('/api/radio/orders', async (req, res) => {
    try {
      const body = req.body || {};
      if (body.subOrder && typeof body.subOrder === 'object') {
        await database.saveSetting('radio_sub_order', body.subOrder);
      }
      if (body.stationOrder && typeof body.stationOrder === 'object') {
        await database.saveSetting('radio_station_order', body.stationOrder);
      }
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 电台 M3U 导入 / 导出 ====================
  // M3U 属性值转义：反斜杠、双引号，并把换行压成空格（避免破坏单行 #EXTINF）
  function escapeM3uAttr(v) {
    return String(v == null ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ');
  }

  // 解析 M3U 文本为电台数组，支持模板格式：
  //   #EXTINF:-1 tvg-name="名" tvg-logo="图" province-title="省" category-title="类" network-title="台",
  // 兼容旧格式 group-title（回退到 province）。属性之间允许空格或逗号分隔；
  // 标题取最后一个逗号之后（与标准 EXTINF 一致：属性逗号分隔、标题在末逗号后）。
  function parseM3U(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let pending = null;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      if (line.startsWith('#EXTM3U')) continue;
      if (line.startsWith('#EXTINF')) {
        const m = line.match(/#EXTINF:-?\d+\s*(.*)$/);
        let attrStr = '';
        let title = '';
        if (m) {
          const rest = m[1];
          const ci = rest.lastIndexOf(',');
          if (ci >= 0) { attrStr = rest.slice(0, ci); title = rest.slice(ci + 1); }
          else attrStr = rest;
        }
        const attrs = {};
        const re = /([\w-]+)="([^"]*)"/g;
        let mm;
        while ((mm = re.exec(attrStr)) !== null) attrs[mm[1]] = mm[2];
        // 三维度字段：新版 province-title / category-title / network-title；旧版 group-title 回退 province
        const province = attrs['province-title'] || attrs['group-title'] || '';
        const category = attrs['category-title'] || '';
        const network = attrs['network-title'] || '';
        pending = {
          tvgName: attrs['tvg-name'] || '',
          tvgLogo: attrs['tvg-logo'] || '',
          province,
          category,
          network,
          title
        };
        continue;
      }
      if (line.startsWith('#')) continue; // 其余注释行跳过
      const url = line.trim();
      if (!url) continue;
      const name = (pending && (pending.tvgName || pending.title)) || '';
      out.push({
        name: name || '未知电台',
        url,
        cover_url: pending && /^https?:\/\//i.test(pending.tvgLogo || '') ? pending.tvgLogo : '',
        province: pending ? pending.province : '',
        category: pending ? pending.category : '',
        network: pending ? pending.network : ''
      });
      pending = null;
    }
    return out;
  }

  // 导出全部电台为 M3U（模板格式：tvg-name / tvg-logo / province-title / category-title / network-title，标题逗号后留空）
  app.get('/api/radio/stations/export', async (_req, res) => {
    try {
      const stations = await database.getRadioStationsDB();
      const lines = ['#EXTM3U'];
      for (const s of stations) {
        const logo = s.cover_url || '';
        const name = s.name || '未知电台';
        // 严格按模板顺序输出五个属性；空维度输出空串，保持与导入解析对称
        const attrs = [
          `tvg-name="${escapeM3uAttr(name)}"`,
          `tvg-logo="${escapeM3uAttr(logo)}"`,
          `province-title="${escapeM3uAttr(s.province || '')}"`,
          `category-title="${escapeM3uAttr(s.category || '')}"`,
          `network-title="${escapeM3uAttr(s.network || '')}"`
        ];
        lines.push(`#EXTINF:-1 ${attrs.join(' ')},`);
        lines.push(s.url || '');
      }
      const content = lines.join('\r\n');

      // 仅内存生成并触发浏览器下载，不落盘到服务器目录
      res.set('Content-Type', 'application/x-mpegurl; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="radio-export.m3u"');
      res.set('X-Station-Count', String(stations.length));
      return res.status(200).send(content);
    } catch (err) {
      logger.error('RADIO', createReqId(), 'Export radio stations failed', { error: logger.formatError(err) });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 从 M3U 文件批量导入电台（管理员）：按名称去重，同名只覆盖更新、不新建
  const m3uUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
  app.post('/api/radio/stations/import', adminMiddleware, m3uUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.json({ success: false, error: '未收到文件' });
      const list = parseM3U(req.file.buffer.toString('utf8'));
      if (!list.length) return res.json({ success: false, error: '文件中未解析到有效电台' });

      const existing = await database.getRadioStationsDB();
      // 按名称（大小写不敏感）建立查找表：同名电台导入时只覆盖更新，不新建
      const byName = new Map();
      for (const s of existing) {
        const n = String(s.name || '').trim().toLowerCase();
        if (n && !byName.has(n)) byName.set(n, s);
      }

      let created = 0, updated = 0, skipped = 0;
      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        const name = String(st.name || '').trim();
        if (!name) { skipped++; continue; }

        // 解析封面：远程 tvg-logo 自动下载并按电台名称重命名存入 radio-covers 目录
        let coverUrl = '';
        const logo = String(st.cover_url || '').trim();
        if (/^https?:\/\//i.test(logo)) {
          try {
            coverUrl = await radioCoverRoutes.saveRadioCoverFromUrl(st.name, logo);
          } catch (e) {
            coverUrl = logo; // 下载失败则保留原始远程地址，导入不中断
          }
        } else if (logo) {
          coverUrl = logo; // 已是本地/相对地址，原样保留
        }

        const ex = byName.get(name.toLowerCase());
        if (ex) {
          // 同名：用导入的数据覆盖更新已有记录（不新建）；三维度按是否提供分别更新
          const data = { name: st.name, url: st.url };
          if (st.province) data.province = st.province;
          if (st.category) data.category = st.category;
          if (st.network) data.network = st.network;
          if (coverUrl) data.cover_url = coverUrl;
          try {
            await database.updateRadioStation(ex.id, data);
            updated++;
          } catch (e) {
            skipped++;
          }
        } else {
          try {
            await database.createRadioStation({
              name: st.name,
              url: st.url,
              province: st.province || '',
              category: st.category || '',
              network: st.network || '',
              cover_url: coverUrl,
              sort_order: i
            });
            created++;
          } catch (e) { skipped++; }
        }
      }
      invalidateRadioStationCache();
      res.json({ success: true, count: list.length, created, updated, skipped });
    } catch (err) {
      logger.error('RADIO', createReqId(), 'Import radio stations failed', { error: logger.formatError(err) });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 清空全部电台数据（管理员）：删除 radio_stations 全部记录，收藏不受影响
  app.post('/api/radio/stations/clear', adminMiddleware, async (_req, res) => {
    try {
      await database.clearRadioStationsDB();
      invalidateRadioStationCache();
      res.json({ success: true });
    } catch (err) {
      logger.error('RADIO', createReqId(), 'Clear radio stations failed', { error: logger.formatError(err) });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 获取收藏电台列表（按当前登录用户隔离）
  app.get('/api/radio/favorites', async (req, res) => {
    res.json({ success: true, data: await radioLib.getRadioFavorites(req.user && req.user.userId) });
  });

  // 添加收藏（body.station 需含 id / name / url 等字段）
  app.post('/api/radio/favorites', async (req, res) => {
    try {
      const st = req.body && req.body.station;
      if (!st || !st.id) return res.json({ success: false, error: 'station 无效' });
      const list = await radioLib.getRadioFavorites(req.user && req.user.userId);
      if (list.some((x) => String(x.id) === String(st.id))) {
        return res.json({ success: true, data: list, favorited: true });
      }
      list.push({
        id: String(st.id),
        name: st.name || '未知电台',
        url: st.url || st.streamUrl || '',
        homepageUrl: st.homepageUrl || '',
        logo: st.logo || st.artwork || '',
        region: st.region || '',
        genre: st.genre || '',
        bitrate: st.bitrate || 0,
        plugin: st.plugin || '',
        dimension: st.dimension || '',
        group: st.group || '',
        province: st.province || st.region || '',
        categories: Array.isArray(st.categories) ? st.categories : []
      });
      await radioLib.saveRadioFavorites(list, req.user && req.user.userId);
      invalidateRadioStationCache();
      res.json({ success: true, data: list, favorited: true });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 收藏电台排序（按当前登录用户隔离）：body.ids 为新的完整 id 顺序
  app.put('/api/radio/favorites/order', async (req, res) => {
    try {
      const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map((x) => String(x)) : null;
      if (!ids) return res.json({ success: false, error: 'ids 无效' });
      const list = await radioLib.getRadioFavorites(req.user && req.user.userId);
      const map = new Map(list.map((x) => [String(x.id), x]));
      const next = [];
      for (const id of ids) {
        const item = map.get(id);
        if (item) { next.push(item); map.delete(id); }
      }
      // ids 里没出现的收藏（并发新增等）补在末尾，避免被排序请求误删
      for (const item of map.values()) next.push(item);
      await radioLib.saveRadioFavorites(next, req.user && req.user.userId);
      invalidateRadioStationCache();
      res.json({ success: true, data: next });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 取消收藏（query.id 或 body.id）
  app.delete('/api/radio/favorites', async (req, res) => {
    try {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.json({ success: false, error: 'id 无效' });
      let list = await radioLib.getRadioFavorites(req.user && req.user.userId);
      list = list.filter((x) => String(x.id) !== String(id));
      await radioLib.saveRadioFavorites(list, req.user && req.user.userId);
      invalidateRadioStationCache();
      res.json({ success: true, data: list, favorited: false });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 获取插件列表（业务逻辑见 MusicFree/plugin-manager.js）
  app.get('/api/plugins', async (_req, res) => {
    try {
      res.json({ success: true, data: await getPluginList() });
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Get plugins error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 获取插件支持的方法
  app.get('/api/plugins/support/:method', async (req, res) => {
    try {
      res.json({ success: true, data: await getSupportedPlugins(req.params.method) });
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Get plugin support error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 安装插件（上传文件）：内存接收，不产生临时目录/文件
  app.post('/api/plugins/install', adminMiddleware, (req, res) => {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });
    upload.single('file')(req, res, async (err) => {
      if (err) {
        logger.error('PLUGIN', createReqId(), 'Install plugin upload error', { error: err.message });
        return res.json({ success: false, error: '文件上传失败: ' + err.message });
      }
      res.json(await installPluginFromBuffer({
        buffer: req.file && req.file.buffer,
        originalname: req.file && req.file.originalname,
        targetPlatform: req.body && req.body.targetPlatform,
        displayName: req.body && req.body.displayName
      }));
    });
  });
  // 从 URL 安装插件（支持「按音源归类 + 同类型校验」）
  app.post('/api/plugins/install-from-url', adminMiddleware, async (req, res) => {
    res.json(await installPluginFromUrl(req.body, createReqId()));
  });
  // 更新所有插件
  app.post('/api/plugins/update-all', adminMiddleware, async (_req, res) => {
    try {
      res.json(await updateAllPlugins());
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Update all plugins error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 获取插件自动更新配置
  app.get('/api/plugins/auto-update/config', async (_req, res) => {
    try {
      const configData = await getAutoUpdateConfig();
      res.json({
        success: true,
        data: {
          enabled: configData.enabled,
          cronExpression: configData.cronExpression,
          lastUpdateTime: configData.lastUpdateTime,
          nextUpdateTime: await ctx.schedulerManager.getPluginUpdateStatus()
        }
      });
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Get auto-update config error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 保存插件自动更新配置
  app.post('/api/plugins/auto-update/config', adminMiddleware, async (req, res) => {
    const { enabled, cronExpression } = req.body;
    try {
      if (cronExpression && !cron.validate(cronExpression)) {
        return res.json({ success: false, error: '无效的 Cron 表达式' });
      }
      await updateAutoUpdateConfig({ enabled, cronExpression });
      res.json({ success: true, message: '自动更新配置已保存' });
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Save auto-update config error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 立即触发插件自动更新
  app.post('/api/plugins/auto-update/trigger', adminMiddleware, async (req, res) => {
    const { sendNotification } = req.body;
    try {
      const result = await runAutoUpdatePlugins({ sendNotification });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Trigger auto-update error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 更新单个插件
  app.post('/api/plugins/:pluginName/update', adminMiddleware, async (req, res) => {
    try {
      res.json(await updateSinglePlugin(req.params.pluginName));
    } catch (err) {
      logger.error('PLUGIN', createReqId(), `Update plugin ${req.params.pluginName} error`, { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 保存插件配置
  app.put('/api/plugins/:pluginName/config', adminMiddleware, async (req, res) => {
    try {
      res.json(await savePluginConfigEntry(req.params.pluginName, req.body));
    } catch (err) {
      logger.error('PLUGIN', createReqId(), `Save plugin config error for ${req.params.pluginName}`, { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 启用/禁用插件
  app.post('/api/plugins/:pluginName/toggle', adminMiddleware, async (req, res) => {
    try {
      res.json(await togglePlugin(req.params.pluginName, req.body && req.body.enabled));
    } catch (err) {
      logger.error('PLUGIN', createReqId(), `Toggle plugin ${req.params.pluginName} error`, { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 调整插件顺序：body = { order: [pluginName, ...] }
  app.post('/api/plugins/reorder', adminMiddleware, async (req, res) => {
    try {
      res.json(await reorderPlugins(req.body && req.body.order));
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Reorder plugins error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 删除插件
  app.delete('/api/plugins/:pluginName', adminMiddleware, async (req, res) => {
    try {
      res.json(await deletePlugin(req.params.pluginName));
    } catch (err) {
      logger.error('PLUGIN', createReqId(), `Delete plugin ${req.params.pluginName} error`, { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 获取插件详情（含配置）：仅管理员可查，避免普通用户探测插件内部配置
  app.post('/api/plugins/info', adminMiddleware, async (req, res) => {
    try {
      const plugin = req.body && req.body.plugin;
      if (!plugin) {
        return res.json({ success: false, error: '缺少插件名称' });
      }
      const info = await loadPluginDetail(plugin);
      if (info) {
        res.json({ success: true, data: info });
      } else {
        res.json({ success: false, error: '插件不存在或加载失败' });
      }
    } catch (err) {
      logger.error('PLUGIN', createReqId(), 'Get plugin info error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
  // 从插件导入单曲：调用插件的 importMusicItem 方法
  app.post('/api/plugins/:pluginName/import-music-item', adminMiddleware, async (req, res) => {
    const { pluginName } = req.params;
    const { url } = req.body;
    const reqId = createReqId();
    if (!url) {
      return res.json({ success: false, error: '缺少 url 参数' });
    }
    try {
      const userVars = userConfigs.default || {};
      const result = await runPlugin(pluginName, 'importMusicItem', [url], userVars, ctx.PLUGINS_DIR, reqId);
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('PLUGIN', reqId, 'Import music item failed', { plugin: pluginName, error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 从插件导入歌单：调用插件的 importMusicSheet 方法，并把结果写入「我的歌单」
  app.post('/api/plugins/:pluginName/import-music-sheet', adminMiddleware, async (req, res) => {
    const { pluginName } = req.params;
    const { url } = req.body;
    const reqId = createReqId();
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.json({ success: false, error: '未获取到用户身份' });
    }
    if (!url) {
      return res.json({ success: false, error: '缺少 url 参数' });
    }
    try {
      const userVars = userConfigs.default || {};
      const sheet = await runPlugin(pluginName, 'importMusicSheet', [url], userVars, ctx.PLUGINS_DIR, reqId);

      // 鲁棒解析插件返回（不同插件的 importMusicSheet 返回结构不一致）
      const list = Array.isArray(sheet)
        ? sheet
        : (sheet && (sheet.musicList || sheet.list || sheet.songs || sheet.tracks || sheet.data)) || [];
      if (!Array.isArray(list)) {
        return res.json({ success: false, error: '插件未返回有效的歌单数据' });
      }
      const title = (sheet && (sheet.title || sheet.name || sheet.sheetName)) || `${pluginName} 导入歌单`;
      const cover = sheet && (sheet.coverImg || sheet.cover || sheet.pic || sheet.artwork);

      // 在「我的歌单」下创建歌单，并逐首加入
      const playlist = await database.createUserPlaylist(userId, title, '', cover || '', false);
      let added = 0;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || typeof item !== 'object') continue;
        const music = { ...item };
        // 保证 music_id 存在，避免入库冲突
        if (music.id == null || music.id === '') {
          music.id = `${pluginName}_${i}_${music.title || ''}_${music.artist || ''}`;
        }
        try {
          await database.addSongToUserPlaylist(userId, playlist.id, music, pluginName);
          added++;
        } catch (e) {
          logger.warn('PLUGIN', reqId, 'Add imported song failed', { plugin: pluginName, error: logger.formatError(e) });
        }
      }

      logger.info('PLUGIN', reqId, 'Import music sheet to my playlists', { userId, plugin: pluginName, playlistId: playlist.id, title, added });
      res.json({ success: true, data: { playlistId: playlist.id, title, total: list.length, added } });
    } catch (err) {
      logger.error('PLUGIN', reqId, 'Import music sheet failed', { plugin: pluginName, error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
};

module.exports.updateAllPlugins = updateAllPlugins;
