'use strict';

/**
 * 洛雪专区 - 各平台「官方榜单分类」获取
 * ================================================================
 * 落雪内置 SDK 的 getBoards() 返回扁平列表、不带分类；各平台**官方**其实都
 * 提供了分类，只是入口不同。本模块按平台从官方接口/页面获取分类与榜单：
 *
 *   kw 酷我：PC 官网 window.__NUXT__ → data[0].bangMenu[] {name, list:[{name,sourceid,pic,intro,pub}]}
 *            （移动端 H5 的 ranktype 只有 3 组，缺「语言/全球」，仅作兜底）
 *   kg 酷狗：网页 rank.html 的 pc_rank_sidebar 分块          {title, [{name,rankid}]}
 *   tx QQ  ：u.y.qq.com musicu.fcg ToplistInfoServer.GetAll  {groupName, toplist:[{title,topId}]}
 *   wy 网易：网页 discover/toplist 的 h2 分块（id 用 SDK 榜单名映射）
 *   mg 咪咕：SDK getBoardsData() → data.contents[].style
 *
 * 统一输出：[{ title, data: [{ id, name, bangid }] }]
 */

const vm = require('vm');
const axios = require('axios');
const logger = require('../core/logger');

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const REQ_TIMEOUT = 15000;

// 内存缓存：仅用于抗抖动（短 TTL），保证分类与官网实时一致
const CACHE_TTL = 60 * 1000;
const cache = new Map();

async function fetchText(url, { ua = PC_UA, referer = '' } = {}) {
  const r = await axios.get(url, {
    headers: { 'User-Agent': ua, Referer: referer, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: REQ_TIMEOUT,
    responseType: 'text',
    validateStatus: () => true,
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return typeof r.data === 'string' ? r.data : String(r.data);
}

async function fetchJson(url, { referer = '' } = {}) {
  const r = await axios.get(url, {
    headers: { 'User-Agent': PC_UA, Referer: referer },
    timeout: REQ_TIMEOUT,
    responseType: 'text',
    validateStatus: () => true,
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  let b = r.data;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      // 咪咕等接口返回非严格 JSON（对象/数组尾逗号），做一次宽松解析
      b = JSON.parse(b.replace(/,\s*([\]}])/g, '$1'));
    }
  }
  return b;
}

// ---------------------------------------------------------------- 酷我

/** 从 HTML 中解出 window.__NUXT__（Nuxt SSR 数据） */
function extractNuxt(html) {
  const m = html.match(/window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (!m) throw new Error('未找到 __NUXT__ 数据');
  const sandbox = { window: {}, console: { log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(`window.__NUXT__=${m[1]}`, sandbox, { timeout: 8000 });
  return sandbox.window.__NUXT__;
}

/**
 * 酷我 **PC 官网**榜单分类（与官网页面完全一致）
 * https://www.kuwo.cn/rankList → window.__NUXT__.data[0].bangMenu
 * [{ name:'官方'|'特色'|'场景'|'语言'|'全球', list:[{sourceid,name,pic,intro,pub}] }]
 * 注意：移动端 H5（m.kuwo.cn）只有「官方/特色/场景」3 组，会少「语言」「全球」等，故以 PC 为准。
 */
async function kwGroupsPC() {
  const html = await fetchText('https://www.kuwo.cn/rankList', { referer: 'https://www.kuwo.cn/' });
  const nuxt = extractNuxt(html);
  const d0 = nuxt && Array.isArray(nuxt.data) ? nuxt.data[0] : null;
  const menu = d0 && d0.bangMenu;
  if (!Array.isArray(menu)) throw new Error('bangMenu 结构异常');
  return menu.map((g) => ({
    title: g.name || '',
    data: (g.list || []).map((b) => ({
      id: 'kw__' + b.sourceid,
      name: b.name,
      bangid: String(b.sourceid),
      pic: b.pic || '',
      update: b.pub || '',
    })),
  })).filter((g) => g.data.length);
}

/** 酷我移动端 H5 榜单分类（PC 官网取不到时的兜底） */
async function kwGroupsH5() {
  const html = await fetchText('https://m.kuwo.cn/newh5app/ranklist', { ua: MOBILE_UA, referer: 'https://m.kuwo.cn/' });
  const nuxt = extractNuxt(html);
  const ranktype = nuxt && nuxt.data && nuxt.data[0] && nuxt.data[0].ranktype;
  if (!Array.isArray(ranktype)) throw new Error('ranktype 结构异常');
  return ranktype.map((rt) => ({
    title: rt.name || '',
    data: (rt.list || []).map((b) => ({ id: 'kw__' + b.sourceid, name: b.name, bangid: String(b.sourceid), pic: b.pic || '' })),
  })).filter((g) => g.data.length);
}

async function kwGroups() {
  try {
    const groups = await kwGroupsPC();
    if (groups.length) return groups;
  } catch (e) {
    logger.warn('LX', 'lx-official', `酷我 PC 官网榜单分类失败，回退移动端：${e.message}`);
  }
  return kwGroupsH5();
}

// ---------------------------------------------------------------- 酷狗
async function kgGroups() {
  // 网页提供「分类 + 榜单」，官方 API 提供各榜单封面（imgurl，含 {size} 占位）
  const [html, api] = await Promise.all([
    fetchText('https://www.kugou.com/yy/html/rank.html', { referer: 'https://www.kugou.com/' }),
    fetchJson('http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1').catch(() => null),
  ]);
  const picByRank = new Map();
  const info = api && api.data && api.data.info;
  if (Array.isArray(info)) {
    info.forEach((it) => {
      if (it && it.rankid != null) {
        // {size} 用 400：与酷狗官网（m.kugou.com/rank/list 的 _src）完全一致；
        // 之前用 150 是缩略图，在卡片上放大后明显发虚、与官网不符。
        const pic = (it.imgurl || it.img_9 || it.img_cover || '').replace('{size}', '400');
        picByRank.set(String(it.rankid), pic);
      }
    });
  }

  // 必须先剔除 HTML 注释：酷狗会把**已下线**的榜单注释掉（如「酷音乐流行风向标」，
  // 页面上并不展示），直接正则会把注释里的 <a> 也解析出来，导致比官网多出几条。
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');

  const groups = [];
  for (const block of visible.split('pc_rank_sidebar').slice(1)) {
    const title = (block.match(/title="([^"]+)"/) || [])[1];
    if (!title) continue;
    const seen = new Set();
    const data = [];
    for (const mm of block.matchAll(/<a[^>]*title="([^"]+)"[^>]*href="[^"]*1-(\d+)\.html/g)) {
      const name = mm[1];
      const rankid = mm[2];
      if (seen.has(rankid)) continue;
      seen.add(rankid);
      data.push({ id: 'kg__' + rankid, name, bangid: rankid, pic: picByRank.get(rankid) || '' });
    }
    if (data.length) groups.push({ title, data });
  }

  // 补齐 rank/list 里没有的榜单封面（如「蜂鸟流行音乐榜」59703），改用官方 rank/info 接口
  const needPic = groups.flatMap((g) => g.data).filter((b) => !b.pic);
  await Promise.all(needPic.map(async (b) => {
    try {
      const detail = await fetchJson(`http://mobilecdnbj.kugou.com/api/v3/rank/info?rankid=${b.bangid}&plat=0`, { referer: 'https://www.kugou.com/' });
      const img = detail && detail.data && detail.data.imgurl;
      if (img) b.pic = String(img).replace('{size}', '400');
    } catch (e) {
      logger.warn('LX', 'lx-official', `酷狗榜单封面补齐失败(${b.name})：${e.message}`);
    }
  }));

  return groups;
}

// ---------------------------------------------------------------- QQ
async function txGroups() {
  const payload = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    topList: { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} },
  });
  const body = await fetchJson(`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(payload)}`, { referer: 'https://y.qq.com/' });
  const group = body && body.topList && body.topList.data && body.topList.data.group;
  if (!Array.isArray(group)) throw new Error('group 结构异常');
  return group.map((g) => ({
    title: g.groupName || '',
    data: (g.toplist || []).map((t) => ({
      id: 'tx__' + t.topId,
      name: t.title,
      bangid: String(t.topId),
      pic: t.frontPicUrl || t.mbFrontPicUrl || t.headPicUrl || t.mbHeadPicUrl || '',
    })),
  })).filter((g) => g.data.length);
}

// ---------------------------------------------------------------- 网易
async function wyGroups(sdk) {
  const html = await fetchText('https://music.163.com/discover/toplist', { referer: 'https://music.163.com/' });
  // 用 SDK 的官方榜单列表（含 id→名称）映射页面里的 data-res-id
  const infoById = new Map();
  try {
    const res = await sdk.wyLeaderboard.getBoardsData();
    const list = (res && res.body && res.body.list) || [];
    list.forEach((it) => {
      if (it && it.id != null) {
        infoById.set(String(it.id), { name: it.name, pic: it.coverImgUrl || it.iconImageUrl || '' });
      }
    });
  } catch (e) {
    logger.warn('LX', 'lx-official', `网易榜单名映射失败: ${e.message}`);
  }
  const groups = [];
  // 只取官方分类区块（h2.f-ff1），避免把页面里作为榜单标题的 h2 误当成分类
  const re = /<h2[^>]*class="[^"]*f-ff1[^"]*"[^>]*>([^<]+)<\/h2>([\s\S]*?)(?=<h2|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = (m[1] || '').trim();
    if (!title) continue;
    const seen = new Set();
    const data = [];
    for (const idm of m[2].matchAll(/data-res-id="(\d+)"/g)) {
      const resId = idm[1];
      if (seen.has(resId)) continue;
      const info = infoById.get(resId);
      if (!info || !info.name) continue; // 非榜单 id（页面其它区域）直接跳过
      seen.add(resId);
      data.push({ id: 'wy__' + resId, name: info.name, bangid: resId, pic: info.pic || '' });
    }
    if (data.length) groups.push({ title, data });
  }
  return groups;
}

// ---------------------------------------------------------------- 咪咕
async function mgGroups(sdk) {
  const res = await sdk.mgLeaderboard.getBoardsData();
  const contents = res && res.body && res.body.data && res.body.data.contents;
  if (!Array.isArray(contents)) throw new Error('contents 结构异常');
  return contents.map((g) => ({
    title: g.style || '',
    data: (g.contents || []).map((c) => ({ id: 'mg__' + c.rankId, name: c.rankName, bangid: String(c.rankId), pic: c.imageUrl || '' })),
  })).filter((g) => g.data.length);
}

/**
 * 获取某平台的官方榜单分组
 * @param {string} source kw/kg/tx/wy/mg
 * @param {object} sdk 打包后的落雪 SDK（供 wy/mg 复用其请求与加解密）
 * @returns {Promise<Array<{title:string,data:Array}>>}
 */
async function getOfficialGroups(source, sdk) {
  const hit = cache.get(source);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  let groups = [];
  switch (source) {
    case 'kw': groups = await kwGroups(); break;
    case 'kg': groups = await kgGroups(); break;
    case 'tx': groups = await txGroups(); break;
    case 'wy': groups = await wyGroups(sdk); break;
    case 'mg': groups = await mgGroups(sdk); break;
    default: throw new Error(`不支持的平台：${source}`);
  }
  cache.set(source, { data: groups, ts: Date.now() });
  return groups;
}

module.exports = { getOfficialGroups };
