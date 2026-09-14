'use strict';

// ==================== 本地音乐库持久化（SQLite）====================
// 数据模型：数据库只做"持久缓存"，进程内仍以内存 state 为工作集。
//   1) local_songs  本地歌曲扫描结果（元数据 + 封面缓存引用 + 歌词）。
//      关键约定（与《修改建议文档》一致）：
//        - 普通音频：不保存任何绝对路径，只存相对逻辑路径 rel_path（容器内 /app/music 下），
//          运行时用 MUSIC_DIR + '/' + rel_path 拼接容器完整路径；
//        - .strm 文件：额外在 strm_file_path 保存 strm 本体容器完整绝对路径（strm 本体可能不在音乐库内）；
//        - 封面：不存二进制，只存 cover_hash(MD5) + cover_relpath(cover/xxx.webp) + cover_source，
//          文件在 CACHE_DIR/cover 下全局去重共享；
//        - 歌词：lyric_raw 原始完整 LRC + lyric_struct 结构化时间轴 JSON + lyric_source，
//          用户磁盘源文件只读。
//   2) 库指纹等键值（library_sig / library_schema）存入系统 settings 表（键加 'local_meta:' 前缀）。
// 复用 database.js 的同一 sqlite 连接（避免多连接写锁冲突）。
// 为兼容"不依赖 sqlite3/bcrypt 原生模块"的冒烟测试环境，require 用 try/catch 降级。

const logger = require('../core/logger');

const MODULE = 'LOCAL-LIB-DB';
const REQ_ID = 'system';

const META_PREFIX = 'local_meta:';

// 数据库结构版本：升级/迁移后需全量重建缓存时递增。
// v4：专辑封面由独立 album_covers 表合并到 local_songs（album_cover_* 列），旧表迁移后删除。
const SCHEMA_VERSION = '4';

let db = null;
try {
  // eslint-disable-next-line global-require
  const database = require('../database');
  db = (database && database.db) || null;
} catch {
  db = null; // 无 sqlite3 环境（冒烟测试等）时降级为纯内存
}

let tablesReady = false;
let readyPromise = null;

// 目标 schema 列定义（不含历史遗留的 file_path / cover_url 绝对路径与旧封面列）
const LOCAL_SONGS_DEFS = [
  'id TEXT PRIMARY KEY',
  'rel_path TEXT NOT NULL UNIQUE',
  'file_name TEXT',
  'title TEXT',
  'artist TEXT',
  'album TEXT',
  'folder TEXT',
  'genre TEXT',
  'year INTEGER',
  'track INTEGER',
  'size INTEGER',
  'suffix TEXT',
  'duration INTEGER',
  'has_cover INTEGER DEFAULT 0',
  'mtime_ms INTEGER',
  'real_media_uri TEXT',
  'is_strm INTEGER DEFAULT 0',
  'cover_hash CHAR(32)',
  'cover_relpath TEXT',
  "cover_source TEXT DEFAULT 'none'",
  // 专辑封面（与 album_covers 独立表合并）：同一专辑的所有歌曲行冗余同一引用，
  // 读取时按 album+artist 取任意一行即可。字段命名/语义对齐上面的 cover_*（hash 同为 md5）。
  'album_cover_hash CHAR(32)',
  'album_cover_relpath TEXT',
  "album_cover_source TEXT DEFAULT 'none'",
  // 歌手头像（md5 落盘，与专辑封面同构）：同一歌手的所有歌曲行冗余同一引用，
  // 读取时按 artist 取任意一行即可。源为插件搜索后本地化的 'artist-real'。
  'artist_cover_hash CHAR(32)',
  'artist_cover_relpath TEXT',
  "artist_cover_source TEXT DEFAULT 'none'",
  'lyric_raw TEXT',
  'lyric_struct TEXT',
  "lyric_source TEXT DEFAULT 'none'",
  // （已废弃）track_cover_remote：纯内存方案不再读写远程 URL；列保留只为兼容旧库，不迁移删除
  'track_cover_remote TEXT',
  // 阶段0解析完成 = raw_parsed；阶段1成功 = meta_filled；阶段1失败/无结果 = meta_failed
  "scan_status TEXT NOT NULL DEFAULT 'raw_parsed'",
  // 播放懒加载负缓存：found=已补到；not_found=插件无结果（在 retry_at 前不再轰炸插件）
  'meta_lazy_status TEXT',
  'meta_lazy_retry_at INTEGER',
  // 补全失败冷却（风险4）：enrich_fail_reason 非空表示该曲最近一次补全仍缺字段；
  // last_enrich_try 为最后一次尝试时间戳。两者配合实现「24 小时内不再重复发起搜索」。
  'last_enrich_try INTEGER',
  'enrich_fail_reason TEXT',
  // 元数据来源标记（排查用）：id3=音频内嵌标签，path=目录路径解析，plugin=元数据插件，
  // manual=用户手动编辑，mixed=三个核心字段来源不一致（仅 meta_source 会出现）。
  // 阶段0（扫描解析）写入 id3/path；阶段1（插件补空）写入 plugin；手动编辑写入 manual。
  'title_source TEXT',
  'artist_source TEXT',
  'album_source TEXT',
  "meta_source TEXT DEFAULT 'none'",
  'strm_file_path TEXT',
  // ReplayGain 轨道增益（dB，音频标签 ReplayGain_Track_Gain；播放补全时读取，无标签为 NULL）
  'replay_gain REAL',
  'updated_at INTEGER'
];

// （已随纯内存方案废弃并删除的表：local_albums / local_artists / remote_image_cache——
//  封面绑定全部冗余在 local_songs 的 album_cover_* / artist_cover_* 列，启动时自动 DROP 遗留表）

// 需要从旧库清除的遗留列：file_path（普通音频绝对路径）与 cover_url（base64/网络 URL 封面）
const LEGACY_DROP_COLS = new Set(['file_path', 'cover_url']);

/** 建表（幂等；无数据库连接时直接返回） */
function ensureTables() {
  if (!db) return Promise.resolve();
  if (tablesReady) return Promise.resolve();
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_songs (
        ${LOCAL_SONGS_DEFS.join(',\n        ')}
      );
      -- 纯内存方案：删除已废弃的遗留表（幂等；不存在则跳过）
      DROP TABLE IF EXISTS remote_image_cache;
      DROP TABLE IF EXISTS local_albums;
      DROP TABLE IF EXISTS local_artists;
    `, (err) => {
      if (err) {
        readyPromise = null;
        logger.error(MODULE, REQ_ID, 'Failed to create local library tables', { error: logger.formatError(err) });
        reject(err);
      } else {
        // 兼容旧库：补充历史版本缺失的列（列已存在时报 duplicate column，按幂等忽略）
        const alters = [
          'ALTER TABLE local_songs ADD COLUMN real_media_uri TEXT',
          'ALTER TABLE local_songs ADD COLUMN is_strm INTEGER DEFAULT 0',
          'ALTER TABLE local_songs ADD COLUMN cover_hash CHAR(32)',
          'ALTER TABLE local_songs ADD COLUMN cover_relpath TEXT',
          "ALTER TABLE local_songs ADD COLUMN cover_source TEXT DEFAULT 'none'",
          'ALTER TABLE local_songs ADD COLUMN album_cover_hash CHAR(32)',
          'ALTER TABLE local_songs ADD COLUMN album_cover_relpath TEXT',
          "ALTER TABLE local_songs ADD COLUMN album_cover_source TEXT DEFAULT 'none'",
          'ALTER TABLE local_songs ADD COLUMN artist_cover_hash CHAR(32)',
          'ALTER TABLE local_songs ADD COLUMN artist_cover_relpath TEXT',
          "ALTER TABLE local_songs ADD COLUMN artist_cover_source TEXT DEFAULT 'none'",
          'ALTER TABLE local_songs ADD COLUMN lyric_raw TEXT',
          'ALTER TABLE local_songs ADD COLUMN lyric_struct TEXT',
          "ALTER TABLE local_songs ADD COLUMN lyric_source TEXT DEFAULT 'none'",
          'ALTER TABLE local_songs ADD COLUMN strm_file_path TEXT',
          'ALTER TABLE local_songs ADD COLUMN track_cover_remote TEXT',
          "ALTER TABLE local_songs ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'raw_parsed'",
          'ALTER TABLE local_songs ADD COLUMN meta_lazy_status TEXT',
          'ALTER TABLE local_songs ADD COLUMN meta_lazy_retry_at INTEGER',
          'ALTER TABLE local_songs ADD COLUMN last_enrich_try INTEGER',
          'ALTER TABLE local_songs ADD COLUMN enrich_fail_reason TEXT',
          // 元数据来源标记（旧库升级补齐）
          'ALTER TABLE local_songs ADD COLUMN title_source TEXT',
          'ALTER TABLE local_songs ADD COLUMN artist_source TEXT',
          'ALTER TABLE local_songs ADD COLUMN album_source TEXT',
          "ALTER TABLE local_songs ADD COLUMN meta_source TEXT DEFAULT 'none'",
          // ReplayGain 轨道增益（dB）：播放补全时从音频标签读取
          'ALTER TABLE local_songs ADD COLUMN replay_gain REAL'
        ];
        let pending = alters.length;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          // 基础防护：本地歌曲常用查询字段索引（title/artist/album），便于未来按需查询走 DB 时加速
          db.run('CREATE INDEX IF NOT EXISTS idx_local_songs_title ON local_songs(title)', () => {});
          db.run('CREATE INDEX IF NOT EXISTS idx_local_songs_artist ON local_songs(artist)', () => {});
          db.run('CREATE INDEX IF NOT EXISTS idx_local_songs_album ON local_songs(album)', () => {});
          // 清除历史遗留 file_path / cover_url 列（若表结构仍旧版则重建表迁移）
          migrateLegacyLocalSongsSchema().then(() => {
            // 旧版专辑封面独立表 album_covers：迁移到 local_songs 后 DROP，之后不再生成
            return migrateAlbumCoversTable().then(() => {
              tablesReady = true;
              logger.info(MODULE, REQ_ID, 'Local library tables ready', { schemaVersion: SCHEMA_VERSION, status: 'success' });
              resolve();
            });
          }).catch((e2) => {
            logger.error(MODULE, REQ_ID, 'Migrate legacy local_songs schema failed', { error: logger.formatError(e2) });
            tablesReady = true;
            resolve();
          });
        };
        alters.forEach((sql) => {
          db.run(sql, (e2) => {
            if (e2 && !/duplicate column/i.test(e2.message)) {
              logger.warn(MODULE, REQ_ID, 'Add local_songs column skipped', { error: logger.formatError(e2), sql });
            }
            pending -= 1;
            if (pending <= 0) finish();
          });
        });
      }
    });
  });
  return readyPromise;
}

/**
 * 清除 local_songs 中历史遗留的 file_path / cover_url 列：
 * SQLite 旧版本/约束场景下 DROP COLUMN 可能不可用，统一采用「重建表」方式迁移，
 * 数据无损（丢弃的列值本身是历史冗余：绝对路径与旧封面 URL，均可在下次扫描重建）。
 */
function migrateLegacyLocalSongsSchema() {
  return new Promise((resolve) => {
    db.all('PRAGMA table_info(local_songs)', (err, cols) => {
      if (err || !Array.isArray(cols) || !cols.length) return resolve();
      const names = cols.map((c) => c.name);
      const needDrop = names.some((n) => LEGACY_DROP_COLS.has(n));
      if (!needDrop) return resolve();
      const keepCols = LOCAL_SONGS_DEFS.map((d) => d.split(' ')[0]).filter((n) => !LEGACY_DROP_COLS.has(n));
      const srcCols = keepCols.filter((c) => names.includes(c));
      const steps = [
        'DROP TABLE IF EXISTS _local_songs_new',
        `CREATE TABLE _local_songs_new (${LOCAL_SONGS_DEFS.join(', ')})`,
        `INSERT INTO _local_songs_new (${srcCols.join(', ')}) SELECT ${srcCols.join(', ')} FROM local_songs`,
        'DROP TABLE local_songs',
        'ALTER TABLE _local_songs_new RENAME TO local_songs'
      ];
      db.run('PRAGMA foreign_keys = OFF', () => {
        let i = 0;
        const runStep = () => {
          if (i >= steps.length) {
            db.run('PRAGMA foreign_keys = ON', () => resolve());
            return;
          }
          const sql = steps[i++];
          db.run(sql, (se) => {
            if (se) {
              logger.warn(MODULE, REQ_ID, 'Rebuild local_songs legacy schema step failed', { sql, error: logger.formatError(se) });
              db.run('PRAGMA foreign_keys = ON', () => resolve());
              return;
            }
            runStep();
          });
        };
        runStep();
      });
      logger.info(MODULE, REQ_ID, 'local_songs legacy columns dropped (file_path/cover_url)', { dropped: Array.from(LEGACY_DROP_COLS).filter((n) => names.includes(n)) });
    });
  });
}

/** 读取全部本地歌曲（返回行对象数组，字段为下划线命名） */
function loadSongs() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve, reject) => {
    db.all('SELECT * FROM local_songs', (err, rows) => {
      if (err) {
        logger.error(MODULE, REQ_ID, 'loadSongs failed', { error: logger.formatError(err) });
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  }));
}

/** 全量覆盖写入本地歌曲（扫描完成后调用；事务内先清后写）。不落任何绝对路径（strm 本体除外）。
 *  注意：补全失败冷却（last_enrich_try/enrich_fail_reason）与播放懒加载负缓存（meta_lazy_*）
 *  属于「扫描之外的运行时状态」，全表覆盖时必须按 id 保留——否则每次扫描后 24h 冷却失效，
 *  插件确实搜不到的歌会被反复无效轰炸。 */
function replaceSongs(songs) {
  if (!db) return Promise.resolve({ count: 0 });
  return ensureTables().then(() => new Promise((resolve, reject) => {
    const now = Date.now();
    // 覆盖前读回需保留的运行时列（id → 旧值）
    db.all('SELECT id, last_enrich_try, enrich_fail_reason, meta_lazy_status, meta_lazy_retry_at FROM local_songs', (pe, prevRows) => {
      if (pe) logger.warn(MODULE, REQ_ID, 'replaceSongs read prev runtime cols failed', { error: logger.formatError(pe) });
      const prevMap = new Map();
      for (const r of prevRows || []) prevMap.set(r.id, r);

      const rows = (songs || []).map((s) => {
        const relPath = s.relPath || ((s.folder ? s.folder + '/' : '') + (s.fileName || ''));
        // strm 本体绝对路径（.strm 文件可能不在音乐库内，需独立记录真实路径用于读取远程地址）
        const strmFilePath = s.isStrm ? (s.strmFilePath || s.filePath || null) : null;
        // 后端 album 只允许真实专辑名或空；占位文字（未知专辑/未知）一律归空
        const rawAlbum = String(s.album == null ? '' : s.album).trim();
        const album = (rawAlbum && rawAlbum !== '未知专辑' && rawAlbum !== '未知') ? rawAlbum : '';
        const prev = prevMap.get(s.id) || {};
        return [
          s.id,
          relPath,
          s.fileName,
          s.title,
          s.artist,
          album,
          s.folder,
          s.genre,
          s.year,
          s.track,
          s.size,
          s.suffix,
          s.duration,
          s.hasCover ? 1 : 0,
          s.mtimeMs || null,
          s.realMediaUri || null,
          s.isStrm ? 1 : 0,
          s.coverHash || null,
          s.coverRelpath || null,
          s.coverSource || 'none',
          s.albumCoverHash || null,
          s.albumCoverRelpath || null,
          s.albumCoverSource || 'none',
          s.artistCoverHash || null,
          s.artistCoverRelpath || null,
          s.artistCoverSource || 'none',
          s.lyricRaw || null,
          s.lyricStruct || null,
          s.lyricSource || 'none',
          s.trackCoverRemote || null,
          (s.replayGain == null ? null : Number(s.replayGain)),
          s.scanStatus || 'raw_parsed',
          s.titleSource || null,
          s.artistSource || null,
          s.albumSource || null,
          s.metaSource || 'none',
          strmFilePath,
          prev.last_enrich_try != null ? prev.last_enrich_try : null,
          prev.enrich_fail_reason != null ? prev.enrich_fail_reason : null,
          prev.meta_lazy_status != null ? prev.meta_lazy_status : null,
          prev.meta_lazy_retry_at != null ? prev.meta_lazy_retry_at : null,
          now
        ];
      });

      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (e) => { if (e) logger.warn(MODULE, REQ_ID, 'BEGIN TRANSACTION failed (likely nested transaction)', { error: logger.formatError(e) }); });
        db.run('DELETE FROM local_songs');
        const stmt = db.prepare(`INSERT OR REPLACE INTO local_songs (
          id, rel_path, file_name, title, artist, album, folder, genre,
          year, track, size, suffix, duration, has_cover, mtime_ms, real_media_uri, is_strm,
          cover_hash, cover_relpath, cover_source,
          album_cover_hash, album_cover_relpath, album_cover_source,
          artist_cover_hash, artist_cover_relpath, artist_cover_source,
          lyric_raw, lyric_struct, lyric_source, track_cover_remote, scan_status,
          title_source, artist_source, album_source, meta_source,
          strm_file_path, last_enrich_try, enrich_fail_reason,
          meta_lazy_status, meta_lazy_retry_at, replay_gain, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) stmt.run(r);
      stmt.finalize((err) => {
        if (err) {
          db.run('ROLLBACK');
          logger.error(MODULE, REQ_ID, 'replaceSongs failed', { error: logger.formatError(err) });
          reject(err);
        } else {
          db.run('COMMIT', (e) => {
            if (e) {
              logger.error(MODULE, REQ_ID, 'replaceSongs commit failed', { error: logger.formatError(e) });
              reject(e);
            } else {
              resolve({ count: rows.length });
            }
          });
        }
      });
    });
    });
  }));
}

/** 统计本地库数据库歌曲条数 */
function getStats() {
  if (!db) return Promise.resolve({ songs: 0 });
  return ensureTables().then(() => new Promise((resolve) => {
    db.get('SELECT COUNT(*) AS n FROM local_songs', (e1, r1) => {
      if (e1) logger.warn(MODULE, REQ_ID, 'getStats songs failed', { error: logger.formatError(e1) });
      resolve({ songs: (r1 && r1.n) || 0 });
    });
  }));
}

/** 清空本地音乐库数据（local_songs 及 settings 中 local_meta: 前缀键值），用于"清理本地文件数据" */
function clearLocalData() {
  if (!db) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve, reject) => {
    db.exec("DELETE FROM local_songs; DELETE FROM settings WHERE key LIKE 'local_meta:%';", (err) => {
      if (err) {
        logger.warn(MODULE, REQ_ID, 'clearLocalData failed', { error: logger.formatError(err) });
        reject(err);
      } else {
        logger.info(MODULE, REQ_ID, 'Local library data cleared (songs/meta)');
        resolve();
      }
    });
  })).catch((err) => {
    logger.warn(MODULE, REQ_ID, 'clearLocalData error', { error: logger.formatError(err) });
  });
}

/** 读取同专辑歌曲已有的封面相对路径（按 album+artist 复用同一张封面缓存文件）。无命中返回 null。 */
function getAlbumCoverRelpath(album, artist) {
  if (!db) return Promise.resolve(null);
  const a = String(album || '').trim();
  const ar = String(artist || '').trim();
  if (!a) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      "SELECT cover_relpath FROM local_songs WHERE album = ? AND artist = ? AND cover_relpath IS NOT NULL AND cover_relpath <> '' ORDER BY updated_at DESC LIMIT 1",
      [a, ar],
      (err, row) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'getAlbumCoverRelpath failed', { error: logger.formatError(err) });
          resolve(null);
        } else {
          resolve(row && row.cover_relpath ? row.cover_relpath : null);
        }
      }
    );
  }));
}

/** 清理历史遗留的专辑占位文字（"未知专辑"/"未知" → 空，供播放时搜索回填真实专辑）。 */
function sanitizeUnknownAlbumPlaceholders() {
  if (!db) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET album = '' WHERE album = '未知专辑' OR album = '未知'",
      () => {
        logger.info(MODULE, REQ_ID, 'Unknown-album placeholders sanitized');
        resolve();
      }
    );
  })).catch((err) => {
    logger.warn(MODULE, REQ_ID, 'Sanitize unknown-album placeholders failed', { error: logger.formatError(err) });
  });
}

// ---------------- 播放时按需写回（歌词 / 封面） ----------------

/** 按 id 回填歌词到数据库（保持用户磁盘文件只读，歌词全部存 DB） */
/** 按歌曲 id 回填 ReplayGain 轨道增益（dB；播放补全时从音频标签读取） */
function updateReplayGainForId(id, gain) {
  if (!db || !id) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      `UPDATE local_songs SET replay_gain = ?, updated_at = ? WHERE id = ?`,
      [gain == null ? null : Number(gain), Date.now(), id],
      (err) => {
        if (err) logger.warn(MODULE, REQ_ID, 'updateReplayGainForId failed', { id, error: logger.formatError(err) });
        resolve();
      }
    );
  }));
}

function updateLyricsForId(id, lyric) {  if (!db || !id) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      `UPDATE local_songs SET lyric_raw = ?, lyric_struct = ?, lyric_source = ?, updated_at = ? WHERE id = ?`,
      [
        (lyric && lyric.raw) || null,
        (lyric && lyric.struct) || null,
        (lyric && lyric.source) || 'none',
        Date.now(),
        id
      ],
      (err) => {
        if (err) logger.warn(MODULE, REQ_ID, 'updateLyricsForId failed', { id, error: logger.formatError(err) });
        resolve();
      }
    );
  }));
}

/** 按 rel_path 回填歌词（strm / 封面补全链路按路径定位时使用） */
function updateLyricsForRelPath(relPath, lyric) {
  if (!db || !relPath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      `UPDATE local_songs SET lyric_raw = ?, lyric_struct = ?, lyric_source = ?, updated_at = ? WHERE rel_path = ?`,
      [
        (lyric && lyric.raw) || null,
        (lyric && lyric.struct) || null,
        (lyric && lyric.source) || 'none',
        Date.now(),
        relPath
      ],
      (err) => {
        if (err) logger.warn(MODULE, REQ_ID, 'updateLyricsForRelPath failed', { relPath, error: logger.formatError(err) });
        resolve();
      }
    );
  }));
}

/** 按 id 读取歌词（供 OpenSubsonic getLyrics 直接读数据库 lyric_raw/lyric_struct） */
function loadLyricForId(id) {
  if (!db || !id) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      'SELECT lyric_raw, lyric_struct, lyric_source FROM local_songs WHERE id = ?',
      [id],
      (err, row) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadLyricForId failed', { id, error: logger.formatError(err) });
          resolve(null);
        } else {
          resolve(row || null);
        }
      }
    );
  }));
}

/** 按 id（tr- + md5(相对路径)）读取完整本地歌曲行，供内存库缺失时的回查兜底 */
function loadLocalSongById(id) {
  if (!db || !id) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get('SELECT * FROM local_songs WHERE id = ? LIMIT 1', [String(id)], (err, row) => {
      if (err) {
        logger.warn(MODULE, REQ_ID, 'loadLocalSongById failed', { id, error: logger.formatError(err) });
        resolve(null);
      } else {
        resolve(row || null);
      }
    });
  }));
}

/** 按 rel_path 读取一行“已持久化内容”字段（封面 + 歌词），供补全前 DB 命中判断（重启后不重复联网搜索） */
function loadLocalSongByRelPath(relPath) {
  if (!db || !relPath) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      `SELECT id, cover_relpath, album, duration, lyric_raw, lyric_struct, lyric_source
       FROM local_songs WHERE rel_path = ? LIMIT 1`,
      [String(relPath)],
      (err, row) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadLocalSongByRelPath failed', { relPath, error: logger.formatError(err) });
          resolve(null);
        } else {
          resolve(row || null);
        }
      }
    );
  }));
}

/** 读取全部已有歌词字段（id + lyric_raw/lyric_struct/lyric_source），供 persistScan 覆盖前合并回内存 */
function loadLyricFields() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      "SELECT id, lyric_raw, lyric_struct, lyric_source FROM local_songs WHERE lyric_raw IS NOT NULL AND lyric_raw <> ''",
      (err, rows) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadLyricFields failed', { error: logger.formatError(err) });
          resolve([]);
        } else {
          resolve(rows || []);
        }
      }
    );
  }));
}

/** 读取全部 cover_hash，供封面缓存垃圾清理判断引用 */
function loadCoverHashes() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all("SELECT cover_hash, cover_relpath FROM local_songs WHERE cover_hash IS NOT NULL AND cover_hash <> ''", (err, rows) => {
      if (err) {
        logger.warn(MODULE, REQ_ID, 'loadCoverHashes failed', { error: logger.formatError(err) });
        resolve([]);
      } else {
        resolve(rows || []);
      }
    });
  }));
}

/** 读取 cover/ 目录需要保留的 hash 引用并集：单曲 cover_hash ∪ 专辑封面 album_cover_hash（去重） */
function loadAllCoverHashes() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      `SELECT hash FROM (
         SELECT cover_hash AS hash FROM local_songs WHERE cover_hash IS NOT NULL AND cover_hash <> ''
         UNION
         SELECT album_cover_hash AS hash FROM local_songs WHERE album_cover_hash IS NOT NULL AND album_cover_hash <> ''
       )`,
      (err, rows) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadAllCoverHashes failed', { error: logger.formatError(err) });
          resolve([]);
        } else {
          resolve(rows || []);
        }
      }
    );
  }));
}

/** 读取 art/ 目录需要保留的歌手头像 hash 引用（artist_cover_hash，去重） */
function loadArtistCoverHashes() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      "SELECT artist_cover_hash AS hash FROM local_songs WHERE artist_cover_hash IS NOT NULL AND artist_cover_hash <> ''",
      (err, rows) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadArtistCoverHashes failed', { error: logger.formatError(err) });
          resolve([]);
        } else {
          resolve(rows || []);
        }
      }
    );
  }));
}

// ---------------- 专辑封面（合并至 local_songs 单表） ----------------
// 说明：album_covers 独立表已废弃（不再建表/写入）。专辑封面引用冗余存到
// local_songs 的 album_cover_hash / album_cover_relpath / album_cover_source
// 三列（对齐上面单曲封面 cover_* 字段，album_cover_hash 存 md5）。同一专辑的
// 所有歌曲行写入相同引用；读取时按 album+artist 取任意一行即可。

/** 旧库迁移：把已存在的 album_covers 表数据写入 local_songs 对应歌曲行后 DROP 该表 */
function migrateAlbumCoversTable() {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='album_covers'", (err, row) => {
      // 表不存在 → 无需迁移
      if (err || !row) return resolve();
      db.all('SELECT * FROM album_covers', (e, rows) => {
        const dropTable = (cb) => {
          db.run('DROP TABLE IF EXISTS album_covers', () => {
            logger.info(MODULE, REQ_ID, 'Legacy album_covers dropped (merged into local_songs)');
            cb();
          });
        };
        if (e) {
          // 读旧表失败：数据无法迁移，但旧表必须清掉，避免后续代码误以为仍在用独立表
          logger.warn(MODULE, REQ_ID, 'Read legacy album_covers failed, drop table anyway', { error: logger.formatError(e) });
          return dropTable(() => resolve());
        }
        const now = Date.now();
        db.serialize(() => {
          db.run('BEGIN TRANSACTION', (e) => { if (e) logger.warn(MODULE, REQ_ID, 'BEGIN TRANSACTION failed (likely nested transaction)', { error: logger.formatError(e) }); });
          const stmt = db.prepare(
            `UPDATE local_songs SET album_cover_relpath = ?, album_cover_hash = ?, album_cover_source = ?, updated_at = ?
             WHERE album = ? AND artist = ? AND (album_cover_relpath IS NULL OR album_cover_relpath = '')`
          );
          for (const r of rows || []) {
            const album = String(r.album == null ? '' : r.album).trim();
            if (!album) continue;
            stmt.run(
              r.cover_relpath || null,
              r.cover_hash || null,
              r.cover_source || 'none',
              now,
              album,
              r.artist == null ? null : String(r.artist).trim()
            );
          }
          stmt.finalize((err2) => {
            if (err2) {
              logger.warn(MODULE, REQ_ID, 'Migrate album_covers failed', { error: logger.formatError(err2) });
              db.run('ROLLBACK', () => dropTable(() => resolve()));
              return;
            }
            db.run('COMMIT', () => {
              logger.info(MODULE, REQ_ID, 'Legacy album_covers migrated into local_songs & dropped', { rows: (rows || []).length });
              dropTable(() => resolve());
            });
          });
        });
      });
    });
  });
}

/** 全量写入歌手头像到 local_songs：按 artist 把该歌手所有歌曲行的 artist_cover_* 一起更新。 */
function replaceArtistCovers(records) {
  if (!db) return Promise.resolve({ count: 0 });
  if (!records || !records.length) return Promise.resolve({ count: 0 });
  return ensureTables().then(() => new Promise((resolve, reject) => {
    const now = Date.now();
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (e) => { if (e) logger.warn(MODULE, REQ_ID, 'BEGIN TRANSACTION failed (likely nested transaction)', { error: logger.formatError(e) }); });
      const stmt = db.prepare(
        `UPDATE local_songs SET artist_cover_relpath = ?, artist_cover_hash = ?, artist_cover_source = ?, updated_at = ?
         WHERE artist = ?`
      );
      for (const r of records) {
        const artist = String(r.artist == null ? '' : r.artist).trim();
        if (!artist) continue;
        stmt.run(
          r.coverRelpath || null,
          r.coverHash || null,
          r.coverSource || 'none',
          now,
          artist
        );
      }
      stmt.finalize((err) => {
        if (err) {
          db.run('ROLLBACK');
          logger.error(MODULE, REQ_ID, 'replaceArtistCovers failed', { error: logger.formatError(err) });
          reject(err);
        } else {
          db.run('COMMIT', (e) => {
            if (e) {
              logger.error(MODULE, REQ_ID, 'replaceArtistCovers commit failed', { error: logger.formatError(e) });
              reject(e);
            } else {
              resolve({ count: records.length });
            }
          });
        }
      });
    });
  }));
}

/** 全量写入专辑封面到 local_songs：按 album+artist 把该专辑所有歌曲行的 album_cover_* 一起更新。 */
function replaceAlbumCovers(records) {
  if (!db) return Promise.resolve({ count: 0 });
  if (!records || !records.length) return Promise.resolve({ count: 0 });
  return ensureTables().then(() => new Promise((resolve, reject) => {
    const now = Date.now();
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (e) => { if (e) logger.warn(MODULE, REQ_ID, 'BEGIN TRANSACTION failed (likely nested transaction)', { error: logger.formatError(e) }); });
      const stmt = db.prepare(
        `UPDATE local_songs SET album_cover_relpath = ?, album_cover_hash = ?, album_cover_source = ?, updated_at = ?
         WHERE album = ? AND artist = ?`
      );
      for (const r of records) {
        const album = String(r.album == null ? '' : r.album).trim();
        if (!album) continue;
        stmt.run(
          r.coverRelpath || null,
          r.coverHash || null,
          r.coverSource || 'none',
          now,
          album,
          r.artist == null ? null : String(r.artist).trim()
        );
      }
      stmt.finalize((err) => {
        if (err) {
          db.run('ROLLBACK');
          logger.error(MODULE, REQ_ID, 'replaceAlbumCovers failed', { error: logger.formatError(err) });
          reject(err);
        } else {
          db.run('COMMIT', (e) => {
            if (e) {
              logger.error(MODULE, REQ_ID, 'replaceAlbumCovers commit failed', { error: logger.formatError(e) });
              reject(e);
            } else {
              resolve({ count: records.length });
            }
          });
        }
      });
    });
  }));
}

/** 读取已持久化到 local_songs 的歌手头像（按 artist 去重），供冷启动快速加载到内存 */
function loadArtistCovers() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      `SELECT artist, artist_cover_relpath AS cover_relpath, artist_cover_hash AS cover_hash, artist_cover_source AS cover_source
       FROM local_songs
       WHERE artist_cover_relpath IS NOT NULL AND artist_cover_relpath <> '' AND artist_cover_relpath LIKE 'art/%'
       GROUP BY artist`,
      (err, rows) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadArtistCovers failed', { error: logger.formatError(err) });
          resolve([]);
        } else {
          resolve(rows || []);
        }
      }
    );
  }));
}

/** 读取某歌手已持久化的歌手头像 relpath（无命中返回 null） */
function getArtistCoverRelpath(artist) {
  if (!db || !artist) return Promise.resolve(null);
  const a = String(artist).trim();
  if (!a) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      "SELECT artist_cover_relpath FROM local_songs WHERE artist = ? AND artist_cover_relpath IS NOT NULL AND artist_cover_relpath <> '' ORDER BY updated_at DESC LIMIT 1",
      [a],
      (err, row) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'getArtistCoverRelpath failed', { error: logger.formatError(err) });
          resolve(null);
        } else {
          resolve(row && row.artist_cover_relpath ? row.artist_cover_relpath : null);
        }
      }
    );
  }));
}

/** 读取已持久化到 local_songs 的专辑封面（按 album+artist 去重），供冷启动快速加载到内存 */
function loadAlbumCovers() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      `SELECT album, artist, album_cover_relpath AS cover_relpath, album_cover_hash AS cover_hash, album_cover_source AS cover_source
       FROM local_songs
       WHERE album_cover_relpath IS NOT NULL AND album_cover_relpath <> ''
       GROUP BY album, artist`,
      (err, rows) => {
        if (err) {
          logger.warn(MODULE, REQ_ID, 'loadAlbumCovers failed', { error: logger.formatError(err) });
          resolve([]);
        } else {
          resolve(rows || []);
        }
      }
    );
  }));
}

// ---------------- 键值（settings 表，键加 local_meta: 前缀） ----------------

/** 读取键值 */
function getMeta(key) {
  if (!db) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve, reject) => {
    db.get('SELECT value FROM settings WHERE key = ?', [META_PREFIX + key], (err, row) => {
      if (err) {
        logger.error(MODULE, REQ_ID, 'getMeta failed', { error: logger.formatError(err) });
        reject(err);
      } else {
        resolve(row ? row.value : null);
      }
    });
  }));
}

/** 写入键值 */
function setMeta(key, value) {
  if (!db) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
      [META_PREFIX + key, value, now, value, now],
      (err) => {
        if (err) {
          logger.error(MODULE, REQ_ID, 'setMeta failed', { error: logger.formatError(err) });
          reject(err);
        } else {
          resolve();
        }
      }
    );
  }));
}

/** 读取「歌手/专辑封面补全未命中」时间戳表（JSON：kind|... → ts）。
 * 持久化目的是跨重启保留“搜过但没搜到”的状态，避免每次重启后整库重新联网风暴。 */
function loadCoverFillMiss() {
  return getMeta('coverfill_miss')
    .then((v) => {
      if (!v) return {};
      try {
        const o = JSON.parse(v);
        return o && typeof o === 'object' ? o : {};
      } catch (e) {
        return {};
      }
    })
    .catch(() => ({}));
}

/** 持久化「封面补全未命中」时间戳表 */
function saveCoverFillMiss(data) {
  try {
    return setMeta('coverfill_miss', JSON.stringify(data || {}));
  } catch (e) {
    return Promise.resolve();
  }
}

// ---------------- 阶段1：歌曲元数据（track_cover_remote / scan_status） ----------------

/** 读取全部歌曲的 scan_status（rel_path → scan_status 映射），供流水线结束后把内存状态同步回真实 DB 状态，
 *  避免 monitor 增量扫描时因内存状态过期而把整库误判为 raw_parsed 重跑。 */
function loadScanStatuses() {
  if (!db) return Promise.resolve(new Map());
  return ensureTables().then(() => new Promise((resolve) => {
    db.all('SELECT rel_path, scan_status FROM local_songs', (err, rows) => {
      if (err) { logger.warn(MODULE, REQ_ID, 'loadScanStatuses failed', { error: logger.formatError(err) }); resolve(new Map()); }
      else {
        const m = new Map();
        for (const r of (rows || [])) m.set(r.rel_path, r.scan_status);
        resolve(m);
      }
    });
  }));
}

/** 取所有待处理的 raw_parsed 歌曲（阶段1输入） */
function getRawParsedSongs() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      "SELECT id, rel_path, title, artist, album, cover_relpath, album_cover_relpath, artist_cover_relpath, lyric_raw, duration, is_strm FROM local_songs WHERE scan_status = 'raw_parsed'",
      (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getRawParsedSongs failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      }
    );
  }));
}

/** 手动完整扫描：把所有歌曲状态重置为 raw_parsed，重新走阶段1-3 */
function resetScanStatusAll() {
  if (!db) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run("UPDATE local_songs SET scan_status = 'raw_parsed'", (err) => {
      if (err) logger.warn(MODULE, REQ_ID, 'resetScanStatusAll failed', { error: logger.formatError(err) });
      resolve();
    });
  }));
}

/** 阶段2：去重取所有非空歌手名（过滤空名称/脏数据） */
function getDistinctArtists() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      "SELECT artist, MAX(artist_cover_relpath) AS artist_cover_relpath FROM local_songs WHERE artist IS NOT NULL AND artist <> '' AND TRIM(artist) <> '' GROUP BY artist",
      (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getDistinctArtists failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve((rows || []).map((r) => ({ artist: String(r.artist).trim(), artist_cover_relpath: r.artist_cover_relpath || null })).filter((x) => x.artist));
      }
    );
  }));
}

/** 阶段1：写入歌曲封面远程 URL 与扫描状态（null 原样存 null） */
function setTrackMeta(relPath, trackCoverRemote, scanStatus) {
  if (!db || !relPath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      'UPDATE local_songs SET track_cover_remote = ?, scan_status = ?, updated_at = ? WHERE rel_path = ?',
      [trackCoverRemote != null ? String(trackCoverRemote) : null, scanStatus || 'meta_failed', Date.now(), String(relPath)],
      (err) => { if (err) logger.warn(MODULE, REQ_ID, 'setTrackMeta failed', { relPath, error: logger.formatError(err) }); resolve(); }
    );
  }));
}

/** 读取单首歌的封面远程 URL（OpenSubsonic 用） */
function getSongCoverRemote(relPath) {
  if (!db || !relPath) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get('SELECT track_cover_remote, scan_status FROM local_songs WHERE rel_path = ? LIMIT 1', [String(relPath)], (err, row) => {
      if (err) { logger.warn(MODULE, REQ_ID, 'getSongCoverRemote failed', { error: logger.formatError(err) }); resolve(null); }
      else resolve(row || null);
    });
  }));
}

// ---------------- 播放懒加载负缓存（meta_lazy_status / meta_lazy_retry_at） ----------------

/** 读取歌曲懒加载状态：远程封面 url、扫描状态、负缓存状态与重试时间、标题/歌手/专辑 */
function getLazyMetaState(relPath) {
  if (!db || !relPath) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      'SELECT track_cover_remote, scan_status, meta_lazy_status, meta_lazy_retry_at, title, artist, album FROM local_songs WHERE rel_path = ? LIMIT 1',
      [String(relPath)],
      (err, row) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getLazyMetaState failed', { error: logger.formatError(err) }); resolve(null); }
        else resolve(row || null);
      }
    );
  }));
}

/** 写入懒加载负缓存状态（只动 meta_lazy_status / meta_lazy_retry_at，绝不触碰 track_cover_remote / scan_status，避免与批量阶段1互相覆盖） */
function setLazyMeta(relPath, lazy) {
  if (!db || !relPath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      'UPDATE local_songs SET meta_lazy_status = ?, meta_lazy_retry_at = ? WHERE rel_path = ?',
      [lazy && lazy.lazyStatus ? String(lazy.lazyStatus) : null, lazy && lazy.lazyRetryAt != null ? Number(lazy.lazyRetryAt) : null, String(relPath)],
      (err) => { if (err) logger.warn(MODULE, REQ_ID, 'setLazyMeta failed', { error: logger.formatError(err) }); resolve(); }
    );
  }));
}

// ---------------- 本地专辑 / 歌手表（仅存 remote URL） ----------------

/**
 * 写入专辑封面远程 URL：仅当本字段当前为 NULL/空，且新 url 非空才更新；
 * 已有有效值绝不覆盖；绝对禁止拿歌曲封面 url 填充专辑字段。
 *
 * 并发安全（无需额外锁）：INSERT OR IGNORE 保证行唯一；UPDATE 带 WHERE
 * (album_cover_remote IS NULL OR album_cover_remote = '')，SQLite 的 UPDATE 是原子的，
 * 第二名并发写入者读到非空后 WHERE 不成立、不会覆盖；先到者胜出，永不互相 clobber。
 * 同一 url 被多实体引用时，remote_image_cache 的 INSERT OR IGNORE(pending) 保证只下载一次，
 * 二者结合实现整条链路的幂等。
 */
// ---------------- 封面本地化绑定（纯内存方案：URL 绝不写入业务表，只绑本地 webp 路径） ----------------
// 下载引擎（remote_image_cache）成功后回调绑定。三组绑定都带「仅填空」守卫：
// 绝不覆盖已内嵌/已本地化的封面（歌曲封面 cover_*、专辑 album_cover_*、歌手 artist_cover_* 各自独立隔离）。

/** 歌曲封面绑定：仅当该曲尚无本地封面时写入（cover_relpath/cover_hash） */
function bindSongCover(relPath, coverRelpath, coverHash) {
  if (!db || !relPath || !coverRelpath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET cover_relpath = ?, cover_hash = ?, cover_source = 'plugin', updated_at = ? WHERE rel_path = ? AND (cover_relpath IS NULL OR cover_relpath = '')",
      [String(coverRelpath), coverHash || null, Date.now(), String(relPath)],
      function (err) {
        if (err) logger.warn(MODULE, REQ_ID, 'bindSongCover failed', { relPath, error: logger.formatError(err) });
        else logger.debug(MODULE, REQ_ID, 'song cover bound', { relPath, relpath: coverRelpath, rows: this.changes || 0 });
        resolve();
      }
    );
  }));
}

/** 专辑封面绑定：该专辑全部歌曲行冗余写入 album_cover_*（与歌曲封面字段隔离，绝不写 cover_relpath）。
 *  rows=0 说明 WHERE album+artist 没匹配到任何行（专辑名/歌手名与库内不一致），属异常需关注。 */
function bindAlbumCover(album, artist, coverRelpath, coverHash) {
  if (!db || !album || !coverRelpath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET album_cover_relpath = ?, album_cover_hash = ?, album_cover_source = 'album-real', updated_at = ? WHERE album = ? AND artist = ? AND (album_cover_relpath IS NULL OR album_cover_relpath = '')",
      [String(coverRelpath), coverHash || null, Date.now(), String(album).trim(), String(artist || '').trim()],
      function (err) {
        const rows = this.changes || 0;
        if (err) logger.warn(MODULE, REQ_ID, 'bindAlbumCover failed', { album, artist, error: logger.formatError(err) });
        else if (rows > 0) logger.debug(MODULE, REQ_ID, 'album cover bound', { album, artist, relpath: coverRelpath, rows });
        else logger.warn(MODULE, REQ_ID, 'album cover bound 0 rows (album/artist mismatch?)', { album, artist, relpath: coverRelpath });
        resolve();
      }
    );
  }));
}

/** 歌手头像绑定：该歌手全部歌曲行冗余写入 artist_cover_*（仅填空） */
function bindArtistCover(artist, coverRelpath, coverHash) {
  if (!db || !artist || !coverRelpath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET artist_cover_relpath = ?, artist_cover_hash = ?, artist_cover_source = 'artist-real', updated_at = ? WHERE artist = ? AND (artist_cover_relpath IS NULL OR artist_cover_relpath = '')",
      [String(coverRelpath), coverHash || null, Date.now(), String(artist).trim()],
      function (err) {
        if (err) logger.warn(MODULE, REQ_ID, 'bindArtistCover failed', { artist, error: logger.formatError(err) });
        else logger.debug(MODULE, REQ_ID, 'artist cover bound', { artist, relpath: coverRelpath, rows: this.changes || 0 });
        resolve();
      }
    );
  }));
}

/** 歌词绑定：仅当该曲尚无歌词（lyric_raw 为空）时写入，绝不覆盖已有歌词 */
function bindLyrics(relPath, rawLrc, structJson) {
  if (!db || !relPath || !rawLrc) return Promise.resolve();
  const raw = String(rawLrc);
  if (!raw.trim()) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET lyric_raw = ?, lyric_struct = ?, lyric_source = ?, updated_at = ? WHERE rel_path = ? AND (lyric_raw IS NULL OR lyric_raw = '')",
      [raw, structJson || null, 'network', Date.now(), String(relPath)],
      function (err) {
        if (err) logger.warn(MODULE, REQ_ID, 'bindLyrics failed', { relPath, error: logger.formatError(err) });
        else logger.debug(MODULE, REQ_ID, 'lyrics bound', { relPath, rows: this.changes || 0 });
        resolve();
      }
    );
  }));
}

/** 筛选「存在缺失」的歌曲（只补缺失原则）。only: 'all' | 'image' | 'lyric' */
function getIncompleteSongs(only) {
  if (!db) return Promise.resolve([]);
  const mode = String(only || 'all');
  const condImage = "(cover_relpath IS NULL OR cover_relpath = '' OR album_cover_relpath IS NULL OR album_cover_relpath = '' OR artist_cover_relpath IS NULL OR artist_cover_relpath = '')";
  const condLyric = "(lyric_raw IS NULL OR lyric_raw = '')";
  let where = condImage;
  if (mode === 'lyric') where = condLyric;
  else if (mode === 'all') where = `(${condImage} OR ${condLyric})`;
  const sql = `SELECT id, rel_path, title, artist, album, cover_relpath, album_cover_relpath, artist_cover_relpath, lyric_raw, duration, is_strm
               FROM local_songs WHERE ${where}`;
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(sql, [], (err, rows) => {
      if (err) { logger.warn(MODULE, REQ_ID, 'getIncompleteSongs failed', { error: logger.formatError(err) }); resolve([]); }
      else resolve(rows || []);
    });
  }));
}

// ---------------- 补全失败冷却 + 分页流式取待处理（风险4 / 风险1）----------------

// rel_path 批量过滤：SQLite 变量上限（旧版 999）——IN (?,...) 占位符超限会让查询抛错
// 导致 monitor 自动入库静默失效。超过 REL_PATH_BATCH_MAX 的大批量改走临时表 JOIN
// （调用方先经 prepareRelPathFilter 建表，随后用 relPathFilterSql 组装条件）。
const REL_PATH_BATCH_MAX = 500;

/** 大批量 rel_path 写入临时表（幂等；分批 INSERT 规避变量上限）。小批量无需建表。 */
function prepareRelPathFilter(relPaths) {
  if (!db) return Promise.resolve();
  const list = (relPaths || []).map((p) => String(p)).filter(Boolean);
  if (list.length <= REL_PATH_BATCH_MAX) return Promise.resolve();
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run('CREATE TEMP TABLE IF NOT EXISTS tmp_filter_rel_paths (rel_path TEXT PRIMARY KEY)');
      db.run('DELETE FROM tmp_filter_rel_paths');
      const stmt = db.prepare('INSERT OR IGNORE INTO tmp_filter_rel_paths (rel_path) VALUES (?)');
      for (let i = 0; i < list.length; i += REL_PATH_BATCH_MAX) {
        for (const p of list.slice(i, i + REL_PATH_BATCH_MAX)) stmt.run(p);
      }
      stmt.finalize((err) => {
        if (err) logger.warn(MODULE, REQ_ID, 'prepareRelPathFilter failed', { error: logger.formatError(err) });
        resolve();
      });
    });
  });
}

/** rel_path 过滤子句：小批量走 IN，大批量走临时表子查询（需先 prepareRelPathFilter） */
function relPathFilterSql(relPaths) {
  const list = relPaths || [];
  if (!list.length) return { sql: '', params: [] };
  if (list.length > REL_PATH_BATCH_MAX) {
    return { sql: 'rel_path IN (SELECT rel_path FROM tmp_filter_rel_paths)', params: [] };
  }
  return { sql: `rel_path IN (${list.map(() => '?').join(',')})`, params: list.slice() };
}

/** 构造「存在缺失」的 WHERE 子句，并排除 24h 失败冷却期内的歌曲（避免反复无效联网） */
function incompleteWhere(only, cutoff) {
  const mode = String(only || 'all');
  const condImage = "(cover_relpath IS NULL OR cover_relpath = '' OR album_cover_relpath IS NULL OR album_cover_relpath = '' OR artist_cover_relpath IS NULL OR artist_cover_relpath = '')";
  const condLyric = "(lyric_raw IS NULL OR lyric_raw = '')";
  let where;
  if (mode === 'lyric') where = condLyric;
  else if (mode === 'image') where = condImage;
  else where = `(${condImage} OR ${condLyric})`;
  // 排除：失败冷却期内（enrich_fail_reason 非空 且 last_enrich_try 在 24h 内）的歌曲
  where += ` AND (enrich_fail_reason IS NULL OR last_enrich_try IS NULL OR last_enrich_try < ${Number(cutoff)})`;
  return where;
}

/** 统计待处理歌曲数（手动/补全含冷却排除；monitor 仅 raw_parsed） */
function countIncompleteSongs(only, trigger, relPaths) {
  if (!db) return Promise.resolve(0);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const isMonitor = String(trigger || '') === 'monitor';
  return ensureTables()
    .then(() => prepareRelPathFilter(isMonitor ? relPaths : null))
    .then(() => new Promise((resolve) => {
      let sql, params = [];
      if (isMonitor && relPaths && relPaths.length) {
        // monitor 仅处理本轮扫描到的「新增」歌曲：按 rel_path 过滤 raw_parsed，
        // 不再顺带把历史遗留的 backlog 一并处理（历史交给开机增量/手动扫描）。
        const rf = relPathFilterSql(relPaths);
        sql = `SELECT COUNT(*) AS n FROM local_songs WHERE scan_status = 'raw_parsed' AND ${rf.sql}`;
        params = rf.params;
      } else if (isMonitor) {
        // 开机增量（不带 relPaths）处理全部 raw_parsed 以抓历史 backlog
        sql = "SELECT COUNT(*) AS n FROM local_songs WHERE scan_status = 'raw_parsed'";
      } else {
        sql = `SELECT COUNT(*) AS n FROM local_songs WHERE ${incompleteWhere(only, cutoff)}`;
      }
      db.get(sql, params, (err, row) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'countIncompleteSongs failed', { error: logger.formatError(err) }); resolve(0); }
        else resolve((row && row.n) || 0);
      });
    }));
}

/** keyset 分页取「存在缺失」的待处理歌曲（游标 lastId：取 id > lastId 的下一页。
 *  不用 OFFSET：被处理完成的行会立刻离开过滤集，OFFSET 窗口后移会静默跳过未处理行）。
 *  注意：id 是 TEXT（'tr-'+md5），游标必须按字符串比较推进，绝不能数字化（NaN 会卡死在 0 造成活锁） */
function getIncompleteSongsPaged(lastId, limit, only, trigger) {
  if (!db) return Promise.resolve([]);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const sql = `SELECT id, rel_path, title, artist, album, cover_relpath, album_cover_relpath, artist_cover_relpath, lyric_raw, duration, is_strm
               FROM local_songs WHERE ${incompleteWhere(only, cutoff)} AND id > ? ORDER BY id LIMIT ?`;
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(sql, [String(lastId || ''), Number(limit) || 20], (err, rows) => {
      if (err) { logger.warn(MODULE, REQ_ID, 'getIncompleteSongsPaged failed', { error: logger.formatError(err) }); resolve([]); }
      else resolve(rows || []);
    });
  }));
}

/** keyset 分页取 raw_parsed 新歌（monitor 自动入库用；rel_path 大批量走临时表过滤） */
function getRawParsedSongsPaged(lastId, limit, relPaths) {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    const base = 'SELECT id, rel_path, title, artist, album, cover_relpath, album_cover_relpath, artist_cover_relpath, lyric_raw, duration, is_strm FROM local_songs';
    const rf = relPathFilterSql(relPaths);
    let sql, params;
    if (rf.sql) {
      // 带 relPaths（monitor 自动入库：仅本轮新增）
      sql = `${base} WHERE scan_status = 'raw_parsed' AND ${rf.sql} AND id > ? ORDER BY id LIMIT ?`;
      params = [...rf.params, String(lastId || ''), Number(limit) || 20];
    } else {
      // 不带 relPaths（开机增量/手动）取全部 raw_parsed
      sql = `${base} WHERE scan_status = 'raw_parsed' AND id > ? ORDER BY id LIMIT ?`;
      params = [String(lastId || ''), Number(limit) || 20];
    }
    db.all(sql, params, (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getRawParsedSongsPaged failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      }
    );
  }));
}

/** 读取歌曲当前封面/歌词绑定状态（供流水线结束后判断「仍缺失」字段） */
function getEnrichStatus(relPath) {
  if (!db || !relPath) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      'SELECT cover_relpath, album_cover_relpath, artist_cover_relpath, lyric_raw, title, artist, album FROM local_songs WHERE rel_path = ? LIMIT 1',
      [String(relPath)],
      (err, row) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getEnrichStatus failed', { error: logger.formatError(err) }); resolve(null); }
        else resolve(row || null);
      }
    );
  }));
}

/** 是否处于补全失败冷却期（24h 内）：播放触发也据此跳过，避免重复无效联网 */
function isInEnrichCooldown(relPath) {
  if (!db || !relPath) return Promise.resolve(false);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      'SELECT enrich_fail_reason, last_enrich_try FROM local_songs WHERE rel_path = ? LIMIT 1',
      [String(relPath)],
      (err, row) => {
        if (err || !row) { resolve(false); return; }
        const failed = !!(row.enrich_fail_reason && String(row.enrich_fail_reason).trim());
        const tried = Number(row.last_enrich_try) || 0;
        resolve(failed && tried > cutoff);
      }
    );
  }));
}

/** 记录补全失败：标记失败原因 + 最后尝试时间（24h 冷却起点） */
function setEnrichFailed(relPath, reason) {
  if (!db || !relPath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      'UPDATE local_songs SET last_enrich_try = ?, enrich_fail_reason = ?, updated_at = ? WHERE rel_path = ?',
      [Date.now(), String(reason || 'unknown').slice(0, 200), Date.now(), String(relPath)],
      (err) => { if (err) logger.warn(MODULE, REQ_ID, 'setEnrichFailed failed', { error: logger.formatError(err) }); resolve(); }
    );
  }));
}

/** 清除失败标记（歌曲已补满，避免被冷却误伤） */
function clearEnrichFailed(relPath) {
  if (!db || !relPath) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      'UPDATE local_songs SET last_enrich_try = ?, enrich_fail_reason = NULL WHERE rel_path = ?',
      [Date.now(), String(relPath)],
      (err) => { if (err) logger.warn(MODULE, REQ_ID, 'clearEnrichFailed failed', { error: logger.formatError(err) }); resolve(); }
    );
  }));
}

/** 读取专辑已绑定的真实专辑封面 relpath（album_cover_relpath，非歌曲封面；无命中返回 null） */
function getAlbumRealCoverRelpath(album, artist) {
  if (!db || !album) return Promise.resolve(null);
  return ensureTables().then(() => new Promise((resolve) => {
    db.get(
      "SELECT album_cover_relpath FROM local_songs WHERE album = ? AND artist = ? AND album_cover_relpath IS NOT NULL AND album_cover_relpath <> '' ORDER BY updated_at DESC LIMIT 1",
      [String(album).trim(), String(artist || '').trim()],
      (err, row) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getAlbumRealCoverRelpath failed', { error: logger.formatError(err) }); resolve(null); }
        else resolve(row && row.album_cover_relpath ? row.album_cover_relpath : null);
      }
    );
  }));
}

/** 阶段1回填：仅当歌曲无专辑标签（NULL/空/未知占位）时写入匹配到的专辑名，绝不覆盖真实标签 */
function updateSongAlbumIfEmpty(relPath, album) {
  if (!db || !relPath) return Promise.resolve();
  const a = String(album || '').trim();
  if (!a || a === '未知专辑' || a === '未知') return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET album = ?, updated_at = ? WHERE rel_path = ? AND (album IS NULL OR album = '' OR album = '未知专辑' OR album = '未知')",
      [a, Date.now(), String(relPath)],
      (err) => { if (err) logger.warn(MODULE, REQ_ID, 'updateSongAlbumIfEmpty failed', { error: logger.formatError(err) }); resolve(); }
    );
  }));
}

// ---------------- 元数据（艺术家/专辑/标题）补全与来源标记 ----------------
// 规则：核心字段 = 艺术家 / 专辑 / 歌曲标题，三者全部非空即视为「完整」，自动扫描阶段不再请求插件；
// 只要任一为空（或占位值 未知艺术家/未知专辑/未知）才调用插件，且插件只填空、绝不覆盖已有有效值。
// 用户手动补全（overwrite=true）例外：允许插件结果完整覆盖现有元数据，用于个别异常歌曲修复。

/** 占位值（视为空）：艺术家 */
const META_PLACEHOLDER_ARTIST = ['未知艺术家', '未知歌手', '未知'];
/** 占位值（视为空）：专辑 */
const META_PLACEHOLDER_ALBUM = ['未知专辑', '未知'];

function placeholderCond(col, placeholders) {
  const list = (placeholders || []).map(() => '?').join(',');
  return list ? `(${col} IS NULL OR TRIM(${col}) = '' OR ${col} IN (${list}))` : `(${col} IS NULL OR TRIM(${col}) = '')`;
}

/** 核心元数据（标题/艺术家/专辑）存在缺失的判定条件 */
function metaIncompleteWhere() {
  return `(${placeholderCond('title', [])}
           OR ${placeholderCond('artist', META_PLACEHOLDER_ARTIST)}
           OR ${placeholderCond('album', META_PLACEHOLDER_ALBUM)})`;
}

/** 元数据补全模式的 WHERE 组装：overwrite=true 时不过滤缺失（允许覆盖全部）。
 *  rel_path 过滤经 relPathFilterSql（大批量走临时表，需调用方先 prepareRelPathFilter） */
function metaFillWhere(overwrite, relPaths) {
  const parts = [];
  if (!overwrite) parts.push(metaIncompleteWhere());
  const rf = relPathFilterSql(relPaths);
  if (rf.sql) parts.push(rf.sql);
  return parts.length ? parts.join(' AND ') : '1 = 1';
}

/** 元数据补全模式的参数占位（与 metaFillWhere 顺序一致） */
function metaFillParams(overwrite, relPaths) {
  const params = [];
  if (!overwrite) {
    params.push(...META_PLACEHOLDER_ARTIST, ...META_PLACEHOLDER_ALBUM);
  }
  params.push(...relPathFilterSql(relPaths).params);
  return params;
}

const META_FILL_COLS = 'id, rel_path, title, artist, album, is_strm, title_source, artist_source, album_source, meta_source';

/** 统计「元数据补全」待处理歌曲数 */
function countMetaFillSongs(overwrite, relPaths) {
  if (!db) return Promise.resolve(0);
  return ensureTables()
    .then(() => prepareRelPathFilter(relPaths))
    .then(() => new Promise((resolve) => {
      const sql = `SELECT COUNT(*) AS n FROM local_songs WHERE ${metaFillWhere(overwrite, relPaths)}`;
      db.get(sql, metaFillParams(overwrite, relPaths), (err, row) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'countMetaFillSongs failed', { error: logger.formatError(err) }); resolve(0); }
        else resolve((row && row.n) || 0);
      });
    }));
}

/** keyset 分页取「元数据补全」待处理歌曲（游标 lastId，避免 OFFSET 跳行） */
function getMetaFillSongsPaged(lastId, limit, overwrite, relPaths) {
  if (!db) return Promise.resolve([]);
  return ensureTables()
    .then(() => prepareRelPathFilter(relPaths))
    .then(() => new Promise((resolve) => {
      const where = metaFillWhere(overwrite, relPaths);
      const params = [...metaFillParams(overwrite, relPaths), String(lastId || ''), Number(limit) || 20];
      const sql = `SELECT ${META_FILL_COLS} FROM local_songs WHERE ${where} AND id > ? ORDER BY id LIMIT ?`;
      db.all(sql, params, (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'getMetaFillSongsPaged failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      });
    }));
}

/**
 * 写入核心元数据（title / artist / album），并同步写入来源标记（默认 plugin）。
 * 仅填空模式（overwrite=false）：每个字段带「当前为空或占位」守卫，已有有效值绝不覆盖；
 * 覆盖模式（overwrite=true）：无条件写入（仅用户手动补全时使用）。
 * @param {string} relPath
 * @param {{title?:string, artist?:string, album?:string}} fields 仅传需要写入的字段
 * @param {boolean} [overwrite]
 * @param {string} [source] 来源标记，默认 'plugin'
 * @param {boolean} [force] 无条件写入（用户手动编辑时使用，连 manual 来源也能再次修改）
 */
function updateSongMetaFields(relPath, fields, overwrite, source, force) {
  if (!db || !relPath) return Promise.resolve();
  const f = fields || {};
  const src = source || 'plugin';
  const cols = [];
  for (const [key, col] of [['title', 'title'], ['artist', 'artist'], ['album', 'album']]) {
    if (f[key] === undefined || f[key] === null) continue;
    const v = String(f[key]).trim();
    if (!v) continue;
    cols.push({ col, val: v, placeholders: key === 'artist' ? META_PLACEHOLDER_ARTIST : (key === 'album' ? META_PLACEHOLDER_ALBUM : []) });
  }
  if (!cols.length) return Promise.resolve();
  const sets = [];
  const params = [];
  for (const c of cols) {
    sets.push(`${c.col} = ?`, `${c.col}_source = ?`);
    params.push(c.val, src);
  }
  sets.push('meta_source = ?');
  params.push(src);
  sets.push('updated_at = ?');
  params.push(Date.now());
  let sql = `UPDATE local_songs SET ${sets.join(', ')} WHERE rel_path = ?`;
  params.push(String(relPath));
  if (overwrite && !force) {
    // 覆盖模式（用户手动补全）：仍要保护「用户手动编辑」的字段——手动编辑优先级最高，
    // 只有非 manual 来源的字段才允许被插件结果覆盖。
    sql += ` AND ${cols.map((c) => `(${c.col}_source IS NULL OR ${c.col}_source <> 'manual')`).join(' AND ')}`;
  } else {
    // 仅填空：要求本次要写的字段当前全部为空/占位，否则整条放弃（绝不覆盖已有有效值）
    sql += ` AND ${cols.map((c) => placeholderCond(c.col, c.placeholders)).join(' AND ')}`;
    for (const c of cols) params.push(...(c.placeholders || []));
  }
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(sql, params, (err) => {
      if (err) logger.warn(MODULE, REQ_ID, 'updateSongMetaFields failed', { relPath, error: logger.formatError(err) });
      resolve();
    });
  }));
}

/** 读取全部歌曲的核心元数据与来源标记（rel_path → 字段），供流水线结束后同步回内存聚合 */
function loadMetaFieldsByRelPath() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      'SELECT rel_path, title, artist, album, title_source, artist_source, album_source, meta_source FROM local_songs',
      (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'loadMetaFieldsByRelPath failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      }
    );
  }));
}

/** 回填时长（仅当当前时长为空/0 时填空；已有真实时长绝不覆盖）。
 *  主要用于 strm 文件：其本体是文本流容器，ffmpeg 读不到真实时长，
 *  只能靠插件搜索结果的时长补录（播放时客户端也会写回真实时长，那时长优先）。 */
function updateSongDuration(relPath, duration) {
  const d = Number(duration);
  if (!db || !relPath || !(d > 0)) return Promise.resolve();
  return ensureTables().then(() => new Promise((resolve) => {
    db.run(
      "UPDATE local_songs SET duration = ?, updated_at = ? WHERE rel_path = ? AND (duration IS NULL OR duration = 0 OR duration = '')",
      [d, Date.now(), String(relPath)],
      (err) => { if (err) logger.warn(MODULE, REQ_ID, 'updateSongDuration failed', { error: logger.formatError(err) }); resolve(); }
    );
  }));
}

/** 取所有已有专辑名的歌曲（rel_path → album），供流水线结束后同步内存聚合 */
function loadAlbumNamesByRelPath() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      "SELECT rel_path, album FROM local_songs WHERE album IS NOT NULL AND album <> '' AND album <> '未知专辑' AND album <> '未知'",
      (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'loadAlbumNamesByRelPath failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      }
    );
  }));
}

/**
 * 读取全部歌曲行的封面绑定字段（rel_path → 各封面 relpath/hash/source），
 * 供流水线结束后把绑定同步回内存聚合（syncCoversFromDb）。
 */
function loadCoverFieldsByRelPath() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      `SELECT rel_path, album,
              cover_relpath, cover_hash, cover_source,
              album_cover_relpath, album_cover_hash, album_cover_source,
              artist_cover_relpath, artist_cover_hash, artist_cover_source
       FROM local_songs`,
      (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'loadCoverFieldsByRelPath failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      }
    );
  }));
}

/** 读取全部歌曲行的时长（rel_path → duration），供流水线结束后把补录的时长同步回内存聚合 */
function loadDurationsByRelPath() {
  if (!db) return Promise.resolve([]);
  return ensureTables().then(() => new Promise((resolve) => {
    db.all(
      'SELECT rel_path, duration FROM local_songs WHERE duration IS NOT NULL AND duration > 0',
      (err, rows) => {
        if (err) { logger.warn(MODULE, REQ_ID, 'loadDurationsByRelPath failed', { error: logger.formatError(err) }); resolve([]); }
        else resolve(rows || []);
      }
    );
  }));
}

// 纯内存方案说明：业务表（local_songs 等）与下载 worker 均不保存远程 URL（worker 队列纯内存）；
// 旧账本表 remote_image_cache 已废弃：本模块不再建表/读写，旧库中的遗留表无害（可手动 DROP）。

module.exports = {
  ensureTables,
  loadSongs,
  replaceSongs,
  getStats,
  clearLocalData,
  getAlbumCoverRelpath,
  sanitizeUnknownAlbumPlaceholders,
  updateLyricsForId,
  updateLyricsForRelPath,
  updateReplayGainForId,
  loadLyricForId,
  loadLocalSongById,
  loadLocalSongByRelPath,
  loadLyricFields,
  loadCoverHashes,
  loadAllCoverHashes,
  loadArtistCoverHashes,
  replaceAlbumCovers,
  loadAlbumCovers,
  replaceArtistCovers,
  loadArtistCovers,
  getArtistCoverRelpath,
  bindLyrics,
  getIncompleteSongs,
  getMeta,
  setMeta,
  loadCoverFillMiss,
  saveCoverFillMiss,
  // 新阶段流水线相关
  loadScanStatuses,
  getRawParsedSongs,
  getRawParsedSongsPaged,
  prepareRelPathFilter,
  countIncompleteSongs,
  getIncompleteSongsPaged,
  getEnrichStatus,
  isInEnrichCooldown,
  setEnrichFailed,
  clearEnrichFailed,
  resetScanStatusAll,
  setTrackMeta,
  getSongCoverRemote,
  getDistinctArtists,
  getLazyMetaState,
  setLazyMeta,
  updateSongAlbumIfEmpty,
  updateSongDuration,
  loadAlbumNamesByRelPath,
  // 核心元数据补全（艺术家/专辑/标题）+ 来源标记
  countMetaFillSongs,
  getMetaFillSongsPaged,
  updateSongMetaFields,
  loadMetaFieldsByRelPath,
  // 封面本地化绑定（纯内存方案：URL 不落任何表，只绑本地 webp 路径）
  bindSongCover,
  bindAlbumCover,
  bindArtistCover,
  getAlbumRealCoverRelpath,
  loadCoverFieldsByRelPath,
  loadDurationsByRelPath,
  SCHEMA_VERSION
};
