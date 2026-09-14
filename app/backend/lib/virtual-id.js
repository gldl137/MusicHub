'use strict';

/**
 * 网络歌曲虚拟 ID 工具
 *
 * 设计：对外（客户端 / OpenSubsonic / 业务表 song_id）统一使用带命名空间的字符串虚拟 ID：
 *   remote__{source}__{sourceSongId}
 * 例如：remote__netease__123456
 *
 * - source：音源（插件文件名，如 netease / qq / kuwo），稳定不变
 * - sourceSongId：第三方原始歌曲 id（如 123456）
 *
 * 业务表（play_history / favorites / playlist_songs / play_queue）的 music_id 统一存这个虚拟 ID；
 * 本地歌曲继续走 local_songs，其 music_id 为纯数字字符串，不会带 remote__ 前缀。
 *
 * 红线：虚拟 ID 只是「定位键」，绝不编码任何播放地址 / token。
 */

const VIRTUAL_PREFIX = 'remote__';
const SEP = '__';

/**
 * 构造虚拟 ID
 * @param {string} source 音源（插件名）
 * @param {string|number} sourceSongId 第三方原始 id
 * @returns {string} remote__{source}__{sourceSongId}
 */
function buildVirtualId(source, sourceSongId) {
  const s = String(source == null ? '' : source).trim();
  const id = String(sourceSongId == null ? '' : sourceSongId).trim();
  return `${VIRTUAL_PREFIX}${s}${SEP}${id}`;
}

/**
 * 判断字符串是否为虚拟 ID
 * @param {string} id
 * @returns {boolean}
 */
function isVirtualId(id) {
  return typeof id === 'string' && id.startsWith(VIRTUAL_PREFIX) && id.indexOf(SEP, VIRTUAL_PREFIX.length) !== -1;
}

/**
 * 解析虚拟 ID
 * @param {string} virtualId
 * @returns {{source:string, sourceSongId:string}|null}
 */
function parseVirtualId(virtualId) {
  if (!isVirtualId(virtualId)) return null;
  const rest = virtualId.slice(VIRTUAL_PREFIX.length); // {source}__{sourceSongId}
  const idx = rest.indexOf(SEP);
  if (idx === -1) return null;
  const source = rest.slice(0, idx);
  const sourceSongId = rest.slice(idx + SEP.length);
  return { source, sourceSongId };
}

/**
 * 是否为本地歌曲 id（纯数字字符串，无 remote__ 前缀）
 * @param {string} id
 * @returns {boolean}
 */
function isLocalId(id) {
  if (typeof id !== 'string' || !id) return false;
  if (isVirtualId(id)) return false;
  return /^\d+$/.test(id.trim());
}

module.exports = {
  VIRTUAL_PREFIX,
  SEP,
  buildVirtualId,
  isVirtualId,
  parseVirtualId,
  isLocalId
};
