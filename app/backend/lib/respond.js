/**
 * 私有接口统一响应工具
 *
 * 约定：所有私有（非 Subsonic）接口统一返回
 *   { success: boolean, code?: number, data?: any, error?: string }
 * 错误场景返回正确的 HTTP 状态码（不再一律 200）。
 *
 * ⚠️ Subsonic / OpenSubsonic 协议响应（rest/opensubsonic.js）不在此列，
 * 第三方客户端（Symfonium/Feishin/Amcfy Music）强依赖其固定格式，禁止改动。
 */

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, data, ...extra });
}

function fail(res, status, error, code) {
  const body = { success: false, error: String(error == null ? '' : error) };
  if (code !== undefined) body.code = code;
  return res.status(status).json(body);
}

function badRequest(res, error, code) { return fail(res, 400, error, code); }
function unauthorized(res, error = '未授权，请先登录') { return fail(res, 401, error); }
function forbidden(res, error = '无权访问该资源') { return fail(res, 403, error); }
function notFound(res, error = '资源不存在') { return fail(res, 404, error); }
function conflict(res, error, code) { return fail(res, 409, error, code); }
function serverError(res, error = '服务器内部错误') { return fail(res, 500, error); }

module.exports = { ok, fail, badRequest, unauthorized, forbidden, notFound, conflict, serverError };
