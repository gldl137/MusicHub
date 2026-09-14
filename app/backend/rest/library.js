'use strict';

/**
 * OpenSubsonic 媒体库 —— 以下载目录（DOWNLOAD_DIR）中的音频文件为数据源。
 *
 * 启动时扫描一次并缓存在内存中；getScanStatus/startScan 可触发重新扫描。
 * 每个文件解析出 artist/album/child(song) 三级实体，ID 使用稳定字符串前缀：
 *   ar-<md5>  艺术家
 *   al-<md5>  专辑
 *   tr-<md5>  歌曲
 *   ca-<md5>  封面（对应具体歌曲文件的内嵌图片）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NodeID3 = require('node-id3');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus']);

// 各格式默认码率（kbps），用于在缺少真实码率时估算时长/码率
const DEFAULT_BITRATE = {
  '.mp3': 128,
  '.m4a': 256,
  '.aac': 128,
  '.flac': 900,
  '.wav': 1411,
  '.ogg': 160,
  '.opus': 160
};

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg'
};

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

// 从文件名解析 "标题 - 艺术家.ext"
function parseFilename(fileName) {
  const base = path.basename(fileName, path.extname(fileName)).trim();
  const idx = base.lastIndexOf(' - ');
  if (idx > 0) {
    return {
      title: base.slice(0, idx).trim(),
      artist: base.slice(idx + 3).trim()
    };
  }
  return { title: base, artist: '' };
}

function estimateDuration(size, suffix) {
  if (!size || size <= 0) return null;
  const kbps = DEFAULT_BITRATE[suffix] || 128;
  return Math.max(1, Math.round((size * 8) / (kbps * 1000)));
}

// ---------------- 内存状态 ----------------
const state = {
  songs: [],            // [{ id, filePath, fileName, title, artist, album, genre, year, track, size, suffix, contentType, bitRate, duration, artistId, albumId, coverArt, hasCover, mtimeMs }]
  songsById: new Map(),
  artists: new Map(),   // name -> { id, name, albumIds:Set, coverArt }
  albums: new Map(),    // key(artistId::album) -> { id, name, artist, artistId, year, genre, coverArt, songIds:[] , created }
  lastModified: 0,
  dir: null,            // 最近一次扫描的下载目录
  fileSig: '',          // 目录指纹（文件名:size:mtime），用于检测目录变化自动重扫
  lastFreshCheckMs: 0   // ensureFresh 节流时间戳
};

function getSuffix(filePath) {
  return path.extname(filePath).toLowerCase();
}

function buildCoverId(filePath) {
  return 'ca-' + md5(filePath);
}

function buildArtistId(name) {
  return 'ar-' + md5(name);
}

function buildAlbumId(artist, album) {
  return 'al-' + md5(`${artist}\u0000${album}`);
}

function buildSongId(filePath) {
  return 'tr-' + md5(filePath);
}

/**
 * 计算下载目录的音频文件指纹（文件名:大小:修改时间），
 * 用于检测"文件被新增/删除/重命名/内容变化"，与上次扫描不一致则需重扫。
 */
function computeFileSig(dir) {
  const parts = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const f of entries) {
      if (!AUDIO_EXTS.has(path.extname(f).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (!st.isFile()) continue;
      parts.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`);
    }
  } catch {
    // 目录不可读（不存在/权限）时按空处理，触发清空
  }
  return parts.sort().join('\n');
}

function hasEmbeddedCover(filePath) {
  try {
    const tags = NodeID3.read(filePath);
    return !!(tags && tags.image && tags.image.imageBuffer);
  } catch {
    return false;
  }
}

/**
 * 扫描下载目录并重建内存索引（同步执行）。
 */
function scan(downloadDir) {
  if (!downloadDir || !fs.existsSync(downloadDir)) {
    state.songs = [];
    state.songsById = new Map();
    state.artists = new Map();
    state.albums = new Map();
    state.lastModified = Date.now();
    state.dir = downloadDir;
    state.fileSig = '';
    return state;
  }

  const songs = [];
  const songsById = new Map();
  const artists = new Map();
  const albums = new Map();

  let files = [];
  try {
    files = fs.readdirSync(downloadDir).filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
  } catch {
    files = [];
  }

  for (const fileName of files) {
    const filePath = path.join(downloadDir, fileName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const suffix = getSuffix(filePath);

    // 1) 尝试 ID3 标签
    let tags = {};
    try {
      tags = NodeID3.read(filePath) || {};
    } catch {
      tags = {};
    }

    // 2) 文件名兜底解析
    const parsed = parseFilename(fileName);

    const title = (tags.title && String(tags.title).trim()) || parsed.title || path.basename(fileName, suffix);
    let artist = (tags.artist && String(tags.artist).trim()) || parsed.artist || '未知艺术家';
    const album = (tags.album && String(tags.album).trim()) || '';

    // ID3 中可能有多个艺术家（斜杠分隔），OpenSubsonic 展示名保留原文
    artist = artist.replace(/\/{2,}/g, '/');

    const yearStr = tags.year !== undefined ? String(tags.year).replace(/\D/g, '').slice(0, 4) : '';
    const year = yearStr ? parseInt(yearStr, 10) : null;
    const genre = tags.genre ? String(tags.genre).trim() : null;
    const track = tags.trackNumber !== undefined ? parseInt(String(tags.trackNumber), 10) || null : null;
    const hasCover = hasEmbeddedCover(filePath);
    const size = stat.size;
    const bitRate = DEFAULT_BITRATE[suffix] || null;
    const duration = estimateDuration(size, suffix);

    const artistId = buildArtistId(artist);
    const albumKey = `${artistId}::${album}`;
    const albumId = buildAlbumId(artist, album);
    const songId = buildSongId(filePath);
    const coverArt = hasCover ? buildCoverId(filePath) : null;

    const song = {
      id: songId,
      filePath,
      fileName,
      title,
      artist,
      album,
      genre,
      year,
      track,
      size,
      suffix,
      contentType: CONTENT_TYPES[suffix] || 'application/octet-stream',
      bitRate,
      duration,
      artistId,
      albumId,
      coverArt,
      hasCover,
      mtimeMs: stat.mtimeMs
    };
    songs.push(song);
    songsById.set(songId, song);

    // 艺术家
    let artistObj = artists.get(artist);
    if (!artistObj) {
      artistObj = { id: artistId, name: artist, albumIds: new Set(), coverArt: null };
      artists.set(artist, artistObj);
    }
    artistObj.albumIds.add(albumId);
    if (!artistObj.coverArt && hasCover) artistObj.coverArt = coverArt;

    // 专辑
    let albumObj = albums.get(albumKey);
    if (!albumObj) {
      albumObj = {
        id: albumId,
        name: album,
        artist,
        artistId,
        year,
        genre,
        coverArt: hasCover ? coverArt : null,
        songIds: [],
        created: Math.round(stat.mtimeMs)
      };
      albums.set(albumKey, albumObj);
    }
    if (!albumObj.coverArt && hasCover) albumObj.coverArt = coverArt;
    if (!albumObj.year && year) albumObj.year = year;
    if (!albumObj.genre && genre) albumObj.genre = genre;
    albumObj.songIds.push(songId);
  }

  // 排序：歌曲按（专辑/曲目/文件名），保证浏览顺序稳定
  songs.sort((a, b) => {
    if (a.albumId !== b.albumId) return a.albumId < b.albumId ? -1 : 1;
    if ((a.track || 0) !== (b.track || 0)) return (a.track || 0) - (b.track || 0);
    return a.fileName < b.fileName ? -1 : 1;
  });

  // 专辑歌曲按歌单顺序
  for (const albumObj of albums.values()) {
    albumObj.songIds = albumObj.songIds
      .map((sid) => songsById.get(sid))
      .filter(Boolean)
      .sort((a, b) => {
        if ((a.track || 0) !== (b.track || 0)) return (a.track || 0) - (b.track || 0);
        return a.fileName < b.fileName ? -1 : 1;
      })
      .map((s) => s.id);
  }

  state.songs = songs;
  state.songsById = songsById;
  state.artists = artists;
  state.albums = albums;
  state.lastModified = Date.now();
  state.dir = downloadDir;
  state.fileSig = computeFileSig(downloadDir);
  return state;
}

// ---------------- 封面缓存（懒加载） ----------------
const coverCache = new Map(); // coverId -> { mime, buffer }

function getCover(coverId) {
  if (!coverId) return null;
  if (coverCache.has(coverId)) return coverCache.get(coverId);

  // 找到持有该封面的歌曲文件
  const song = state.songs.find((s) => s.coverArt === coverId);
  if (!song || !fs.existsSync(song.filePath)) return null;
  try {
    const tags = NodeID3.read(song.filePath);
    const img = tags && tags.image;
    if (!img || !img.imageBuffer) return null;
    const mime = img.mime || 'image/jpeg';
    const entry = { mime, buffer: img.imageBuffer };
    coverCache.set(coverId, entry);
    return entry;
  } catch {
    return null;
  }
}

function clearCoverCache() {
  coverCache.clear();
}

// ---------------- 对外查询接口 ----------------

function refresh(downloadDir) {
  clearCoverCache();
  return scan(downloadDir);
}

// 目录变化自动感知：节流检测目录指纹，检测到变化时自动重扫，
// 使"删除/新增下载歌曲"无需重启后端或手动调用 startScan 即可生效。
const FRESH_CHECK_INTERVAL = 4000; // 4 秒节流，避免频繁 readdir

function ensureFresh(dir) {
  if (!dir) return;
  const now = Date.now();
  if (now - state.lastFreshCheckMs < FRESH_CHECK_INTERVAL) return;
  state.lastFreshCheckMs = now;
  let sig;
  try {
    sig = computeFileSig(dir);
  } catch {
    sig = '';
  }
  if (sig !== state.fileSig) {
    refresh(dir);
  }
}

function getSongs() {
  return state.songs;
}

function getArtists() {
  return Array.from(state.artists.values());
}

function getAlbums() {
  return Array.from(state.albums.values());
}

function getArtistAlbums(artistId) {
  const artistObj = Array.from(state.artists.values()).find((a) => a.id === artistId);
  if (!artistObj) return [];
  return Array.from(artistObj.albumIds)
    .map((albumId) => Array.from(state.albums.values()).find((al) => al.id === albumId))
    .filter(Boolean);
}

function getAlbumSongs(albumId) {
  const albumObj = Array.from(state.albums.values()).find((al) => al.id === albumId);
  if (!albumObj) return [];
  return albumObj.songIds.map((sid) => state.songsById.get(sid)).filter(Boolean);
}

function getSongById(id) {
  return state.songsById.get(id) || null;
}

function findSongByTitleArtist(title, artist) {
  if (!title) return null;
  const titleLower = String(title).toLowerCase();

  // 先按 标题+艺术家 精确匹配
  if (artist) {
    const artistLower = String(artist).toLowerCase();
    const exact = state.songs.find((s) =>
      titleLower === s.title.toLowerCase() &&
      (artistLower === s.artist.toLowerCase() ||
        artistLower.includes(s.artist.toLowerCase()) ||
        s.artist.toLowerCase().includes(artistLower))
    );
    if (exact) return exact;
  }

  // 再退回 标题 唯一匹配（用做兜底，容忍艺术家含多位歌手/不同分隔符）
  const matches = state.songs.filter((s) => titleLower === s.title.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

function getLastModified() {
  return state.lastModified;
}

function getLibraryState() {
  return state;
}

module.exports = {
  refresh,
  scan,
  ensureFresh,
  getSongs,
  getArtists,
  getAlbums,
  getArtistAlbums,
  getAlbumSongs,
  getSongById,
  findSongByTitleArtist,
  getCover,
  getLastModified,
  getLibraryState
};
