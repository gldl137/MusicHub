/**
 * 企业微信自建应用通知 + 回调模块
 *
 * 功能：
 *  1. 企业微信应用消息发送（text / markdown / news 等），依赖 corpid+corpsecret 获取的 access_token
 *  2. 自定义菜单创建（含固定 EventKey，点击后触发对应操作）
 *  3. 接收企业微信回调：GET 验证（echostr 解密）+ POST 事件（菜单 click 解密分发）
 *
 * 设计说明：
 *  - 配置存 settings 表（key: wecom_app_config），不依赖 server.js，避免循环依赖
 *  - 各触发操作（清理缓存/插件更新/订阅下载/M3U生成）由 server.js 通过 initWecomApp 注入，
 *    因为 server.js 已持有这些逻辑的唯一实例（schedulerManager 等）
 *  - 回调路由（/api/wecom-app/callback）不挂鉴权中间件，必须公网可达
 */

const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const logger = require('./core/logger');
const { getSetting } = require('./database');
const configStore = require('./lib/config');
const { adminMiddleware } = require('./lib/middleware');

const MODULE = 'WECOM_APP';

// 企业微信应用配置统一存储到 config.json 的 wecomApp 字段（与系统设置/插件配置一致）。
// DATA_DIR 与 server.js 保持一致（backend/ 下 __dirname/../data => /app/data）
const WECHAT_API = 'https://qyapi.weixin.qq.com';

// 自定义菜单（一级最多 3 个，二级最多 5 个；企业微信仅支持两级）
// EventKey 固定，回调据此分发到具体操作
// 注意：一级 button 数组长度必须在 [1, 3]，否则企业微信报 40058
const WECOM_MENU = {
  button: [
    // 一级 1：系统（父菜单，收纳清理缓存 / 插件更新）
    {
      name: '系统',
      sub_button: [
        { type: 'click', name: '清理缓存', key: 'MENU_CLEAR_CACHE' },
        { type: 'click', name: '插件更新', key: 'MENU_PLUGIN_UPDATE' }
      ]
    },
    // 一级 2：下载（父菜单，收纳订阅下载 / M3U生成）
    {
      name: '下载',
      sub_button: [
        { type: 'click', name: '订阅下载', key: 'MENU_SUB_DOWNLOAD' },
        { type: 'click', name: 'M3U生成', key: 'MENU_M3U_GEN' }
      ]
    }
  ]
};

// access_token 内存缓存（企业微信限制每日获取次数，必须缓存）
let tokenCache = { token: '', expireAt: 0 };

// 由 server.js 注入的触发器
let deps = {};

function initWecomApp(dependencies) {
  deps = dependencies || {};
  logger.info(MODULE, 'INIT', 'WeCom app module initialized', {
    hasScheduler: !!deps.schedulerManager,
    hasClearCache: !!deps.clearCache,
    hasUpdatePlugins: !!deps.updatePlugins
  });
}

// ==================== 配置存取（统一到 config.json 的 wecomApp 字段） ====================
const DEFAULT_WECOM_APP_CONFIG = configStore.WECOM_APP_DEFAULT;

async function getWecomAppConfig() {
  // 1) 优先从 config.json 读取（已含旧 wecom-app.json 文件迁移）
  const cfg = configStore.getWecomAppConfig();
  if (configStore.hasWecomApp()) {
    return Object.assign({}, DEFAULT_WECOM_APP_CONFIG, cfg);
  }
  // 2) 兜底：尝试从旧 settings 表的 wecom_app_config 迁移（兼容历史数据）
  try {
    const raw = await getSetting('wecom_app_config', null);
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const merged = Object.assign({}, DEFAULT_WECOM_APP_CONFIG, parsed);
      configStore.saveWecomAppConfig(merged);
      logger.info(MODULE, 'CONFIG', 'Migrated wecom_app_config from settings table into config.json');
      return merged;
    }
  } catch (e) {
    logger.error(MODULE, 'CONFIG', 'Migrate wecom_app_config failed', { error: e.message });
  }
  // 3) 无配置：返回默认值
  return Object.assign({}, DEFAULT_WECOM_APP_CONFIG);
}

async function saveWecomAppConfig(cfg) {
  const merged = Object.assign({}, DEFAULT_WECOM_APP_CONFIG, cfg);
  configStore.saveWecomAppConfig(merged);
  // 配置（尤其 corpsecret）变更后，旧 token 失效，清除缓存强制刷新
  tokenCache = { token: '', expireAt: 0 };
  logger.info(MODULE, 'CONFIG', 'WeCom app config saved to config.json');
}

// ==================== access_token ====================
async function getAccessToken(force = false) {
  const cfg = await getWecomAppConfig();
  if (!cfg.corpid || !cfg.corpsecret) {
    throw new Error('企业微信应用未配置 corpid / corpsecret');
  }
  const now = Date.now();
  if (!force && tokenCache.token && tokenCache.expireAt > now + 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const { data } = await axios.get(`${WECHAT_API}/cgi-bin/gettoken`, {
    params: { corpid: cfg.corpid, corpsecret: cfg.corpsecret },
    timeout: 10000
  });
  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }
  tokenCache = {
    token: data.access_token,
    expireAt: now + (data.expires_in || 7200) * 1000
  };
  return tokenCache.token;
}

// ==================== 发送应用消息 ====================
async function sendAppMessage(message) {
  const cfg = await getWecomAppConfig();
  if (!cfg.enabled) {
    throw new Error('企业微信应用通知未启用');
  }
  const token = await getAccessToken();
  const payload = Object.assign(
    { agentid: Number(cfg.agentid), touser: cfg.touser || '@all' },
    message
  );
  const { data } = await axios.post(
    `${WECHAT_API}/cgi-bin/message/send?access_token=${token}`,
    payload,
    { timeout: 10000 }
  );
  if (data.errcode !== 0) {
    throw new Error(`发送应用消息失败: ${data.errcode} ${data.errmsg}`);
  }
  return data;
}

async function sendText(content) {
  return sendAppMessage({ msgtype: 'text', text: { content } });
}

async function sendMarkdown(content) {
  return sendAppMessage({ msgtype: 'markdown', markdown: { content } });
}

// ==================== 自定义菜单 ====================
// 标准菜单固定 EventKey 集合，用于识别“我们创建的”菜单项。
// 合并菜单时仅移除/替换这些标准项，其余一律视为用户自定义菜单并原样保留。
const STANDARD_MENU_KEYS = new Set([
  'MENU_CLEAR_CACHE',
  'MENU_PLUGIN_UPDATE',
  'MENU_SUB_DOWNLOAD',
  'MENU_M3U_GEN'
]);
const STANDARD_MENU_NAMES = new Set(['系统', '下载']);

// 判断某个一级菜单是否属于我们创建的标准菜单（可被我们的标准菜单替换/移除）
function isStandardButton(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.name && STANDARD_MENU_NAMES.has(b.name)) return true;
  if (b.key && STANDARD_MENU_KEYS.has(b.key)) return true;
  if (Array.isArray(b.sub_button) &&
      b.sub_button.some((s) => s && s.key && STANDARD_MENU_KEYS.has(s.key))) {
    return true;
  }
  return false;
}

// 从现有一级菜单数组中剔除我们创建的标准菜单项，保留所有用户自定义项
function stripStandardButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons.filter((b) => !isStandardButton(b));
}

// 将 menu/get 返回的菜单结构清洗为 menu/create 可接受的格式。
// 企业微信 menu/get 会对叶子按钮返回 sub_button:[]，且可能夹杂多余字段，
// 直接回传 menu/create 会被拒绝，因此需要规范化：父菜单只保留 name+sub_button，
// 叶子只保留 name+type+关键字段，并滤除无效项、子项上限 5。
function sanitizeMenu(buttons) {
  if (!Array.isArray(buttons)) return [];
  const out = [];
  for (const b of buttons) {
    if (!b || typeof b !== 'object' || !b.name) continue;
    const subs = Array.isArray(b.sub_button) ? b.sub_button.filter(Boolean) : [];
    if (subs.length > 0) {
      const children = sanitizeMenu(subs).slice(0, 5);
      if (children.length === 0) continue; // 父菜单无有效子项，跳过
      out.push({ name: b.name, sub_button: children });
    } else if (b.type) {
      const leaf = { name: b.name, type: b.type };
      if (b.key !== undefined) leaf.key = b.key;
      if (b.url !== undefined) leaf.url = b.url;
      if (b.appid !== undefined) leaf.appid = b.appid;
      if (b.pagepath !== undefined) leaf.pagepath = b.pagepath;
      if (b.media_id !== undefined) leaf.media_id = b.media_id;
      out.push(leaf);
    }
    // 既无子菜单也无 type 的无效项直接丢弃
  }
  return out;
}

// 获取应用当前菜单（menu/get）；无菜单(46003)返回空，其他异常返回 null 以降级处理
async function getCurrentMenu(token, agentid) {
  try {
    const { data } = await axios.get(`${WECHAT_API}/cgi-bin/menu/get`, {
      params: { access_token: token, agentid: Number(agentid) },
      timeout: 10000
    });
    if (data.errcode && data.errcode !== 0) {
      if (data.errcode === 46003) return { button: [] };
      logger.warn(MODULE, 'MENU', `获取当前菜单返回错误: ${data.errcode} ${data.errmsg}`);
      return null;
    }
    return data;
  } catch (e) {
    logger.warn(MODULE, 'MENU', `获取当前菜单失败: ${e.message}`);
    return null;
  }
}

async function createMenu() {
  const cfg = await getWecomAppConfig();
  if (!cfg.corpid || !cfg.corpsecret || !cfg.agentid) {
    throw new Error('企业微信应用配置不完整，无法创建菜单');
  }
  const token = await getAccessToken();

  // 拉取当前菜单，保留用户自定义的菜单项，避免创建时将其整组删除
  const current = await getCurrentMenu(token, cfg.agentid);
  // 获取失败时（网络/接口异常）不盲目覆盖，否则会误删用户自定义菜单
  if (current === null) {
    throw new Error('无法获取当前菜单（网络或接口异常），为安全起见未做修改，以免误删自定义菜单');
  }
  const customButtons = sanitizeMenu(stripStandardButtons(current.button || []));

  // 合并规则：自定义菜单在前、标准菜单在后；企业微信一级菜单最多 3 个
  let merged = customButtons.concat(WECOM_MENU.button);
  let truncated = false;
  if (merged.length > 3) {
    const allowed = Math.max(0, 3 - customButtons.length);
    merged = customButtons.concat(WECOM_MENU.button.slice(0, allowed));
    truncated = customButtons.length >= 3;
    if (truncated) {
      logger.warn(MODULE, 'MENU',
        '自定义菜单已达 3 个一级上限，无法追加标准菜单（不会删除自定义菜单）');
    }
  }

  const { data } = await axios.post(
    `${WECHAT_API}/cgi-bin/menu/create?access_token=${token}&agentid=${Number(cfg.agentid)}`,
    { button: merged },
    { timeout: 10000 }
  );
  if (data.errcode !== 0) {
    throw new Error(`创建菜单失败: ${data.errcode} ${data.errmsg}`);
  }
  // 附带保留信息，便于前端提示
  data.preservedCustom = customButtons.length;
  data.truncatedStandard = truncated;
  return data;
}

// ==================== WXBizMsgCrypt（AES 加解密） ====================
function sha1Signature(token, timestamp, nonce, encrypt) {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

function decodeAesKey(encodingAESKey) {
  // EncodingAESKey 为 43 字符的 base64 字符串，补 '=' 后为 44 字符 → 32 字节
  return Buffer.from(encodingAESKey + '=', 'base64');
}

function decrypt(aesKey, cipherBase64) {
  const key = aesKey;
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherBase64, 'base64')),
    decipher.final()
  ]);
  // 去除 PKCS7 填充
  const pad = decrypted[decrypted.length - 1];
  let out = decrypted;
  if (pad >= 1 && pad <= 32) {
    out = decrypted.slice(0, decrypted.length - pad);
  }
  // 结构：16 字节随机 + 4 字节内容长度(网络序) + 内容 + corpid
  const contentLen = out.readUInt32BE(16);
  const content = out.slice(20, 20 + contentLen).toString('utf8');
  return content;
}

function encrypt(aesKey, plain, corpid) {
  const key = aesKey;
  const iv = key.slice(0, 16);
  const random16 = crypto.randomBytes(16);
  const msgBuf = Buffer.from(plain, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const corpBuf = Buffer.from(corpid, 'utf8');
  let raw = Buffer.concat([random16, lenBuf, msgBuf, corpBuf]);
  // PKCS7 填充到 32 字节整数倍
  const padLen = 32 - (raw.length % 32);
  raw = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  return encrypted.toString('base64');
}

function pickXml(xml, tag) {
  const m = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>|<${tag}>(.*?)</${tag}>`)
  );
  return m ? (m[1] || m[2] || '') : '';
}

// ==================== 回调处理 ====================
async function handleCallbackGet(req, res) {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  if (!msg_signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('missing parameters');
  }
  const cfg = await getWecomAppConfig();
  if (!cfg.token || !cfg.encodingAESKey) {
    return res.status(400).send('wecom app callback not configured');
  }
  const sig = sha1Signature(cfg.token, timestamp, nonce, echostr);
  if (sig !== msg_signature) {
    return res.status(401).send('invalid signature');
  }
  try {
    const plain = decrypt(decodeAesKey(cfg.encodingAESKey), echostr);
    res.send(plain);
  } catch (e) {
    logger.error(MODULE, 'CALLBACK', 'Decrypt echostr failed', { error: e.message });
    res.status(500).send('decrypt failed');
  }
}

async function handleCallbackPost(req, res) {
  const { msg_signature, timestamp, nonce } = req.query;
  if (!msg_signature || !timestamp || !nonce) {
    return res.status(400).send('missing parameters');
  }
  const cfg = await getWecomAppConfig();
  if (!cfg.token || !cfg.encodingAESKey) {
    return res.status(400).send('wecom app callback not configured');
  }
  const xml = typeof req.body === 'string' ? req.body : (req.body && req.body.xml) || '';
  const encMatch = xml.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/) ||
                   xml.match(/<Encrypt>(.*?)<\/Encrypt>/);
  const encrypt = encMatch ? encMatch[1] : '';
  const sig = sha1Signature(cfg.token, timestamp, nonce, encrypt);
  if (sig !== msg_signature) {
    return res.status(401).send('invalid signature');
  }
  // 立即返回 success，避免企业微信 5s 超时重试；后续处理异步进行
  res.send('success');
  try {
    const decryptedXml = decrypt(decodeAesKey(cfg.encodingAESKey), encrypt);
    const event = pickXml(decryptedXml, 'Event');
    const eventKey = pickXml(decryptedXml, 'EventKey');
    const fromUser = pickXml(decryptedXml, 'FromUserName');
    dispatchMenuEvent(event, eventKey, fromUser).catch((e) => {
      logger.error(MODULE, 'CALLBACK', 'Dispatch menu event failed', { error: e.message });
    });
  } catch (e) {
    logger.error(MODULE, 'CALLBACK', 'Decrypt message failed', { error: e.message });
  }
}

// ==================== 菜单 click 事件分发 ====================
async function dispatchMenuEvent(event, eventKey, fromUser) {
  if (event !== 'click' || !eventKey) return;
  let actionName = '';
  let fn = null;
  switch (eventKey) {
    case 'MENU_CLEAR_CACHE':
      actionName = '清理缓存';
      fn = () => deps.clearCache && deps.clearCache();
      break;
    case 'MENU_PLUGIN_UPDATE':
      actionName = '插件更新';
      fn = () => deps.updatePlugins && deps.updatePlugins();
      break;
    case 'MENU_SUB_DOWNLOAD':
      actionName = '订阅下载';
      fn = () => deps.schedulerManager &&
        deps.schedulerManager.runSubscriptionUpdate({ sendNotification: true });
      break;
    case 'MENU_M3U_GEN':
      actionName = 'M3U生成';
      fn = () => deps.schedulerManager &&
        deps.schedulerManager.runM3uGeneration({ sendNotification: true });
      break;
    default:
      logger.info(MODULE, 'MENU', `未识别的菜单事件: ${eventKey}`, { fromUser });
      return;
  }
  if (!fn) return;
  logger.info(MODULE, 'MENU', `收到菜单事件: ${eventKey} (${actionName})`, { fromUser });
  try {
    await fn();
    try { await sendText(`✅ 已触发：${actionName}`); } catch (_) { /* 通知失败不影响操作 */ }
  } catch (e) {
    logger.error(MODULE, 'MENU', `执行失败: ${actionName}`, { error: e.message });
    try { await sendText(`❌ ${actionName} 执行失败：${e.message}`); } catch (_) { /* ignore */ }
  }
}

// ==================== 使用指定配置发送（测试用，不污染已存配置） ====================
async function sendAppMessageWithConfig(cfg, message) {
  if (!cfg.corpid || !cfg.corpsecret || !cfg.agentid) {
    throw new Error('企业微信应用配置不完整（需 corpid / corpsecret / agentid）');
  }
  const { data } = await axios.get(`${WECHAT_API}/cgi-bin/gettoken`, {
    params: { corpid: cfg.corpid, corpsecret: cfg.corpsecret },
    timeout: 10000
  });
  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }
  const payload = Object.assign(
    { agentid: Number(cfg.agentid), touser: cfg.touser || '@all' },
    message
  );
  const { data: r } = await axios.post(
    `${WECHAT_API}/cgi-bin/message/send?access_token=${data.access_token}`,
    payload,
    { timeout: 10000 }
  );
  if (r.errcode !== 0) {
    throw new Error(`发送失败: ${r.errcode} ${r.errmsg}`);
  }
  return r;
}

// ==================== 路由注册 ====================
function registerWecomAppRoutes(app, authMiddleware) {
  app.get('/api/wecom-app/config', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      res.json({ success: true, data: await getWecomAppConfig() });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  app.post('/api/wecom-app/config', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const current = await getWecomAppConfig();
      const cfg = Object.assign({}, current, req.body || {});
      await saveWecomAppConfig(cfg);
      res.json({ success: true, data: cfg });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // 测试发送：直接用请求体里的配置，不依赖已保存配置，也不污染缓存
  app.post('/api/wecom-app/test', authMiddleware, async (req, res) => {
    try {
      const cfg = Object.assign(await getWecomAppConfig(), req.body || {});
      const result = await sendAppMessageWithConfig(cfg, {
        msgtype: 'text',
        text: { content: '🔔 MusicHub 企业微信应用通知测试成功' }
      });
      res.json({ success: true, data: result });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  app.post('/api/wecom-app/menu', authMiddleware, async (req, res) => {
    try {
      const result = await createMenu();
      res.json({ success: true, data: result });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // 回调：无需鉴权，必须公网可达
  app.get('/api/wecom-app/callback', handleCallbackGet);
  app.post(
    '/api/wecom-app/callback',
    express.text({ type: ['text/xml', 'application/xml', 'xml'] }),
    handleCallbackPost
  );
}

module.exports = {
  initWecomApp,
  getWecomAppConfig,
  saveWecomAppConfig,
  getAccessToken,
  sendAppMessage,
  sendText,
  sendMarkdown,
  createMenu,
  registerWecomAppRoutes,
  handleCallbackGet,
  handleCallbackPost,
  WECOM_MENU
};
