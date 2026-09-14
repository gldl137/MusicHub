// 落雪 request.js 的 MusicHub 替代实现（基于 axios）。
// 保持与原实现一致的对外 API：httpFetch / http / httpGet / httpPost / checkUrl / http_jsonp
// httpFetch(url, options) 返回 { promise, cancelHttp, isCancelled }，promise 解析出 resp：
//   { statusCode, status, headers, body, raw }（body 尽量解析为 JSON）
import axios from 'axios';

const SECRET = '624868746c'; // 与 musicSdk/options.js 的 bHh 一致

const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
};

function buildResp(resp) {
  let body = resp.data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* 保持字符串 */ }
  }
  return {
    statusCode: resp.status,
    status: resp.status,
    headers: resp.headers,
    body,
    raw: resp.data,
  };
}

async function fetchData(url, method, options, cancelHolder) {
  const { headers = {}, timeout = 15000 } = options || {};
  const merged = Object.assign({}, defaultHeaders, headers);

  // 原实现对带 bHh 头的临时接口做签名；Node 无 process.versions.app，这里仅去除占位头，避免请求失败
  if (merged[SECRET] !== undefined) delete merged[SECRET];

  const cfg = {
    url,
    method: (method || 'get').toUpperCase(),
    headers: merged,
    timeout,
    responseType: 'text',
    validateStatus: () => true,
    maxRedirects: 5,
  };

  if (options.form != null) {
    cfg.data = new URLSearchParams(options.form).toString();
    if (!cfg.headers['Content-Type'] && !cfg.headers['content-type']) {
      cfg.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else if (options.body != null) {
    cfg.data = options.body;
  } else if (options.data != null) {
    cfg.data = options.data;
  }

  if (cancelHolder) {
    const source = axios.CancelToken.source();
    cancelHolder(source);
    cfg.cancelToken = source.token;
  }

  const resp = await axios.request(cfg);
  return buildResp(resp);
}

export const httpFetch = (url, options = { method: 'get' }) => {
  const obj = {
    isCancelled: false,
    cancelHttp: () => {
      obj.isCancelled = true;
      if (obj._source) {
        try { obj._source.cancel('canceled'); } catch { /* ignore */ }
      }
    },
  };
  obj.promise = fetchData(url, options.method || 'get', options, (s) => { obj._source = s; })
    .catch((err) => {
      if (axios.isCancel(err)) return Promise.reject(new Error('已取消请求'));
      const code = err && err.code;
      if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return Promise.reject(new Error('请求超时'));
      if (code === 'ENOTFOUND') return Promise.reject(new Error('找不到服务器'));
      return Promise.reject(err);
    });
  return obj;
};

export const http = (url, options = {}, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  fetchData(url, options.method || 'get', options)
    .then((resp) => cb(null, resp, resp.body))
    .catch((err) => cb(err, null, null));
};

export const httpGet = (url, options = {}, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  fetchData(url, 'get', options)
    .then((resp) => cb(null, resp, resp.body))
    .catch((err) => cb(err, null, null));
};

export const httpPost = (url, data, options = {}, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  options.data = data;
  fetchData(url, 'post', options)
    .then((resp) => cb(null, resp, resp.body))
    .catch((err) => cb(err, null, null));
};

export const http_jsonp = (url, options = {}, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  fetchData(url, 'get', options)
    .then((resp) => cb(null, resp, resp.body))
    .catch((err) => cb(err, null, null));
};

export const checkUrl = (url, options = {}) => new Promise((resolve, reject) => {
  fetchData(url, 'head', options)
    .then((resp) => (resp.statusCode === 200 ? resolve() : reject(new Error(resp.statusCode))))
    .catch(reject);
});

// 兼容：部分代码可能直接调用 cancelHttp(requestObj)
export const cancelHttp = (requestObj) => {
  if (requestObj && typeof requestObj.cancelHttp === 'function') requestObj.cancelHttp();
};
