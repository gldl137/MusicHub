'use strict';

/**
 * 落雪（LX）音源解析
 * ================================================================
 * 把 LX 专区的歌曲（musicItem.plugin = `lx:<平台>`）交给已启用的落雪自定义音源，
 * 通过 invoke('musicUrl', <平台>, { type: 音质, musicInfo }) 取播放地址。
 *
 * - 平台与落雪 source key 一一对应：kw / kg / tx / wy / mg
 * - 音质链：standard→128k，high→320k→128k，lossless→flac→320k→128k
 * - 多个音源依次尝试；全部失败才返回失败
 */

const logger = require('../core/logger');
const { getCandidates } = require('./sources');

const QUALITY_CHAIN = {
  low: ['128k'],
  standard: ['128k'],
  high: ['320k', '128k'],
  super: ['320k', '128k'],
  lossless: ['flac', 'flac24bit', '320k', '128k'],
};

/** 从歌曲/插件标识里识别落雪平台（`lx:kg` → kg） */
function detectSource(plugin, music) {
  const candidates = [
    music && music.plugin,
    music && music.lxSource,
    plugin,
  ];
  for (const c of candidates) {
    const m = /^lx:([a-z0-9]+)$/i.exec(String(c || '').trim());
    if (m) return m[1].toLowerCase();
  }
  if (music && music.lxSource) return String(music.lxSource).toLowerCase();
  return null;
}

/**
 * 解析落雪音源播放地址
 * @param {object} opts
 * @param {object} opts.music     MusicHub musicItem（含落雪原始字段）
 * @param {string} opts.source    kw/kg/tx/wy/mg
 * @param {string} opts.quality   standard/high/lossless
 * @param {string} [opts.reqId]
 * @param {Function} [opts.probe] 可达性探测（传入则逐个校验，不可达自动换源）
 * @param {string} [opts.preferFile] 优先使用的音源文件（播放器「切换音源」所选），失败仍会自动回退其它已启用音源
 * @param {string} [opts.onlyFile] 只使用指定音源文件（「测试解析」按单个音源精确检验，不做回退）
 * @returns {Promise<{success:boolean,data?:{url:string,quality:string,from:string,tried:string[]},error?:string}>}
 */
async function resolveLx({ music, source, quality, reqId = 'lx', probe = null, preferFile = null, onlyFile = null }) {
  if (!music || !source) return { success: false, error: '缺少歌曲或音源信息' };

  const chain = QUALITY_CHAIN[quality] || QUALITY_CHAIN.standard;
  let candidates = getCandidates(source, 'musicUrl');
  if (!candidates.length) {
    return {
      success: false,
      error: `没有可用的 LX 音源（请在「设置 → LX 音源」导入并启用支持 ${source} 的音源）`,
    };
  }

  // 单源精确模式（测试解析）：只测指定的那个音源，不做回退，避免「别的源能用」掩盖它本身失效
  if (onlyFile) {
    candidates = candidates.filter((c) => c.file === onlyFile);
    if (!candidates.length) {
      return { success: false, error: `音源「${onlyFile}」未启用或尚未就绪，无法测试` };
    }
  }

  // 播放器「切换音源」指定的优先音源：置顶先试；失败后继续按顺序回退到其它已启用音源。
  // 指定的音源被删除/停用/未就绪时不报错，仅回落默认顺序（用户预期里它已不可用）。
  if (!onlyFile && preferFile) {
    const idx = candidates.findIndex((c) => c.file === preferFile);
    if (idx > 0) {
      const [p] = candidates.splice(idx, 1);
      candidates.unshift(p);
    } else if (idx < 0) {
      logger.debug('LX', reqId, `指定的音源 ${preferFile} 未启用/未就绪，按默认顺序尝试已启用音源`);
    }
  }

  const tried = [];
  let lastError = null;
  for (const type of chain) {
    for (const cand of candidates) {
      // 音源未声明该音质则跳过（避免把不支持的类型喂给脚本）
      if (Array.isArray(cand.qualitys) && cand.qualitys.length && !cand.qualitys.includes(type)) continue;
      try {
        const url = await cand.inst.invoke('musicUrl', source, { type, musicInfo: music });
        if (probe) {
          // 探测结果可能是布尔，也可能是 { ok, reason }（例如「上游返回的不是音频」）。
          // 不可用就换到下一个已启用音源——不能把坏地址交给播放器，也不能因此整单失败。
          const v = await probe(url).catch(() => true);
          const ok = (v && typeof v === 'object') ? v.ok !== false : !!v;
          if (!ok) {
            const reason = (v && typeof v === 'object' && v.reason) ? v.reason : '地址不可达';
            // 带上上游返回片段（如 JSON 错误体），便于直接判断是哪个源、为什么坏
            const detail = (v && typeof v === 'object' && v.snippet) ? `${reason}：${v.snippet}` : reason;
            lastError = new Error(`${cand.file} 不可用：${detail}`);
            tried.push(`${cand.file}(${detail})`);
            logger.debug('LX', reqId, `LX 音源 ${cand.file} ${type} 不可用（${detail}），自动换源`);
            continue;
          }
        }
        logger.debug('LX', reqId, `LX 音源解析成功 | ${cand.file} | ${source}/${type}`
          + (tried.length ? ` | 已自动换源（前 ${tried.length} 个失败）` : ''));
        return { success: true, data: { url, quality: type, from: cand.file, tried } };
      } catch (e) {
        lastError = e;
        const detail = (e && (e.message || String(e))) || '未知错误';
        tried.push(`${cand.file}(${String(detail).slice(0, 120)})`);
        const logs = (cand.inst && typeof cand.inst.recentLogs === 'function') ? cand.inst.recentLogs(3) : '';
        logger.debug('LX', reqId, `LX 音源 ${cand.file} 解析失败（${source}/${type}）| ${detail}${logs ? ` | 脚本输出：${logs}` : ''}`);
      }
    }
  }

  const detail = (lastError && (lastError.message || String(lastError))) || '所有 LX 音源均解析失败';
  // 多个音源都试过：把每个源的失败原因一并带出，便于区分「全都失效」还是「个别源失效」
  if (tried.length > 1) {
    return { success: false, error: `所有已启用落雪音源均解析失败：${tried.join('；')}`.slice(0, 500) };
  }
  return { success: false, error: detail };
}

module.exports = { resolveLx, detectSource, QUALITY_CHAIN };
