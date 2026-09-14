'use strict';

/**
 * 落雪音乐（LX）自定义音源运行时
 * ================================================================
 * 在 Node 侧用 vm 沙箱模拟落雪客户端给音源脚本暴露的 `globalThis.lx`：
 *   EVENT_NAMES / on / send / request / utils / currentScriptInfo / version / env
 *
 * 协议严格对齐桌面端宿主实现：
 *   lx-music-desktop/src/main/modules/userApi/renderer/preload.js
 *   - 支持音源 : kw / kg / tx / wy / mg / local
 *   - 支持动作 : musicUrl（local 另有 lyric / pic）
 *   - 支持音质 : 128k / 320k / flac / flac24bit
 *   - lx.request(url, {method,timeout,headers,body,form,formData}, callback) 回调式，返回 abort 函数
 *   - 脚本通过 lx.send(EVENT_NAMES.inited, { sources }) 声明能力
 *   - 脚本通过 lx.on(EVENT_NAMES.request, handler) 响应宿主请求
 *
 * 用法：
 *   const inst = new LxSourceInstance({ name: 'xxx.js', code });
 *   await inst.init();                                    // 等脚本 inited（15s 超时）
 *   inst.sources                                          // { kg: { type, actions, qualitys } }
 *   const url = await inst.invoke('musicUrl', 'kg', { type: '320k', musicInfo });
 *
 * 注意：音源脚本是第三方代码，vm 只能隔离变量作用域，**挡不住网络访问**；
 *       仅应导入可信音源。
 */

const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const axios = require('axios');
const logger = require('../core/logger');

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
const EVENT_LIST = Object.values(EVENT_NAMES);

const ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'];

// 与宿主一致的「音源 → 可用音质 / 动作」白名单
const SUPPORT_QUALITYS = {
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '320k', 'flac', 'flac24bit'],
  local: [],
};
const SUPPORT_ACTIONS = {
  kw: ['musicUrl'],
  kg: ['musicUrl'],
  tx: ['musicUrl'],
  wy: ['musicUrl'],
  mg: ['musicUrl'],
  xm: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
};

const DEFAULT_INIT_TIMEOUT = 15000;
const DEFAULT_INVOKE_TIMEOUT = 20000;
const MAX_REQ_TIMEOUT = 60000;

// 脚本未指定 User-Agent 时用的默认值。宿主（落雪 Electron 渲染进程）本就是一个浏览器环境，
// 很多音源站会对非浏览器 UA（如 axios/1.x）直接 403，因此这里也走浏览器 UA。
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

class LxSourceInstance {
  /**
   * @param {object} opts
   * @param {string} opts.name  音源文件名（用于日志/标识）
   * @param {string} opts.code  音源脚本内容
   * @param {object} [opts.meta] 元信息（name/description/version/author/homepage）
   */
  constructor({ name, code, meta }) {
    this.name = name || 'lx-source';
    this.code = String(code || '');
    this.meta = meta || {};

    this.sources = {};       // 声明能力：{ kg: { type:'music', actions:[...], qualitys:[...] } }
    this.updateAlert = null; // 脚本上报的更新提示
    this.inited = false;

    this._requestHandler = null;
    this._context = null;
    this._initedResolve = null;
    this._initedReject = null;
    this._initTimer = null;
    this._initedPromise = null;
    this._disposed = false;
    this._logs = [];
    this._reqLog = [];
    this._asyncError = '';   // 最近一次脚本未捕获异常（仅作诊断）
    this._initErrBox = null;
  }

  /** 初始化：执行脚本并等待 inited（幂等，可重复 await） */
  init(timeoutMs = DEFAULT_INIT_TIMEOUT) {
    if (this._initedPromise) return this._initedPromise;
    this._initedPromise = new Promise((resolve, reject) => {
      this._initedResolve = resolve;
      this._initedReject = reject;
      this._initErrBox = this._captureAsyncErrors();
      this._initTimer = setTimeout(() => {
        // 先关闭捕获窗口，把脚本未捕获异常收进 _asyncError，再拼装失败详情
        this._initErrBox && this._initErrBox.stop();
        this._initErrBox = null;
        this._failInit(new Error(`音源初始化超时（${timeoutMs}ms 内未收到 inited 事件）｜${this._failureDetail('')}`));
      }, timeoutMs);

      try {
        const context = this._buildContext();
        vm.createContext(context);
        this._context = context;
        // window / self / global 指向「真正的全局对象」：
        // 若它们指向只含补丁属性的普通对象，脚本里的 window.Function、globalThis.Object
        // 这类访问会拿到 undefined，进而在 .bind()/.call() 处抛出难以定位的错误
        // （实测有音源报「Bind must be called on a function」）。
        vm.runInContext(
          'globalThis.window = globalThis; globalThis.self = globalThis; globalThis.global = globalThis;',
          context,
        );
        vm.runInContext(this.code, context, { timeout: 5000, filename: this.name });
      } catch (e) {
        this._failInit(new Error(`音源脚本执行失败：${e.message}`));
      }
    });
    return this._initedPromise;
  }

  /** 取最近 n 条脚本 console 输出（音源报错时用于定位原因） */
  recentLogs(n = 3) {
    return this._logs.slice(-n).join(' ; ');
  }

  /** 记录一次脚本发起的网络请求（失败诊断用） */
  _logRequest(entry) {
    this._reqLog.push(entry);
    if (this._reqLog.length > 12) this._reqLog.shift();
  }

  /**
   * 取最近 n 条请求轨迹：`GET host/path → HTTP 200 / ERR timeout`
   * 音源脚本报错时，这通常能直接指出是「自有服务器不可用」还是「npm 校验拿不到」
   */
  recentRequests(n = 4) {
    return this._reqLog.slice(-n).map((r) => {
      let target = String(r.url || '');
      try {
        const u = new URL(target);
        target = u.host + (u.pathname.length > 1 ? u.pathname.slice(0, 40) : '');
      } catch { /* 非标准 URL：原样展示 */ }
      const state = r.error ? `ERR ${r.error}` : `HTTP ${r.status}`;
      return `${String(r.method || 'get').toUpperCase()} ${target} → ${state}`;
    }).join(' ; ');
  }

  /** 汇总一次失败的现场信息（脚本输出 + 请求轨迹 + 未捕获异常），便于调用方直接展示 */
  _failureDetail(raw) {
    const parts = [];
    if (raw) parts.push(String(raw));
    if (this._asyncError) parts.push(`脚本未捕获异常：${this._asyncError}`);
    const logs = this.recentLogs(2);
    if (logs) parts.push(`脚本输出：${logs}`);
    const reqs = this.recentRequests(4);
    if (reqs) parts.push(`近期请求：${reqs}`);
    return parts.join('；').slice(0, 400);
  }

  /**
   * 初始化/单次请求窗口内，临时监听脚本抛出的「未捕获异步异常」。
   * 音源脚本的异步分支报错会冒泡到宿主进程，无法精确归属，
   * 因此这里只作为**诊断信息**收集（不作为失败判定依据），窗口结束即移除监听。
   */
  _captureAsyncErrors() {
    const box = { message: '' };
    const onReject = (reason) => {
      if (!box.message) box.message = (reason && reason.message) || String(reason || '');
    };
    process.on('unhandledRejection', onReject);
    box.stop = () => {
      try { process.removeListener('unhandledRejection', onReject); } catch { /* ignore */ }
      if (box.message && !this._asyncError) this._asyncError = box.message;
    };
    return box;
  }

  /** 当前音源是否声明了某平台的某动作 */
  supports(source, action = 'musicUrl') {
    const s = this.sources[source];
    return !!(s && Array.isArray(s.actions) && s.actions.includes(action));
  }

  /** 该平台可用音质列表 */
  qualitysOf(source) {
    const s = this.sources[source];
    return (s && Array.isArray(s.qualitys)) ? s.qualitys : [];
  }

  /**
   * 请求音源执行动作（对应宿主向脚本派发 request 事件）
   * @param {'musicUrl'|'lyric'|'pic'} action
   * @param {string} source kw/kg/tx/wy/mg/local
   * @param {object} info   musicUrl: { type, musicInfo }
   */
  async invoke(action, source, info, timeoutMs = DEFAULT_INVOKE_TIMEOUT) {
    if (this._disposed) throw new Error('音源已卸载');
    if (!this.inited) throw new Error('音源尚未初始化完成');
    if (!this._requestHandler) throw new Error('音源脚本未注册 request 事件');
    // 宿主不会向未声明能力的平台派发请求，这里同样守住（避免脚本被喂它没声明支持的数据）
    if (!this.supports(source, action)) {
      throw new Error(`该音源未声明支持 ${source}/${action}`);
    }

    const errBox = this._captureAsyncErrors();
    const run = Promise.resolve().then(() => this._requestHandler.call(this._context, { source, action, info }));
    let result;
    let failure = null;
    try {
      result = await withTimeout(run, timeoutMs, `音源请求超时（${action}/${source}，脚本无响应）`);
    } catch (e) {
      failure = e;
    } finally {
      errBox.stop(); // 关闭捕获窗口（把脚本未捕获异常收进 this._asyncError）
    }
    if (failure) {
      // 音源脚本常见 throw new Error()（无 message），此处兜底成可读信息，
      // 并带上「脚本未捕获异常 + console 输出 + 请求轨迹」以便直接定位原因
      const raw = (failure && failure.message) ? failure.message
        : (failure && failure.stack ? String(failure.stack).split('\n')[0] : String(failure));
      const isTimeout = /^音源请求超时/.test(raw || '');
      const prefix = isTimeout ? '音源脚本无响应' : '音源脚本报错';
      const err = new Error(`${prefix}：${this._failureDetail(isTimeout ? '' : raw) || '无错误信息'}`);
      err.cause = failure;
      throw err;
    }

    if (action === 'musicUrl') {
      // 与宿主一致：必须是 http(s) 且不超过 2048 字符
      if (typeof result !== 'string' || !result || result.length > 2048 || !/^https?:/.test(result)) {
        throw new Error('音源返回的播放地址无效');
      }
      return result;
    }
    if (action === 'pic') {
      if (typeof result !== 'string' || !/^https?:/.test(result)) throw new Error('音源返回的图片地址无效');
      return result;
    }
    return result;
  }

  /** 卸载：停止定时器、断开脚本引用 */
  dispose() {
    this._disposed = true;
    if (this._initTimer) clearTimeout(this._initTimer);
    this._initTimer = null;
    if (this._initErrBox) this._initErrBox.stop();
    this._initErrBox = null;
    this._requestHandler = null;
    this._context = null;
    this._initedPromise = null;
  }

  // ==================== 内部 ====================

  _failInit(err) {
    if (this._initTimer) clearTimeout(this._initTimer);
    this._initTimer = null;
    this._initErrBox && this._initErrBox.stop();
    this._initErrBox = null;
    this._initedPromise = null;
    const reject = this._initedReject;
    this._initedResolve = null;
    this._initedReject = null;
    if (reject) reject(err);
  }

  _okInit() {
    if (this._initTimer) clearTimeout(this._initTimer);
    this._initTimer = null;
    this._initErrBox && this._initErrBox.stop();
    this._initErrBox = null;
    const resolve = this._initedResolve;
    this._initedResolve = null;
    this._initedReject = null;
    if (resolve) resolve(this);
  }

  /** 按宿主逻辑过滤出脚本真正可用的能力 */
  _handleInit(info) {
    if (!info || typeof info !== 'object') throw new Error('缺少 inited 参数');
    const declared = info.sources || {};
    const out = {};
    for (const source of ALL_SOURCES) {
      const userSource = declared[source];
      if (!userSource || userSource.type !== 'music') continue;
      const userActions = Array.isArray(userSource.actions) ? userSource.actions : [];
      const userQualitys = Array.isArray(userSource.qualitys) ? userSource.qualitys : [];
      const actions = (SUPPORT_ACTIONS[source] || []).filter((a) => userActions.includes(a));
      if (!actions.length) continue;
      out[source] = {
        type: 'music',
        actions,
        qualitys: (SUPPORT_QUALITYS[source] || []).filter((q) => userQualitys.includes(q)),
        name: userSource.name || '',
      };
    }
    this.sources = out;
    this.inited = true;
  }

  _log(level, message) {
    const text = String(message == null ? '' : message);
    this._logs.push(text);
    if (this._logs.length > 200) this._logs.shift();
    if (level === 'error') logger.warn('LX', 'lx-runner', `[${this.name}] ${text}`);
    else logger.debug('LX', 'lx-runner', `[${this.name}] ${text}`);
  }

  _buildContext() {
    const self = this;

    // lx.request：回调式，返回 abort 函数（与宿主 needle 实现语义一致）
    const lxRequest = (url, options = {}, callback) => {
      const method = String((options && options.method) || 'get').toLowerCase();
      const headers = Object.assign({}, (options && options.headers) || undefined);

      // 与宿主 needle 语义对齐：body=JSON/文本、form=urlencoded、formData=multipart
      let data;
      if (options && options.form) {
        data = new URLSearchParams(options.form).toString();
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (options && options.formData) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(options.formData)) {
          if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
          else if (v != null) fd.append(k, v);
        }
        data = fd; // Content-Type 交给 axios 自动带 boundary（脚本若写了手动值会因缺 boundary 被服务端拒绝）
        delete headers['Content-Type'];
        delete headers['content-type'];
      } else {
        data = (options && options.body) || undefined;
      }

      // 脚本没给 UA 时补浏览器 UA：axios 默认的 "axios/x.y.z" 会被部分音源站 403
      if (!headers['User-Agent'] && !headers['user-agent']) {
        headers['User-Agent'] = DEFAULT_UA;
      }

      const timeout = (typeof options.timeout === 'number' && options.timeout > 0)
        ? Math.min(options.timeout, MAX_REQ_TIMEOUT)
        : MAX_REQ_TIMEOUT;

      // 记录请求轨迹（诊断用）：失败时能把「脚本在请求谁」直接带进错误信息
      const entry = { method, url, status: null, error: '' };
      self._logRequest(entry);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const settle = (err, resp, body) => {
        if (typeof callback !== 'function') return;
        try {
          callback.call(self._context, err, resp, body);
        } catch (e) {
          self._log('error', `request callback 异常: ${e.message}`);
        }
      };

      axios.request({
        url,
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        data,
        timeout,
        signal: controller.signal,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
        decompress: true,
      }).then((resp) => {
        clearTimeout(timer);
        entry.status = resp.status;
        const raw = resp.data;
        let body = raw;
        try { body = JSON.parse(raw); } catch { /* 保持字符串 */ }
        settle(null, {
          statusCode: resp.status,
          statusMessage: resp.statusText,
          headers: resp.headers,
          bytes: Buffer.byteLength(typeof raw === 'string' ? raw : ''),
          raw,
          body,
        }, body);
      }).catch((err) => {
        clearTimeout(timer);
        entry.error = String((err && err.message) || err).slice(0, 60);
        settle(err, null, null);
      });

      return () => {
        clearTimeout(timer);
        try { controller.abort(); } catch { /* ignore */ }
      };
    };

    const lxApi = {
      EVENT_NAMES,
      env: 'desktop',
      version: '2.0.0',
      currentScriptInfo: {
        name: self.meta.name || self.name,
        description: self.meta.description || '',
        version: self.meta.version || '',
        author: self.meta.author || '',
        homepage: self.meta.homepage || '',
        rawScript: self.code,
      },
      // 脚本注册请求处理器
      on(eventName, handler) {
        if (!EVENT_LIST.includes(eventName)) return Promise.reject(new Error('The event is not supported: ' + eventName));
        if (eventName === EVENT_NAMES.request) {
          if (typeof handler !== 'function') return Promise.reject(new Error('handler must be a function'));
          self._requestHandler = handler;
        }
        return Promise.resolve();
      },
      // 脚本向宿主上报（inited / updateAlert）
      send(eventName, data) {
        return new Promise((resolve, reject) => {
          if (!EVENT_LIST.includes(eventName)) return reject(new Error('The event is not supported: ' + eventName));
          if (eventName === EVENT_NAMES.inited) {
            if (self.inited) return reject(new Error('Script is inited'));
            try {
              self._handleInit(data);
            } catch (e) {
              self._failInit(e);
              return reject(e);
            }
            resolve();
            self._okInit();
            return;
          }
          if (eventName === EVENT_NAMES.updateAlert) {
            self.updateAlert = data || null;
            resolve();
            return;
          }
          reject(new Error('Unknown event name: ' + eventName));
        });
      },
      request: lxRequest,
      utils: {
        crypto: {
          aesEncrypt(buffer, mode, key, iv) {
            const cipher = crypto.createCipheriv(mode, key, iv);
            return Buffer.concat([cipher.update(buffer), cipher.final()]);
          },
          rsaEncrypt(buffer, key) {
            const buf = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
            return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buf);
          },
          randomBytes(size) {
            return crypto.randomBytes(size);
          },
          md5(str) {
            return crypto.createHash('md5').update(str).digest('hex');
          },
        },
        buffer: {
          from(...args) { return Buffer.from(...args); },
          bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format); },
        },
        zlib: {
          inflate(buf) {
            return new Promise((resolve, reject) => {
              zlib.inflate(buf, (err, data) => (err ? reject(err) : resolve(data)));
            });
          },
          deflate(data) {
            return new Promise((resolve, reject) => {
              zlib.deflate(data, (err, buf) => (err ? reject(err) : resolve(buf)));
            });
          },
        },
      },
    };

    // 落雪宿主里脚本跑在真实浏览器环境中，console 是全量的；音源脚本（尤其混淆过的）
    // 会调用 console.group / table / time / count 等。这里补齐常用方法，
    // 并用 Proxy 兜底让任何未实现的方法成为空操作 —— 「console.xxx is not a function」
    // 会直接把脚本打断（实测有音源因此整体不可用）。
    const noop = () => {};
    const fmtArgs = (args) => args.map((x) => {
      if (typeof x === 'string') return x.slice(0, 300);
      try { return JSON.stringify(x).slice(0, 300); } catch { return String(x); }
    }).join(' ');
    const consoleBase = {
      log: (...a) => self._log('log', fmtArgs(a)),
      info: (...a) => self._log('info', fmtArgs(a)),
      warn: (...a) => self._log('warn', fmtArgs(a)),
      error: (...a) => self._log('error', fmtArgs(a)),
      debug: (...a) => self._log('debug', fmtArgs(a)),
      trace: (...a) => self._log('debug', fmtArgs(a)),
      dir: (...a) => self._log('log', fmtArgs(a)),
      table: noop,
      group: noop,
      groupCollapsed: noop,
      groupEnd: noop,
      time: noop,
      timeEnd: noop,
      timeLog: noop,
      count: noop,
      countReset: noop,
      assert: noop,
      clear: noop,
    };
    const consoleShim = new Proxy(consoleBase, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return noop;
      },
    });

    // localStorage 内存替身：少数音源用它缓存 token / 线路，缺失会直接抛错
    const lsStore = new Map();
    const localStorageShim = {
      getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
      setItem: (k, v) => { lsStore.set(String(k), String(v)); },
      removeItem: (k) => { lsStore.delete(String(k)); },
      clear: () => lsStore.clear(),
      key: (i) => (Array.from(lsStore.keys())[i] !== undefined ? Array.from(lsStore.keys())[i] : null),
      get length() { return lsStore.size; },
    };

    const sandbox = {
      lx: lxApi,
      console: consoleShim,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      queueMicrotask,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      // 浏览器环境里有、脚本可能会用到的基础能力（与落雪宿主保持一致）
      fetch,
      atob,
      btoa,
      crypto: crypto.webcrypto,
      performance,
      structuredClone,
      requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
      cancelAnimationFrame: (id) => clearTimeout(id),
      localStorage: localStorageShim,
      // 部分音源会探测运行环境，给一个最小只读替身（不暴露宿主 env）
      process: { version: process.version, platform: process.platform, env: {} },
      navigator: { userAgent: DEFAULT_UA },
    };

    return sandbox;
  }
}

module.exports = {
  LxSourceInstance,
  EVENT_NAMES,
  ALL_SOURCES,
  SUPPORT_QUALITYS,
  SUPPORT_ACTIONS,
  DEFAULT_INIT_TIMEOUT,
  DEFAULT_INVOKE_TIMEOUT,
};
