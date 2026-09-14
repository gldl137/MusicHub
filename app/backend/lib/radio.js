'use strict';

/**
 * 电台数据收集
 * 数据源：扫描 plugins 目录下所有已安装插件，筛选 supportedSearchType 含 'station'
 * 的插件，合并为统一结构。
 *
 * 电台插件「最小规范」：插件只需平铺罗列电台数据，无需按维度分组，也无需实现任何
 * 方法（getTopLists / getMediaSource 由后端 ensureStationMethods 自动补齐）。
 * 后端会按每条电台自带的 province / categories / network 自动归到「省市台 / 分类 / 网络台」
 * 三个维度并合并展示。支持的写法（推荐用 0，最直观）：
 *
 * 0) 平铺数组（推荐，最简）：一家电台一条记录，每条自带它属于哪个省/分类/网络台。
 *    插件里不按维度分组，加电台就是往数组追加一条；无需 platform / supportedSearchType 等声明：
 *   module.exports = {
 *     "stations": [
 *       { "id":"cnr1", "name":"中国之声", "url":"...", "province":"", "categories":["资讯台"], "network":"中央台", "bitrate":128 },
 *       { "id":"lo19", "name":"湖北经典音乐广播", "url":"...", "province":"湖北", "categories":["音乐台"], "network":"", "bitrate":64 },
 *       ...
 *     ]
 *   };
 *   province 用于「省市台」；categories（数组）用于「分类」；network 用于「网络台」。
 *   一家电台可同时属于多个维度：在 categories 里写多个、或分别设 province 与 network 即可。
 *   想再加一个电台源？再建一个插件文件、往 stations 里填数据即可，项目自动读取合并。
 *
 * 1) 直接导出数组（更极简）：module.exports 直接就是平铺电台数组，同上每条记录的字段。
 *
 * 2) 兼容旧写法：省市台 / 分类 / 网络台 三个顶层键分区（不推荐，已改为平铺优先）。
 *
 * 供两类消费方复用：
 *   1) 前端内部接口 /api/radio/stations（带 plugin 字段，供前端播放定位来源）
 *   2) OpenSubsonic /rest/getInternetRadioStations（映射为 internetRadioStation 字段）
 */

const config = require('./config');
const ctx = require('./context');

/**
 * 判断插件是否为电台插件。以下任一情况即被识别为电台源，作者按需选择最简形式：
 *   1) 显式声明 supportedSearchType 含 'station'
 *   2) module.exports 直接是一个平铺的电台数组（一条记录 = 一家电台，自带 province/categories/network）
 *   3) 插件以 stations 平铺数组提供电台（推荐最简写法：{ stations: [ ... ] }）
 *   4) 兼容旧写法：省市台 / 分类 / 网络台 三个顶层键分区
 * 平铺格式无需按维度分组，加电台就是往数组里追加一条记录，最方便。
 */
function isStationPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return false;
  const types = Array.isArray(plugin.supportedSearchType) ? plugin.supportedSearchType : [];
  if (types.includes('station')) return true;
  // 便捷判定 1：module.exports 直接是平铺的电台数组
  if (Array.isArray(plugin) && plugin.some((s) => s && (s.url || s.id))) return true;
  // 便捷判定 2：插件以 stations 平铺数组提供电台（每条自带 province/categories/network）
  if (Array.isArray(plugin.stations) && plugin.stations.some((s) => s && (s.url || s.id))) return true;
  // 兼容旧格式：省市台 / 分类 / 网络台 三个顶层键分区
  if (isSectionFormat(plugin)) return true;
  return false;
}

/**
 * 把插件返回的电台项映射为统一结构。
 * 丢弃无播放地址的电台（无法播放）。
 */
// 稳定 id：优先用显式 id；省略时按「插件名:电台名」生成。
// 重排/插队都不改变该 id，因此用户收藏不会因调整顺序而丢失。
// 生成规则必须与 findStationInData 保持一致，否则省略 id 的电台将无法通过 id 找回播放地址。
function stationStableId(raw, pluginName) {
  if (raw && raw.id != null) return String(raw.id);
  const name = raw && (raw.name || raw.title) ? String(raw.name || raw.title) : 'unknown';
  return `${pluginName}:${name}`;
}

function mapStation(raw, pluginName) {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || raw.streamUrl || raw.playUrl || raw.src || '';
  if (!url) return null;
  return {
    id: stationStableId(raw, pluginName),
    name: raw.name || raw.title || '未知电台',
    url,
    homepageUrl: raw.homepageUrl || raw.homepage || raw.site || '',
    region: raw.region || '',
    province: raw.province || raw.region || '',
    genre: raw.genre || '',
    categories: Array.isArray(raw.categories) ? raw.categories : (raw.category ? [raw.category] : []),
    network: raw.network || '',
    bitrate: raw.bitrate || 0,
    isLive: true,
    plugin: pluginName
  };
}

// 将原始电台项归一化为统一字段（兼容 stations 数据缺省项）
function normalizeStationData(raw) {
  return {
    id: raw.id,
    name: raw.name || '未知电台',
    url: raw.url || raw.streamUrl || raw.playUrl || raw.src || '',
    region: raw.region || '',
    province: raw.province || raw.region || '',
    genre: raw.genre || '',
    categories: Array.isArray(raw.categories) ? raw.categories : (raw.category ? [raw.category] : []),
    network: raw.network || '',
    bitrate: raw.bitrate || 128,
    isLive: true
  };
}

// 三态菜单维度定义：key 对应 station 字段，title 为前端 Tab 显示名
const DIMENSIONS = [
  { key: 'province', title: '省市台', emoji: '📍' },
  { key: 'categories', title: '分类', emoji: '🎼' },
  { key: 'network', title: '网络台', emoji: '🌐' }
];

// 各维度子项展示顺序（与蜻蜓 FM 参考图保持一致），未列出的按拼音排末尾
const PROVINCE_ORDER = [
  '北京','天津','河北','上海','山西','内蒙古','辽宁','吉林','黑龙江','江苏','浙江',
  '安徽','福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川',
  '贵州','云南','西藏','陕西','甘肃','青海','宁夏','新疆'
];
const CATEGORY_ORDER = [
  '资讯台','音乐台','交通台','经济台','文艺台','都市台','体育台','双语台','综合台',
  '生活台','旅游台','曲艺台','方言台'
];
const NETWORK_ORDER = ['中央台','AsiaFM','电视伴音'];

function sortDimensionItems(items, dimKey) {
  const order = dimKey === 'province' ? PROVINCE_ORDER
    : dimKey === 'categories' ? CATEGORY_ORDER
    : dimKey === 'network' ? NETWORK_ORDER
    : [];
  const indexOf = (v) => { const idx = order.indexOf(v); return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER; };
  return items.slice().sort((a, b) => {
    const ia = indexOf(a), ib = indexOf(b);
    if (ia !== ib) return ia - ib;
    return String(a).localeCompare(String(b), 'zh-CN');
  });
}

// 由平铺数组按维度构建分组（省市台/分类/网络台）
function buildDimensionGroups(stations) {
  const groups = [];
  for (const dim of DIMENSIONS) {
    const buckets = new Map();
    for (const s of stations) {
      let values;
      if (dim.key === 'categories') {
        values = Array.isArray(s.categories) ? s.categories.filter(Boolean) : [];
      } else {
        const v = s[dim.key];
        values = v ? [String(v)] : [];
      }
      // 省市台维度不展示「全国」聚合（全国电台已归入「分类」维度）
      if (dim.key === 'province') {
        values = values.filter(v => v !== '全国');
      }
      for (const v of values) {
        if (!buckets.has(v)) buckets.set(v, []);
        buckets.get(v).push(s);
      }
    }
    const sortedKeys = sortDimensionItems([...buckets.keys()], dim.key);
    for (const v of sortedKeys) {
      groups.push({
        title: `${dim.title} / ${v}`,
        dimension: dim.title,
        subTitle: v,
        emoji: dim.emoji,
        cover: '',
        data: buckets.get(v)
      });
    }
  }
  return groups;
}

// 新格式（推荐）：插件直接以 省市台/分类/网络台 三个顶层键分区，值为 { 子分组: [station,...] }
const SECTION_DIM_KEYS = ['省市台', '分类', '网络台'];
const SECTION_DIM_EMOJI = { '省市台': '📍', '分类': '🎼', '网络台': '🌐' };
function isSectionFormat(plugin) {
  return SECTION_DIM_KEYS.some((k) => plugin[k] && typeof plugin[k] === 'object' && !Array.isArray(plugin[k]));
}
function sectionDimKey(title) {
  return title === '省市台' ? 'province' : title === '分类' ? 'categories' : 'network';
}
// 直接按三个维度顶层键构建分组（子分组顺序按既定 ORDER 排列）
function buildGroupsFromSections(plugin) {
  const groups = [];
  for (const dimTitle of SECTION_DIM_KEYS) {
    const section = plugin[dimTitle];
    if (!section || typeof section !== 'object') continue;
    const sortedSubs = sortDimensionItems(Object.keys(section), sectionDimKey(dimTitle));
    for (const sub of sortedSubs) {
      const list = Array.isArray(section[sub]) ? section[sub] : [];
      if (!list.length) continue;
      groups.push({
        title: `${dimTitle} / ${sub}`,
        dimension: dimTitle,
        subTitle: sub,
        emoji: SECTION_DIM_EMOJI[dimTitle] || '',
        cover: '',
        data: list.map(normalizeStationData)
      });
    }
  }
  return groups;
}

// 由插件 stations 数据构建分组结构
// stations 支持两种形态：
//   - 数组：带 province/categories/network 的平铺电台，按三态维度分组
//   - 对象：{ 分组名: [电台, ...] } 的旧格式
function buildGroupsFromStations(plugin) {
  // 新格式（推荐）优先：插件以 省市台/分类/网络台 三个顶层键分区
  if (isSectionFormat(plugin)) return buildGroupsFromSections(plugin);
  const raw = plugin.stations || plugin.STATIONS;
  if (Array.isArray(raw)) {
    return buildDimensionGroups(raw.map(normalizeStationData));
  }
  const stations = raw || {};
  const meta = plugin.groupMeta || {};
  return Object.keys(stations).map(group => {
    const m = meta[group] || {};
    return {
      title: group + '电台',
      cover: m.cover || '',
      emoji: m.emoji || '📻',
      data: (stations[group] || []).map(normalizeStationData)
    };
  });
}

// 在 stations 数据中按 id 查找原始项（兼容数组与对象两种格式）。
// 同时支持显式 id 与「插件名:电台名」自动生成的稳定 id（与 mapStation 同一规则），
// 这样省略 id 的新电台也能被前端回传的 id 正确找回播放地址。
function findStationInData(plugin, id, pluginName) {
  const match = (st) => st && (st.id === id || stationStableId(st, pluginName) === id);
  // 新格式：stations 分布在 省市台/分类/网络台 三个维度对象里
  if (isSectionFormat(plugin)) {
    for (const dimTitle of SECTION_DIM_KEYS) {
      const section = plugin[dimTitle];
      if (!section || typeof section !== 'object') continue;
      for (const list of Object.values(section)) {
        if (Array.isArray(list)) {
          const s = list.find(match);
          if (s) return s;
        }
      }
    }
    return null;
  }
  const raw = plugin.stations || plugin.STATIONS || {};
  if (Array.isArray(raw)) return raw.find(match) || null;
  for (const list of Object.values(raw)) {
    const s = (list || []).find(match);
    if (s) return s;
  }
  return null;
}

/**
 * 为「最小规范」电台插件补齐方法（仅当插件未自行实现时）。
 * 这样插件只需提供 stations 数据，getTopLists / getMediaSource 由后端统一实现。
 */
function ensureStationMethods(plugin, pluginName) {
  if (typeof plugin.getTopLists !== 'function') {
    plugin.getTopLists = async function () {
      return buildGroupsFromStations(plugin);
    };
  }
  if (typeof plugin.getMediaSource !== 'function') {
    plugin.getMediaSource = async function (station) {
      if (!station || !station.id) throw new Error('电台信息不完整');
      const full = findStationInData(plugin, station.id, pluginName);
      if (!full) throw new Error('电台不存在: ' + station.id);
      const url = full.url || full.streamUrl || full.playUrl || full.src || '';
      if (!url) throw new Error('电台地址缺失: ' + station.id);
      return {
        url,
        bitrate: full.bitrate || 128,
        format: url.includes('.m3u8') ? 'm3u8' : 'mp3',
        isLive: true
      };
    };
  }
}

/**
 * 收集所有电台插件的电台数据（按插件内部分组聚合）。
 *
 * 每个插件调用 getTopLists() 应返回形如：
 *   [ { title, cover?, emoji?, data: [ station, ... ] }, ... ]
 * 其中 station 至少含播放地址（url/streamUrl）。
 *
 * @returns {Promise<Array<{plugin:string, platform:string, file:string, enabled:boolean, groups:Array<{title:string, cover:string, emoji:string, stations:Array}>}>>}
 */
async function collectRadioPlugins() {
  const out = [];
  try {
    const PLUGINS_DIR = ctx.PLUGINS_DIR;
    const files = ctx.listPluginNames(PLUGINS_DIR);
    let allConfig = {};
    try { allConfig = config.loadPluginConfig() || {}; } catch (e) { allConfig = {}; }

    for (const file of files) {
      let plugin = null;
      try {
        const pluginPath = ctx.resolvePluginFilePath(PLUGINS_DIR, file);
        if (!pluginPath) continue;
        plugin = ctx.loadPluginModule(pluginPath);
      } catch (e) {
        continue;
      }
      if (!plugin || !isStationPlugin(plugin)) continue;
      // 直接导出的平铺数组（module.exports = [ ... ]）统一包成 { stations }，便于后续统一处理
      if (Array.isArray(plugin)) plugin = { stations: plugin };
      const pluginName = plugin.platform || file;
      // 最小规范的电台插件只需提供 stations 数据；后端自动补齐 getTopLists / getMediaSource
      ensureStationMethods(plugin, pluginName);

      try {
        const cfg = allConfig[file] || {};
        const enabled = cfg.enabled !== false;
        const categories = await Promise.resolve(plugin.getTopLists());
        const groups = [];
        if (Array.isArray(categories)) {
          for (const cat of categories) {
            const isObj = cat && typeof cat === 'object' && !Array.isArray(cat);
            const title = isObj && cat.title ? String(cat.title) : (pluginName + ' 电台');
            const cover = isObj && (cat.cover || cat.logo) ? String(cat.cover || cat.logo) : '';
            const emoji = isObj && cat.emoji ? String(cat.emoji) : '';
            const dimension = isObj && cat.dimension ? String(cat.dimension) : '';
            const subTitle = isObj && cat.subTitle ? String(cat.subTitle) : '';
            const list = Array.isArray(cat) ? cat : (isObj && Array.isArray(cat.data) ? cat.data : []);
            const stations = [];
            for (const raw of list) {
              const st = mapStation(raw, pluginName);
              if (st) {
                st.group = title;
                st.groupCover = cover;
                st.groupEmoji = emoji;
                st.dimension = dimension;
                st.subTitle = subTitle;
                stations.push(st);
              }
            }
            if (stations.length) groups.push({ title, cover, emoji, dimension, subTitle, stations });
          }
        }
        out.push({ plugin: pluginName, platform: plugin.platform || pluginName, file, enabled, groups });
      } catch (e) {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn('RADIO', 'collect', `Failed to collect stations from ${file}`, { error: e && e.message });
        }
      }
    }
  } catch (e) {
    if (ctx.logger && typeof ctx.logger.error === 'function') {
      ctx.logger.error('RADIO', 'collect', 'collectRadioPlugins error', { error: e && e.message });
    }
  }
  return out;
}

// ==================== 电台收藏（全站共享，不按用户隔离；统一以 user_id=0 读写）====================
const _radioFs = ctx.fs;
const _radioPath = ctx.path;
const LEGACY_FAV_FILE = _radioPath.join(ctx.DATA_DIR, 'radio-favorites.json');
// “我的电台”为全站共享：所有用户读写同一份收藏，忽略请求用户身份
const SHARED_FAV_USER_ID = 0;

function favFileFor(userId) {
  const id = userId != null ? String(userId) : 'default';
  return _radioPath.join(ctx.DATA_DIR, `radio-favorites-${id}.json`);
}

async function getRadioFavorites(_userId) {
  const db = databaseModule();
  if (db && typeof db.getRadioFavoritesDB === 'function') {
    try { return await db.getRadioFavoritesDB(SHARED_FAV_USER_ID); } catch (e) { /* 降级到文件 */ }
  }
  // 降级：数据库不可用时从文件读取
  try {
    const file = favFileFor(SHARED_FAV_USER_ID);
    if (_radioFs.existsSync(file)) {
      const arr = JSON.parse(_radioFs.readFileSync(file, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
    // 兼容旧版全局文件（首次迁移，避免已有收藏丢失）
    if (_radioFs.existsSync(LEGACY_FAV_FILE)) {
      const arr = JSON.parse(_radioFs.readFileSync(LEGACY_FAV_FILE, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
    return [];
  } catch (e) { return []; }
}

async function saveRadioFavorites(list, _userId) {
  const db = databaseModule();
  if (db && typeof db.setRadioFavoritesDB === 'function') {
    try { return await db.setRadioFavoritesDB(SHARED_FAV_USER_ID, list); } catch (e) { /* 降级到文件 */ }
  }
  // 降级：数据库不可用时写入文件
  try {
    if (!_radioFs.existsSync(ctx.DATA_DIR)) _radioFs.mkdirSync(ctx.DATA_DIR, { recursive: true });
    _radioFs.writeFileSync(favFileFor(SHARED_FAV_USER_ID), JSON.stringify(list, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

// 惰性引入 database：避免与 sqlite3 初始化产生启动期耦合（电台表不可用时降级为空列表）
let _dbModule;
function databaseModule() {
  if (_dbModule === undefined) {
    try { _dbModule = require('../database'); } catch (e) { _dbModule = null; }
  }
  return _dbModule;
}

/**
 * 未分类电台：电台库里 province / category / network 三个维度均为空的电台。
 * 判定口径与前端电台页 /api/radio/stations 的 buildRadioResponse 完全一致。
 */
function isUncategorizedStation(s) {
  return !!(s && !s.province && !s.category && !s.network);
}

// 归一化为 OpenSubsonic internetRadioStation 结构（logo 仅输出客户端可直接访问的 http(s) 地址）
function toInternetRadioStation(s, fallbackDimension, fallbackGroup, idOverride) {
  const logo = String(s.logo || s.artwork || s.coverUrl || s.cover_url || '');
  return {
    id: String(idOverride != null ? idOverride : s.id),
    name: s.name || '未知电台',
    streamUrl: s.url || s.streamUrl || '',
    homepageUrl: s.homepageUrl || undefined,
    logo: /^https?:\/\//i.test(logo) ? logo : '',
    dimension: s.dimension || fallbackDimension || undefined,
    group: s.group || fallbackGroup || undefined
  };
}

/**
 * 按真实 radio.id 读取电台行（OpenSubsonic getCoverArt radio-<id> 等场景复用它拿 name / cover_url）。
 * 数据库不可用或 id 非法时返回 null。
 */
async function getRadioStationById(id) {
  const db = databaseModule();
  if (!db || typeof db.getRadioStationByIdDB !== 'function') return null;
  const sid = parseInt(id, 10);
  if (!Number.isFinite(sid)) return null;
  try { return await db.getRadioStationByIdDB(sid); } catch (e) { return null; }
}

/**
 * OpenSubsonic getInternetRadioStations（方案 1：真实 radio.id + group 标记）
 * 仅返回两部分，保持列表精简：
 *   - 收藏电台：group = "收藏"（按 name / streamUrl 匹配库里真实电台，用真实 id）
 *   - 未分类电台（省市台/分类/网络台 三维皆空且未收藏）：group = "未分类"
 * 带维度的非收藏电台（custom）仅计入日志统计，不返回。
 * 收藏关系以 name / streamUrl 归一化匹配库里真实电台，规避前端电台页不稳定的 id 体系。
 * 日志输出 { total, favorite, uncategorized, custom }。
 */
function normalizeRadioUrl(u) {
  u = String(u || '').trim().toLowerCase();
  if (!u) return '';
  return u.replace(/\/+$/, '');
}

async function getInternetRadioStations(userId) {
  const db = databaseModule();
  const fallback = async () => (await getRadioFavorites(userId)).map((s) => toInternetRadioStation(s, '收藏', '收藏'));
  if (!db || typeof db.getRadioStationsDB !== 'function') return await fallback();

  let stations = [];
  try {
    stations = await db.getRadioStationsDB();
  } catch (e) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'Failed to load radio stations', { error: e && e.message });
    }
    return await fallback();
  }
  if (!Array.isArray(stations)) return await fallback();

  // 该用户收藏（按 name 匹配库里真实电台，避免依赖前端不稳定的 id；
  // 不用 url 匹配，以防不同电台共用同一 streamUrl 被误判为收藏）
  const favNameKeys = new Set();
  for (const s of await getRadioFavorites(userId)) {
    const nm = String(s.name || '').trim().toLowerCase();
    if (nm) favNameKeys.add(nm);
  }

  const isFavStation = (s) => favNameKeys.has(String(s.name || '').trim().toLowerCase());

  const list = [];
  let favorite = 0, uncategorized = 0, custom = 0;
  // 1) 收藏：匹配库真实电台，使用真实 radio.id
  for (const s of stations) {
    if (!isFavStation(s)) continue;
    list.push(toInternetRadioStation(s, '收藏', '收藏', String(s.id)));
    favorite++;
  }
  // 2) 未分类：三维皆空且未收藏（custom = 带维度且未收藏，三者互斥）
  for (const s of stations) {
    if (isFavStation(s)) continue;
    if (s.province || s.category || s.network) { custom++; continue; }
    list.push(toInternetRadioStation(s, '未分类', '未分类', String(s.id)));
    uncategorized++;
  }

  if (ctx.logger && typeof ctx.logger.debug === 'function') {
    ctx.logger.debug('RADIO', 'stations', 'getInternetRadioStations', { total: stations.length, favorite, uncategorized, custom });
  }
  return list;
}

/**
 * 创建电台（OpenSubsonic createInternetRadioStation）
 * 仅接收 name + streamUrl，写入 radio_stations 且 province/category/network 皆空 => 归入「未分类」。
 * @returns {object|null} 新建电台行（含真实 id），失败返回 null
 */
async function createInternetRadioStation(_userId, input) {
  const db = databaseModule();
  if (!db || typeof db.createRadioStation !== 'function') {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'createInternetRadioStation not supported (database unavailable)');
    }
    return null;
  }
  const name = String((input && input.name) || '').trim();
  const streamUrl = String((input && (input.streamUrl || input.url)) || '').trim();
  if (!name || !streamUrl) return null;

  try {
    const station = await db.createRadioStation({ name, url: streamUrl });
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('RADIO', 'stations', 'createInternetRadioStation', { id: station && station.id, name });
    }
    return station;
  } catch (e) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'createInternetRadioStation failed', { error: e && e.message });
    }
    return null;
  }
}

/**
 * 删除电台（OpenSubsonic deleteInternetRadioStation）
 * id 为库真实 radio.id。返回是否成功删除。
 */
async function deleteInternetRadioStation(_userId, id) {
  const db = databaseModule();
  if (!db || typeof db.deleteRadioStation !== 'function') {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'deleteInternetRadioStation not supported (database unavailable)');
    }
    return false;
  }
  const stationId = parseInt(id, 10);
  if (!stationId) return false;
  try {
    await db.deleteRadioStation(stationId);
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('RADIO', 'stations', 'deleteInternetRadioStation', { id: stationId });
    }
    return true;
  } catch (e) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'deleteInternetRadioStation failed', { error: e && e.message });
    }
    return false;
  }
}

/**
 * 更新电台（OpenSubsonic updateInternetRadioStation）
 * 仅支持修改 name 与 streamUrl（url），其余字段（分类等）保持不动。
 * @returns {object|null} 更新后的电台行，失败返回 null
 */
async function updateInternetRadioStation(_userId, id, input) {
  const db = databaseModule();
  if (!db || typeof db.updateRadioStation !== 'function') {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'updateInternetRadioStation not supported (database unavailable)');
    }
    return null;
  }
  const stationId = parseInt(id, 10);
  if (!stationId) return null;
  const data = {};
  if (input && input.name !== undefined) data.name = String(input.name).trim();
  if (input && (input.streamUrl !== undefined || input.url !== undefined)) {
    data.url = String(input.streamUrl !== undefined ? input.streamUrl : input.url).trim();
  }
  if (!Object.keys(data).length) return null;
  try {
    const station = await db.updateRadioStation(stationId, data);
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('RADIO', 'stations', 'updateInternetRadioStation', { id: stationId, name: data.name, fields: Object.keys(data) });
    }
    return station;
  } catch (e) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'updateInternetRadioStation failed', { error: e && e.message });
    }
    return null;
  }
}

/**
 * 重排某分组（维度 + 子项）内电台顺序。
 * @param {string} dimension 维度名（省市台 / 分类 / 网络台 / 未分组）
 * @param {string} subTitle 子项名（如 北京）
 * @param {string[]} orderedIds 该子项内电台的新 id 顺序
 */
async function reorderRadioStationsGroup(dimension, subTitle, orderedIds) {
  const db = databaseModule();
  if (!db || typeof db.reorderRadioStationsGroup !== 'function') {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'reorderRadioStationsGroup not supported (database unavailable)');
    }
    return false;
  }
  try {
    const ok = await db.reorderRadioStationsGroup(dimension, subTitle, orderedIds);
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('RADIO', 'stations', 'reorderRadioStationsGroup', { dimension, subTitle, count: (orderedIds || []).length });
    }
    return ok;
  } catch (e) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('RADIO', 'stations', 'reorderRadioStationsGroup failed', { error: e && e.message });
    }
    return false;
  }
}

module.exports = { collectRadioPlugins, getInternetRadioStations, getRadioStationById, createInternetRadioStation, deleteInternetRadioStation, updateInternetRadioStation, reorderRadioStationsGroup, getRadioFavorites, saveRadioFavorites, isStationPlugin, mapStation, ensureStationMethods };
