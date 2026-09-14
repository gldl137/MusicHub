'use strict';

/**
 * LRC 歌词工具：原始文本解析为结构化时间轴（修改建议文档「歌词原始文本与解析后带时间轴 JSON 直接存入数据库」）。
 *
 * - lyric_raw：原始完整 LRC 文本（直接存文件内容 / 内嵌歌词原文）；
 * - lyric_struct：[{ "start": 毫秒, "text": "..." }, ...] 的结构化 JSON 字符串。
 * 仅做只读解析，从不写入用户磁盘上的歌词文件。
 */

const fs = require('fs');
const path = require('path');

// 兼容 LRC 多时间戳标签 [mm:ss.xx]，一行可出现多个时间戳（副歌重复）
const TIME_TAG_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG_RE = /^\[(ti|title|ar|artist|al|album|by|offset|language|lang|re|ve|length)\s*:\s*(.*)\]$/i;

/**
 * 解析 LRC 文本，返回结构化数组 [{start: 毫秒, text}]。
 * - 元数据标签（[ti:]/[ar:]/[offset:] 等）被剔除；
 * - offset 标签作用于全部时间；
 * - 无时间标签的行视为纯文本行，start 为 null。
 */
function parseLrcStruct(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const out = [];
  let offset = 0;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const meta = line.match(META_TAG_RE);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        offset = parseInt(meta[2], 10) || 0;
      }
      continue;
    }
    // 收集所有时间标签
    TIME_TAG_RE.lastIndex = 0;
    const times = [];
    let m;
    while ((m = TIME_TAG_RE.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] || '';
      let ms = min * 60000 + sec * 1000;
      if (fracRaw) ms += fracRaw.length === 3 ? parseInt(fracRaw, 10) : parseInt(fracRaw, 10) * 10;
      times.push(ms);
    }
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    if (times.length) {
      for (const start of times) out.push({ start: start + offset, text });
    } else {
      out.push({ start: null, text });
    }
  }
  return out;
}

/** 读取与音频同目录同名的 .lrc（filePath: /music/歌手/歌.flac -> /music/歌手/歌.lrc）。找不到返回 null。 */
function readSidecarLrc(filePath) {
  if (!filePath) return null;
  const lrcPath = filePath.replace(/\.[^.\\/]+$/, '') + '.lrc';
  try {
    if (fs.existsSync(lrcPath)) {
      const st = fs.statSync(lrcPath);
      if (st.isFile()) {
        const content = fs.readFileSync(lrcPath, 'utf8');
        return content && String(content).trim() ? String(content) : null;
      }
    }
  } catch { /* 读取失败视为无 */ }
  return null;
}

/** 从 node-id3 读到的 tags 提取内嵌歌词（ID3 USLT）文本 */
function extractEmbeddedLyricsFromTags(tags) {
  try {
    if (!tags) return null;
    const uslt = tags.unsynchronisedLyrics || tags.lyrics;
    if (!uslt) return null;
    const items = Array.isArray(uslt) ? uslt : [uslt];
    for (const item of items) {
      const t = item && (item.text || item.lyrics);
      if (t && String(t).trim()) return String(t);
    }
  } catch { /* 忽略 */ }
  return null;
}

/**
 * 为歌曲文件做一次歌词收集（只读，优先级：同目录 .lrc > 音频内嵌歌词）。
 * @returns {Promise<{lyricRaw:string|null, lyricStruct:string|null, lyricSource:string}>}
 *   lyricSource: 'local_lrc' | 'embedded' | 'none'
 */
async function collectSongLyrics(filePath, isStrm, tags) {
  // 1. 同目录同名 .lrc 优先（文档歌词处理流程）
  const lrcRaw = readSidecarLrc(filePath);
  if (lrcRaw) {
    return {
      lyricRaw: lrcRaw,
      lyricStruct: JSON.stringify(parseLrcStruct(lrcRaw)),
      lyricSource: 'local_lrc'
    };
  }
  // 2. 非 strm 读音频内嵌歌词（node-id3 tags 已读则直接用，未读则补读）
  if (!isStrm) {
    let embedded = null;
    if (tags) embedded = extractEmbeddedLyricsFromTags(tags);
    if (!embedded) {
      try {
        // eslint-disable-next-line global-require
        const NodeID3 = require('node-id3');
        embedded = extractEmbeddedLyricsFromTags(NodeID3.read(filePath));
      } catch { embedded = null; }
    }
    if (embedded) {
      return {
        lyricRaw: embedded,
        lyricStruct: JSON.stringify(parseLrcStruct(embedded)),
        lyricSource: 'embedded'
      };
    }
  }
  return { lyricRaw: null, lyricStruct: null, lyricSource: 'none' };
}

module.exports = {
  parseLrcStruct,
  readSidecarLrc,
  extractEmbeddedLyricsFromTags,
  collectSongLyrics
};
