const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const logger = require('./core/logger');
// 系统设置（主题/音质/下载路径/API 秘钥等）统一存储到 config.json 的 settings 字段，
// 以减少配置散落；其余运行时 KV 仍走 SQLite。
const configStore = require('./lib/config');

// 路由到 config.json 的系统设置键（原存储在 SQLite settings 表）
const SYSTEM_SETTING_KEYS = new Set([
  'theme', 'primary_color', 'audio_quality', 'download_path', 'api_key',
  'notification_enabled', 'wecom_url', 'debug_log_enabled',
  'lyric_plugin', 'lyric_plugins', 'cover_plugins',
  // OpenSubsonic 直连开关（常规设置→播放/封面直连307）：true=307 直链；false=服务器代理
  'streamRedirectEnabled', 'coverRedirectEnabled',
  // 本地曲库优先播放：仅对插件（网络）音源生效，命中 NAS 本地库则改播本地文件
  'localLibraryPriority'
]);

// 网络歌曲虚拟 ID 工具：remote__{source}__{sourceSongId}
const { buildVirtualId, isVirtualId, parseVirtualId } = require('./lib/virtual-id');
// 网络封面落盘缓存（netcover/）：songs 表淘汰记录时同步删除对应封面文件
const netCoverCache = require('./lib/net-cover-cache');

// DB 模块使用 'DB' 作为模块名，reqId 使用 'system' 因为没有请求上下文
const DB_MODULE = 'DB';
const SYSTEM_REQ_ID = 'system';

// ==================== 缓存上限控制 ====================
// songs 表仅缓存 remote__* 网络歌曲（本地 local_songs 不做淘汰）
const DEFAULT_MAX_NET_SONG_CACHE = 1000;
const NET_CACHE_SETTING_KEY = 'maxNetSongCache';
// play_history 为「最近播放」：每用户每首歌只保留最新一条（再次播放上浮到顶部并累加 play_count），
// 超出数量上限则删除最老歌曲记录
const MAX_PLAY_HISTORY_PER_USER = 100;
// 最近播放数据库上限（设置项，默认 100 首），键名 maxRecentPlay
const RECENT_PLAY_SETTING_KEY = 'maxRecentPlay';
const DEFAULT_MAX_RECENT_PLAY = 100;

// 数据库文件路径（与 server.js 一致：backend/ 下 __dirname/../data => /app/data）
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'database.sqlite');

// 确保数据目录存在
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// 创建数据库连接
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Database connection error', { status: 'failed', error: logger.formatError(err) });
  } else {
    // WAL + synchronous=NORMAL：高频小写入（播放状态/播放历史/计数）不再每笔 fsync，读写互不阻塞。
    // 全局收益最大的一行级优化；WAL 下 NORMAL 最坏只丢最后几笔事务，不会损坏库文件。
    db.run('PRAGMA journal_mode = WAL', () => {});
    db.run('PRAGMA synchronous = NORMAL', () => {});
    logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Connected to SQLite database', { status: 'success' });
    initTables();
  }
});

// ==================== 内存读缓存（读多写少） ====================
// SQLite 做持久存储；日常读取接口优先读内存缓存，只有缓存未初始化（刚启动）才查库并加载进内存。
// 写操作完成后会刷新（或失效）对应缓存项，保证读取到的一直是最新数据。
const memCache = new Map(); // key -> { value, ts }

function memGet(key) {
  const entry = memCache.get(key);
  return entry ? entry.value : undefined;
}

function memSet(key, value) {
  memCache.set(key, { value, ts: Date.now() });
}

function memDel(key) {
  memCache.delete(key);
}

// 删除某前缀下的全部缓存项（用于清空类/重置类写操作）
function memDelPrefix(prefix) {
  for (const key of memCache.keys()) {
    if (key.startsWith(prefix)) memCache.delete(key);
  }
}

// 删除指定用户相关的全部缓存项（删除用户后调用）
function memDelUser(userId) {
  const prefixes = [
    `playHistory:${userId}`, `favorites:${userId}`,
    `playlists:${userId}`, `userPlaylists:${userId}`,
    `playlistSongs:${userId}:`, `userPlaylistSongs:${userId}:`,
    `toplists:${userId}`, `toplistSongs:${userId}:`
  ];
  for (const key of memCache.keys()) {
    if (prefixes.some((p) => key.startsWith(p))) memCache.delete(key);
  }
}

// 超大列表（数千首的歌单/收藏等）不进内存缓存：占用大且写失效成本高，直接查库。
// 注意未缓存时读路径每次查库——属于「大歌单用内存换 DB」的有意取舍。
const MEM_CACHE_MAX_ARRAY = 2000;

function memSetIfSmall(key, value) {
  if (Array.isArray(value) && value.length > MEM_CACHE_MAX_ARRAY) {
    memCache.delete(key); // 清掉可能存在的旧条目，避免超大列表替换失败后残留陈旧数据
    return;
  }
  memSet(key, value);
}

// 缓存读：命中返回缓存值，未命中执行 loader 填充缓存。数组返回浅拷贝，防止调用方修改污染缓存。
async function memGetOrLoad(key, loader) {
  let value = memGet(key);
  if (value === undefined) {
    value = await loader();
    memSetIfSmall(key, value);
  }
  return Array.isArray(value) ? value.slice() : value;
}

// 缓存读 + 内存分页（用于最近播放等带 limit/offset 的接口）：缓存完整列表，按需切片。
async function memSliceOrLoad(key, loader, limit, offset) {
  let value = memGet(key);
  if (value === undefined) {
    value = await loader();
    memSetIfSmall(key, value);
  }
  const from = offset || 0;
  const to = from + (limit == null ? value.length : limit);
  return value.slice(from, to);
}

// 写后刷新：重新从数据库加载完整列表并更新缓存；刷新失败时失效缓存，避免返回陈旧数据。
async function memRefresh(key, loader) {
  try {
    const value = await loader();
    memSetIfSmall(key, value);
    return value;
  } catch (err) {
    memDel(key);
    throw err;
  }
}

// 写后异步刷新（fire-and-forget）：写函数不等待刷新完成即可返回。
function memRefreshAsync(key, loader) {
  memRefresh(key, loader).catch((err) => {
    logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Memory cache refresh failed', { key, error: err && err.message });
  });
}

// 高频写去抖刷新：合并短时间内的多次写操作（如下载进度更新），只刷新一次。
const memRefreshTimers = new Map();
function memRefreshDebounced(key, loader, delayMs = 1000) {
  if (memRefreshTimers.has(key)) return;
  const timer = setTimeout(() => {
    memRefreshTimers.delete(key);
    memRefreshAsync(key, loader);
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  memRefreshTimers.set(key, timer);
}

// 迁移 playlists 表，添加 sort_order 列
function migratePlaylistsTable() {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(playlists)", (err, columns) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking playlists table schema', { status: 'failed', error: logger.formatError(err) });
        resolve(); // 表可能还不存在，不阻止初始化
        return;
      }

      const columnNames = columns.map(c => c.name);

      // 检查并添加 sort_order 列
      if (!columnNames.includes('sort_order')) {
        db.run('ALTER TABLE playlists ADD COLUMN sort_order INTEGER DEFAULT 0', (err) => {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding sort_order column', { status: 'failed', error: logger.formatError(err) });
            reject(err);
          } else {
            logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added sort_order column to playlists table', { status: 'success' });
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  });
}

// 检查并添加缺失的列
function migrateTables() {
  return new Promise((resolve, reject) => {
    // 为依赖歌曲的表添加 song_id/plugin/music_data 列（替代已移除的 songs 表引用）
    const migrations = [];
    const songRefTables = ['favorites', 'play_history', 'playlist_songs', 'downloads', 'play_queue'];
    songRefTables.forEach((table) => {
      ['song_id TEXT', 'plugin TEXT', 'music_data TEXT'].forEach((colDef) => {
        const col = colDef.split(' ')[0];
        migrations.push(new Promise((res, rej) => {
          db.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`, (err) => {
            if (err && !/duplicate column/i.test(err.message || '')) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, `Add column ${col} to ${table} failed`, { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              res();
            }
          });
        }));
      });
    });

      Promise.all(migrations)
        .then(() => {
          // 迁移 playlists 表的 sort_order 列
          return migratePlaylistsTable();
        })
        .then(() => {
          // 迁移 playlists 表的动态榜单来源字段（榜单歌单不存快照，进入时实时向插件拉取）
          return migratePlaylistSourceColumns();
        })
        .then(() => {
          // 迁移 user_subscribed_toplists 表的定时任务字段
          return migrateSubscribedToplistsTable();
        })
        .then(() => {
          // 迁移 subscribed_toplist_songs 表的 rank 字段
          return migrateSubscribedToplistSongsTable();
        })
        .then(() => {
          // 迁移 plugin_auto_update 表的通知设置字段
          return migratePluginAutoUpdateTable();
        })
        .then(() => {
          // 收敛历史遗留 song_id 列 → song_id（见 normalizeLegacySongIdColumns 注释）
          return normalizeLegacySongIdColumns();
        })
        .then(() => {
          // play_history 改为完整流水：移除 (user_id, song_id, plugin) 唯一约束/唯一索引
          return migratePlayHistoryToFlow();
        })
        .then(() => {
          // 播放历史按歌曲合并：同一首歌只保留最新一行并累加 play_count（消除"最近播放"大量重复）
          return mergeDuplicatePlayHistory();
        })
        .then(() => {
          logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Database migration completed', { status: 'success' });
          resolve();
        })
        .catch(reject);
    });
}

// 收敛历史遗留列：早期版本用 song_id（NOT NULL）+ 外键/UNIQUE 标识歌曲，之后某版本又追加了
// music_id 列，导致两张表同时存在 song_id 与 music_id。现统一收敛为 song_id（文档要求公共关联表
// 用 TEXT 类型 song_id：本地歌曲存"123"、网络歌曲存完整虚拟 ID remote__{plugin}__{id}），并丢弃
// 遗留 music_id 列。由于遗留表对 song_id 建有外键，SQLite 的 DROP COLUMN 无法执行
//（报错「unknown column song_id in foreign key definition」），故采用「重建表」方式：
// 1) 按当前实际列（PRAGMA table_info，含历史 ALTER ADD COLUMN 追加的列）建临时表，
//    丢弃 music_id 列，song_id 作为唯一歌曲标识（仅保留非 song_id/music_id 的外键，如 playlist_id 级联）；
// 2) 把数据搬过去：song_id 优先保留已写入的虚拟 ID，否则用 music_id + plugin 重建虚拟 ID；
// 3) 删除原表、重命名临时表，并补建 song_id 上的唯一索引（与 CREATE 语句一致）。
// 使新旧数据库 schema 一致，避免「NOT NULL constraint failed」与「ON CONFLICT 不匹配」两类错误。
function normalizeLegacySongIdColumns() {
  const uniques = {
    favorites: '(user_id, song_id, plugin)',
    play_history: '(user_id, song_id, plugin)',
    playlist_songs: '(user_id, playlist_id, song_id, plugin)',
    play_queue: '(user_id, song_id, plugin)',
    downloads: '(song_id, plugin)'
  };
  const tables = Object.keys(uniques);
  return Promise.all(tables.map((table) => new Promise((resolve) => {
    db.all(`PRAGMA table_info(${table})`, (err, cols) => {
      if (err || !Array.isArray(cols) || !cols.some((c) => c.name === 'music_id')) { resolve(); return; } // 已是目标 schema（仅 song_id、无 music_id），无需处理
      // 取原表 DDL，保留非 song_id 的外键约束
      db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table], (e2, row) => {
        let keptFks = '';
        if (row && row.sql) {
          const fkRe = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\S+)\s*\(([^)]*)\)(\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/gi;
          let m;
          while ((m = fkRe.exec(row.sql)) !== null) {
            const localCols = m[1].split(',').map((s) => s.trim());
            if (localCols.includes('song_id') || localCols.includes('music_id')) continue; // 丢弃引用 song_id/music_id 的外键
            keptFks += `, FOREIGN KEY(${m[1]}) REFERENCES ${m[2]}(${m[3]})${m[4] || ''}`;
          }
        }
        // 这些歌曲引用表可能同时含 song_id 与 music_id（旧迁移曾把 song_id 并入 music_id），
        // 现丢弃遗留 music_id 列，以 song_id 为唯一歌曲标识，并把网络歌曲还原为虚拟 ID（remote__{plugin}__{id}）。
        const newCols = [];
        const srcExprs = [];
        const defs = [];
        cols.forEach((c) => {
          if (c.name === 'song_id') {
            newCols.push('song_id');
            // 优先保留已写入的 song_id；本地歌曲原样；网络歌曲重建虚拟 ID
            srcExprs.push(
              `CASE WHEN "song_id" LIKE 'remote__%' THEN "song_id" ` +
              `WHEN COALESCE("plugin", '') IN ('local', '') THEN COALESCE(NULLIF("song_id", ''), "music_id") ` +
              `ELSE 'remote__' || lower(REPLACE("plugin", '.js', '')) || '__' || COALESCE(NULLIF("song_id", ''), "music_id") END`
            );
            let d = `"song_id" ${c.type || 'TEXT'}`;
            if (c.notnull) d += ' NOT NULL';
            if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
            if (c.pk) d += ' PRIMARY KEY';
            defs.push(d);
            return;
          }
          if (c.name === 'music_id') return; // 丢弃遗留 music_id 列（其值已并入 song_id）
          newCols.push(c.name);
          srcExprs.push(`"${c.name}"`);
          let d = `"${c.name}" ${c.type || 'TEXT'}`;
          if (c.notnull) d += ' NOT NULL';
          if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
          if (c.pk) d += ' PRIMARY KEY';
          defs.push(d);
        });
        if (keptFks) defs.push(keptFks.slice(2)); // 去掉前导 ", "
        const tmp = `_${table}_new`;
        const steps = [
          `DROP TABLE IF EXISTS ${tmp}`,
          `CREATE TABLE ${tmp} (${defs.join(', ')})`,
          `INSERT INTO ${tmp} (${newCols.map((c) => `"${c}"`).join(', ')}) SELECT ${srcExprs.join(', ')} FROM ${table}`,
          `DROP TABLE ${table}`,
          `ALTER TABLE ${tmp} RENAME TO ${table}`
        ];
        // download_queue 视图依赖 downloads 表；重建 downloads 前先删视图，
        // 否则 DROP/重命名 downloads 会触发视图校验失败（"no such table: main.downloads"），
        // 连带 favorites/play_history 等重建也失败。重建完成后恢复视图（与初始化处定义一致）。
        if (table === 'downloads') {
          steps.splice(1, 0, 'DROP VIEW IF EXISTS download_queue');
          steps.push(`CREATE VIEW IF NOT EXISTS download_queue AS
            SELECT * FROM downloads
            WHERE status IN ('queued', 'paused', 'failed')
            ORDER BY created_at ASC`);
        }
        db.run('PRAGMA foreign_keys = OFF', () => {
          let i = 0;
          const runStep = () => {
            if (i >= steps.length) {
              db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_${table}_song ON ${table}${uniques[table]}`, (ie) => {
                if (ie) logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Create unique index on song_id failed', { table, error: logger.formatError(ie) });
                db.run('PRAGMA foreign_keys = ON', () => resolve());
              });
              return;
            }
            const sql = steps[i++];
            db.run(sql, (se) => {
              if (se) {
                logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Rebuild legacy song_id table failed', { table, sql, error: logger.formatError(se) });
                db.run('PRAGMA foreign_keys = ON', () => resolve());
                return;
              }
              runStep();
            });
          };
          runStep();
        });
      });
    });
  })));
}

/**
 * play_history 流水化迁移：移除 (user_id, song_id, plugin) 的唯一约束与唯一索引
 * （uq_play_history_song / 表内 UNIQUE），使同一首歌可保留多条完整播放流水。
 * 通过「重建表」保留数据与除该唯一约束外的索引结构，幂等。
 */
function migratePlayHistoryToFlow() {
  return new Promise((resolve) => {
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='play_history'", (e, tbl) => {
      if (e || !tbl || !tbl.sql) { resolve(); return; }
      const hasUniqueInTable = /UNIQUE\s*\(\s*user_id\s*,\s*song_id\s*,\s*plugin\s*\)/i.test(tbl.sql);
      db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='play_history'", (e2, idxRows) => {
        if (e2) { resolve(); return; }
        const hasUniqueIdx = (idxRows || []).some((r) => /^uq_play_history_song/i.test(r.name || ''));
        if (!hasUniqueInTable && !hasUniqueIdx) { resolve(); return; } // 已是流水结构

        db.all('PRAGMA table_info(play_history)', (e3, cols) => {
          if (e3 || !Array.isArray(cols) || !cols.length) { resolve(); return; }
          // 重建表：保留全部列与类型/默认值/PK，丢弃表级 UNIQUE
          const defs = cols.map((c) => {
            let d = `"${c.name}" ${c.type || 'TEXT'}`;
            if (c.notnull) d += ' NOT NULL';
            if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
            if (c.pk) d += ' PRIMARY KEY AUTOINCREMENT';
            return d;
          });
          const colNames = cols.map((c) => `"${c.name}"`);
          const steps = [
            'DROP TABLE IF EXISTS _play_history_flow_new',
            `CREATE TABLE _play_history_flow_new (${defs.join(', ')})`,
            `INSERT INTO _play_history_flow_new (${colNames.join(', ')}) SELECT ${colNames.join(', ')} FROM play_history`,
            'DROP TABLE play_history',
            'ALTER TABLE _play_history_flow_new RENAME TO play_history',
            'DROP INDEX IF EXISTS uq_play_history_song'
          ];
          db.run('PRAGMA foreign_keys = OFF', () => {
            let i = 0;
            const runStep = () => {
              if (i >= steps.length) {
                // 重建非唯一索引（与初始化一致）
                db.run('CREATE INDEX IF NOT EXISTS idx_play_history_user_id ON play_history(user_id)');
                db.run('CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC)');
                db.run('CREATE INDEX IF NOT EXISTS idx_play_history_song_id ON play_history(song_id)');
                db.run('CREATE INDEX IF NOT EXISTS idx_play_history_play_count ON play_history(play_count DESC)');
                db.run('PRAGMA foreign_keys = ON', () => {
                  logger.info(DB_MODULE, SYSTEM_REQ_ID, 'play_history migrated to flow mode (unique dropped)', { status: 'success' });
                  resolve();
                });
                return;
              }
              const sql = steps[i++];
              db.run(sql, (se) => {
                if (se) {
                  logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'play_history flow migration step failed', { sql, error: logger.formatError(se) });
                  db.run('PRAGMA foreign_keys = ON', () => resolve());
                  return;
                }
                runStep();
              });
            };
            runStep();
          });
        });
      });
    });
  });
}

/**
 * 播放历史去重合并：同一 (user_id, song_id, plugin) 只保留最新一行，
 * 把重复行的 play_count 累加到保留行后删除其余行（幂等；每次启动若发现重复会自动清理）。
 * 背景：各消费端（最近播放/常听统计/进度记忆）都按「歌曲」读取并聚合，同一首歌多行
 * 没有价值，只会让"最近播放"出现大量重复歌曲。
 */
function mergeDuplicatePlayHistory() {
  return new Promise((resolve) => {
    db.all(
      `SELECT user_id, song_id, plugin, COUNT(*) cnt, SUM(play_count) total
       FROM play_history
       GROUP BY user_id, song_id, plugin
       HAVING cnt > 1`,
      (err, groups) => {
        if (err || !groups || !groups.length) { resolve(); return; }
        let i = 0;
        const step = () => {
          if (i >= groups.length) {
            logger.info(DB_MODULE, SYSTEM_REQ_ID, 'play_history duplicate merge done', { mergedGroups: groups.length });
            resolve();
            return;
          }
          const g = groups[i++];
          // 保留最新一行（played_at 最大、id 最大）
          db.get(
            `SELECT id FROM play_history
             WHERE user_id = ? AND song_id = ? AND plugin = ?
             ORDER BY played_at DESC, id DESC LIMIT 1`,
            [g.user_id, g.song_id, g.plugin],
            (e2, keep) => {
              if (e2 || !keep) { step(); return; }
              db.run(`UPDATE play_history SET play_count = ? WHERE id = ?`, [Number(g.total) || 1, keep.id], () => {
                db.run(
                  `DELETE FROM play_history
                   WHERE user_id = ? AND song_id = ? AND plugin = ? AND id != ?`,
                  [g.user_id, g.song_id, g.plugin, keep.id],
                  (delErr) => {
                    if (delErr) {
                      logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Merge play history delete failed', { error: logger.formatError(delErr), userId: g.user_id });
                    }
                    step();
                  }
                );
              });
            }
          );
        };
        step();
      }
    );
  });
}

// 迁移 playlists 表，添加动态榜单来源字段：
// 保存整个榜单为歌单时只存「插件 + 榜单ID」，进入歌单时实时向插件拉取最新榜单（不再逐首入库快照）
function migratePlaylistSourceColumns() {
  return new Promise((resolve) => {
    db.all("PRAGMA table_info(playlists)", (err, columns) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking playlists table schema', { status: 'failed', error: logger.formatError(err) });
        resolve();
        return;
      }
      const columnNames = columns.map(c => c.name);
      const addCol = (colDef) => new Promise((res) => {
        db.run(`ALTER TABLE playlists ADD COLUMN ${colDef}`, (e) => {
          if (e && !/duplicate column/i.test(e.message || '')) {
            logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Note: playlist source column may already exist', { error: e.message });
          }
          res();
        });
      });
      const jobs = [];
      if (!columnNames.includes('source_type')) jobs.push(addCol("source_type TEXT"));
      if (!columnNames.includes('source_platform')) jobs.push(addCol("source_platform TEXT"));
      if (!columnNames.includes('source_toplist_id')) jobs.push(addCol("source_toplist_id TEXT"));
      // 动态歌单上次实时拉取的歌曲数（卡片预取显示用，避免为取数量而全量导入）
      if (!columnNames.includes('cached_song_count')) jobs.push(addCol("cached_song_count INTEGER"));
      Promise.all(jobs).then(resolve);
    });
  });
}

// 迁移 user_subscribed_toplists 表，添加定时任务相关字段
function migrateSubscribedToplistsTable() {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(user_subscribed_toplists)", (err, columns) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking user_subscribed_toplists table schema', { status: 'failed', error: logger.formatError(err) });
        resolve(); // 表可能还不存在，不阻止初始化
        return;
      }

      const columnNames = columns.map(c => c.name);
      const migrations = [];

      // 检查并添加 is_enabled 列
      if (!columnNames.includes('is_enabled')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN is_enabled INTEGER DEFAULT 1', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding is_enabled column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added is_enabled column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 cron_expression 列
      if (!columnNames.includes('cron_expression')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN cron_expression TEXT DEFAULT '0 0 * * *'", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding cron_expression column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added cron_expression column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 last_run_at 列
      if (!columnNames.includes('last_run_at')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN last_run_at INTEGER', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding last_run_at column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added last_run_at column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 next_run_at 列
      if (!columnNames.includes('next_run_at')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN next_run_at INTEGER', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding next_run_at column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added next_run_at column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 status 列
      if (!columnNames.includes('status')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN status TEXT DEFAULT 'idle'", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding status column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added status column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 download_quality 列
      if (!columnNames.includes('download_quality')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN download_quality TEXT DEFAULT 'standard'", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding download_quality column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added download_quality column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 total_songs 列
      if (!columnNames.includes('total_songs')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN total_songs INTEGER DEFAULT 0', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding total_songs column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added total_songs column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 downloaded_count 列
      if (!columnNames.includes('downloaded_count')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN downloaded_count INTEGER DEFAULT 0', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding downloaded_count column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added downloaded_count column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 failed_count 列
      if (!columnNames.includes('failed_count')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN failed_count INTEGER DEFAULT 0', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding failed_count column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added failed_count column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 last_error 列
      if (!columnNames.includes('last_error')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE user_subscribed_toplists ADD COLUMN last_error TEXT', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding last_error column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added last_error column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 source_type 列 (用于区分榜单和歌单)
      if (!columnNames.includes('source_type')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN source_type TEXT DEFAULT 'toplist'", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding source_type column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added source_type column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 is_hidden 列 (用于标记是否在列表中显示)
      if (!columnNames.includes('is_hidden')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN is_hidden INTEGER DEFAULT 0", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding is_hidden column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added is_hidden column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 exclude_enabled 列 (控制该订阅是否应用下载排除/语言过滤)
      if (!columnNames.includes('exclude_enabled')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN exclude_enabled INTEGER DEFAULT 1", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding exclude_enabled column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added exclude_enabled column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      // 检查并添加 notify_enabled 列 (用于通知设置)
      if (!columnNames.includes('notify_enabled')) {
        migrations.push(new Promise((res, rej) => {
          db.run("ALTER TABLE user_subscribed_toplists ADD COLUMN notify_enabled INTEGER DEFAULT 0", (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding notify_enabled column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added notify_enabled column to user_subscribed_toplists table', { status: 'success' });
              res();
            }
          });
        }));
      }

      Promise.all(migrations)
        .then(() => {
          logger.info(DB_MODULE, SYSTEM_REQ_ID, 'User subscribed toplists table migration completed', { status: 'success' });
          resolve();
        })
        .catch(reject);
    });
  });
}

// 迁移 subscribed_toplist_songs 表，添加 rank 字段用于保存榜单排名
function migrateSubscribedToplistSongsTable() {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(subscribed_toplist_songs)", (err, columns) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking subscribed_toplist_songs table schema', { status: 'failed', error: logger.formatError(err) });
        resolve();
        return;
      }

      const columnNames = columns.map(c => c.name);

      // 检查并添加 rank 列
      if (!columnNames.includes('rank')) {
        db.run('ALTER TABLE subscribed_toplist_songs ADD COLUMN rank INTEGER DEFAULT 0', (err) => {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding rank column', { status: 'failed', error: logger.formatError(err) });
            reject(err);
          } else {
            logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added rank column to subscribed_toplist_songs table', { status: 'success' });
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  });
}


// 迁移 plugin_auto_update 表，添加通知设置字段
function migratePluginAutoUpdateTable() {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(plugin_auto_update)", (err, columns) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking plugin_auto_update table schema', { status: 'failed', error: logger.formatError(err) });
        resolve(); // 表可能还不存在，不阻止初始化
        return;
      }

      const columnNames = columns.map(c => c.name);
      const migrations = [];

      // 检查并添加 notify_enabled 列
      if (!columnNames.includes('notify_enabled')) {
        migrations.push(new Promise((res, rej) => {
          db.run('ALTER TABLE plugin_auto_update ADD COLUMN notify_enabled INTEGER DEFAULT 0', (err) => {
            if (err) {
              logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding notify_enabled column', { status: 'failed', error: logger.formatError(err) });
              rej(err);
            } else {
              logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Added notify_enabled column to plugin_auto_update table', { status: 'success' });
              res();
            }
          });
        }));
      }

      Promise.all(migrations)
        .then(() => {
          logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Plugin auto update table migration completed', { status: 'success' });
          resolve();
        })
        .catch(reject);
    });
  });
}

// 初始化表结构
function initTables() {
  // 使用 serialize 确保按顺序执行
  db.serialize(() => {
    // 启用外键约束
    db.run('PRAGMA foreign_keys = ON');

    // 电台表（数据库驱动，取代插件的平铺数组；前端可直接增删改）
    db.run(`
      CREATE TABLE IF NOT EXISTS radio_stations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        province TEXT DEFAULT '',
        category TEXT DEFAULT '',
        network TEXT DEFAULT '',
        genre TEXT DEFAULT '',
        bitrate INTEGER DEFAULT 0,
        cover_url TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // 电台收藏表（取代按用户的 radio-favorites-{userId}.json 文件，统一进数据库）
    db.run(`
      CREATE TABLE IF NOT EXISTS radio_favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        station_id INTEGER,
        favorite_data TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating radio_favorites table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Radio favorites table ready', { status: 'success' });
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_radio_favorites_user_id ON radio_favorites(user_id)`);

    // 首次启动：把插件里的电台灌入数据库（幂等，仅当表为空时执行）
    migrateRadioStationsFromPlugin().catch((e) => {
      logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Radio migration error', { error: logger.formatError(e) });
    });

    // 首次启动：把遗留的 radio-favorites*.json 迁移进数据库（幂等，迁移后删除旧文件）
    migrateRadioFavoritesFromFiles().catch((e) => {
      logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Radio favorites migration error', { error: logger.formatError(e) });
    });

    // 首次启动：把按用户隔离的电台收藏合并为全站共享（user_id=0），“我的电台”不再按用户隔离
    migrateRadioFavoritesToShared().catch((e) => {
      logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Radio favorites to shared migration error', { error: logger.formatError(e) });
    });

    // ==================== 网络歌曲缓存表（静态元数据缓存，非播放地址）====================
    // 虚拟 ID 作主键：remote__{source}__{sourceSongId}（如 remote__netease__123456）。
    // 只缓存静态不变信息（标题/歌手/专辑/年份/封面链接/原始 id），
    // 播放 URL / token 等临时时效内容【绝不入库】，每次 stream 现场实时向插件请求。
    // 本地歌曲不进此表（走 local_songs）。
    // songs 仅是冗余缓存（真值在业务表的 music_data），故每次启动【直接丢弃重建】，
    // 确保 schema 与代码一致（含 source_song_id 列），避免旧表缺列导致
    // "no such column: source_song_id"，以及建表被异步 PRAGMA 回调延后引发的竞态。
    db.run('DROP TABLE IF EXISTS songs', () => {});
    db.run(`
      CREATE TABLE songs (
        id TEXT PRIMARY KEY,                 -- 虚拟完整 ID: remote__netease__123456
        source_song_id TEXT NOT NULL,        -- 第三方原始 id: 123456
        plugin TEXT NOT NULL,                -- 音源（插件文件名）: netease
        source TEXT,                         -- 同 plugin，便于按来源清理
        title TEXT,
        artist TEXT,
        album TEXT,
        year INTEGER,
        genre TEXT,
        cover_art_url TEXT,                  -- 封面网络链接（静态元数据）
        lyric_raw TEXT,                      -- 歌词完整原始 LRC 文本（网络歌曲歌词落库）
        lyric_struct TEXT,                   -- 歌词结构化时间轴 JSON（前端直接使用）
        music_data TEXT NOT NULL,            -- 完整歌曲对象（已剥离播放 URL），供 stream 现场解析
        cache_at INTEGER NOT NULL,           -- 缓存写入时间
        last_access_at INTEGER NOT NULL      -- 最后访问时间，用于 LRU 清理冷数据
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating songs cache table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Network song cache table ready', { status: 'success' });
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_songs_source_song_id_plugin ON songs(source_song_id, plugin)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_songs_source ON songs(source)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_songs_last_access ON songs(last_access_at)`);

    // 执行迁移（添加缺失的列）
    migrateTables().catch(err => {
      logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Migration error', { status: 'failed', error: logger.formatError(err) });
    });

    // songs 表已移除，相关索引与 song_search 视图一并删除（歌曲元数据现冗余存于各业务表 music_data 列）

    // 收藏表：直接用歌曲自身 song_id+plugin 标识，歌曲完整元数据冗余存于 music_data（不再依赖 songs 表）
    db.run(`
      CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        song_id TEXT NOT NULL,
        plugin TEXT NOT NULL,
        music_data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, song_id, plugin)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating favorites table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Favorites table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_favorites_song_id ON favorites(song_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_favorites_created_at ON favorites(created_at DESC)`);

    // 评分表（OpenSubsonic setRating/getRating；media_id 为 OpenSubsonic 实体 id，兼容 tr-/网络 song_id）
    db.run(`
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        media_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, media_id)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating ratings table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Ratings table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_ratings_user_id ON ratings(user_id)`);

    // 最近播放表：直接用歌曲自身 song_id+plugin 标识，歌曲完整元数据冗余存于 music_data（不再依赖 songs 表）
    db.run(`
      CREATE TABLE IF NOT EXISTS play_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        song_id TEXT NOT NULL,
        plugin TEXT NOT NULL,
        music_data TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        playback_position INTEGER DEFAULT 0,
        playback_device TEXT,
        play_count INTEGER DEFAULT 1
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating play_history table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Play history table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_play_history_user_id ON play_history(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_play_history_song_id ON play_history(song_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_play_history_play_count ON play_history(play_count DESC)`);

    // 歌单表（合并 playlists + user_playlists，添加 user_id 字段）
    db.run(`
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        description TEXT,
        cover TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating playlists table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Playlists table ready', { status: 'success' });
    });

    // 公开歌单标记列（旧库增量添加；已存在时忽略 duplicate column 错误）
    db.run(`ALTER TABLE playlists ADD COLUMN is_public INTEGER DEFAULT 0`, (err) => {
      if (err && !/duplicate column/i.test(err.message || '')) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'playlists: add is_public column', { error: logger.formatError(err) });
      }
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id)`);

    // 歌单歌曲关联表：直接用歌曲自身 song_id+plugin 标识，歌曲完整元数据冗余存于 music_data（不再依赖 songs 表）
    db.run(`
      CREATE TABLE IF NOT EXISTS playlist_songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        playlist_id INTEGER NOT NULL,
        song_id TEXT NOT NULL,
        plugin TEXT NOT NULL,
        music_data TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        sort_order INTEGER DEFAULT 0,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        UNIQUE(user_id, playlist_id, song_id, plugin)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating playlist_songs table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Playlist songs table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_user_id ON playlist_songs(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_id ON playlist_songs(playlist_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_song_id ON playlist_songs(song_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_sort_order ON playlist_songs(playlist_id, sort_order)`);

    // 插件配置表
    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_name TEXT NOT NULL UNIQUE,
        url TEXT,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating plugin_configs table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Plugin configs table ready', { status: 'success' });
    });

    // 插件定时更新配置表
    db.run(`
      CREATE TABLE IF NOT EXISTS plugin_auto_update (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enabled INTEGER DEFAULT 0,
        cron_expression TEXT DEFAULT '0 0 * * *',
        last_update_time INTEGER,
        last_update_total INTEGER DEFAULT 0,
        last_update_success INTEGER DEFAULT 0,
        last_update_failed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating plugin_auto_update table', { status: 'failed', error: logger.formatError(err) });
      else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Plugin auto update table ready', { status: 'success' });
        initDefaultAutoUpdateConfig();
      }
    });

    // 下载记录表：直接用歌曲自身 song_id+plugin 标识（不再依赖 songs 表）
    db.run(`
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        song_id TEXT NOT NULL,
        plugin TEXT NOT NULL,
        music_data TEXT,
        file_path TEXT,
        file_size INTEGER,
        quality TEXT,
        status TEXT DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        download_speed INTEGER,
        retry_count INTEGER DEFAULT 0,
        error_msg TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        UNIQUE(song_id, plugin)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating downloads table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Downloads table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_downloads_song_id ON downloads(song_id)`);

    // 下载队列视图（不再 JOIN songs；歌曲元数据存于 downloads.music_data）
    db.run(`
      CREATE VIEW IF NOT EXISTS download_queue AS
      SELECT * FROM downloads
      WHERE status IN ('queued', 'paused', 'failed')
      ORDER BY created_at ASC
    `);

    // 播放队列表：直接用歌曲自身 song_id+plugin 标识，歌曲完整元数据冗余存于 music_data（不再依赖 songs 表）
    db.run(`
      CREATE TABLE IF NOT EXISTS play_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        song_id TEXT NOT NULL,
        plugin TEXT NOT NULL,
        music_data TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, song_id, plugin)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating play_queue table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Play queue table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_play_queue_user_id ON play_queue(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_play_queue_order ON play_queue(sort_order)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_play_queue_song_id ON play_queue(song_id)`);

    // 播放器状态表（合并 player_state + user_player_state，添加 user_id 字段）
    db.run(`
      CREATE TABLE IF NOT EXISTS player_state (
        user_id INTEGER PRIMARY KEY DEFAULT 0,
        current_index INTEGER DEFAULT 0,
        current_time REAL DEFAULT 0,
        is_playing INTEGER DEFAULT 0,
        play_mode TEXT DEFAULT 'list',
        is_shuffle INTEGER DEFAULT 0,
        volume REAL DEFAULT 1.0,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating player_state table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Player state table ready', { status: 'success' });
    });

    // ==================== 用户系统表 ====================
    
    // 用户表
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        remark TEXT,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating users table', { status: 'failed', error: logger.formatError(err) });
      else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Users table ready', { status: 'success' });
        // 初始化默认管理员
        initDefaultAdmin();
      }
    });

    // 用户权限表
    db.run(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        can_access_recommend INTEGER DEFAULT 1,
        can_access_toplist INTEGER DEFAULT 1,
        can_access_search INTEGER DEFAULT 1,
        can_access_download INTEGER DEFAULT 1,
        can_access_favorites INTEGER DEFAULT 1,
        can_access_play_history INTEGER DEFAULT 1,
        can_manage_plugins INTEGER DEFAULT 0,
        can_view_logs INTEGER DEFAULT 0,
        can_manage_settings INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating user_permissions table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'User permissions table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id)`);

    // 用户订阅榜单表（用户隔离）
    db.run(`
      CREATE TABLE IF NOT EXISTS user_subscribed_toplists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        toplist_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        cover TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, platform, toplist_id)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating user_subscribed_toplists table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'User subscribed toplists table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_user_subscribed_toplists_user_id ON user_subscribed_toplists(user_id)`);

    // 订阅榜单歌曲表（存储订阅榜单的歌曲列表）
    db.run(`
      CREATE TABLE IF NOT EXISTS subscribed_toplist_songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        subscription_id INTEGER NOT NULL,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        rank INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (subscription_id) REFERENCES user_subscribed_toplists(id) ON DELETE CASCADE,
        UNIQUE(user_id, subscription_id, song_id)
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating subscribed_toplist_songs table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Subscribed toplist songs table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_subscribed_toplist_songs_user_id ON subscribed_toplist_songs(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_subscribed_toplist_songs_subscription_id ON subscribed_toplist_songs(subscription_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_subscribed_toplist_songs_rank ON subscribed_toplist_songs(subscription_id, rank)`);
    
    
    // 添加 artwork 字段（封面图URL）
    db.run(`ALTER TABLE subscribed_toplist_songs ADD COLUMN artwork TEXT`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Note: artwork column may already exist', { error: err.message });
      }
    });
    
    // 添加 platform 字段（平台标识）
    db.run(`ALTER TABLE subscribed_toplist_songs ADD COLUMN platform TEXT`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Note: platform column may already exist', { error: err.message });
      }
    });
    
    // 添加 duration 字段（时长）
    db.run(`ALTER TABLE subscribed_toplist_songs ADD COLUMN duration INTEGER`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Note: duration column may already exist', { error: err.message });
      }
    });

    // 添加 music_data 字段（存储完整歌曲数据，用于下载时传递给插件）
    db.run(`ALTER TABLE subscribed_toplist_songs ADD COLUMN music_data TEXT`, (err) => {
      if (err && !err.message.includes('duplicate column')) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Note: music_data column may already exist', { error: err.message });
      }
    });

    // 系统设置表（键值对存储）
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating settings table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Settings table ready', { status: 'success' });
    });

    // 定时任务配置表（存储 M3U 生成等全局任务配置）
    db.run(`
      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 0,
        cron_expression TEXT DEFAULT '0 1 * * *',
        notify_enabled INTEGER DEFAULT 0,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `, (err) => {
      if (err) logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating scheduler_tasks table', { status: 'failed', error: logger.formatError(err) });
      else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Scheduler tasks table ready', { status: 'success' });
    });

    db.run(`CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_task_id ON scheduler_tasks(task_id)`);


    // 初始化时清理超出100条的下载记录
    db.run(`
      DELETE FROM downloads 
      WHERE id NOT IN (
        SELECT id FROM downloads 
        ORDER BY created_at DESC 
        LIMIT 5000
      )
    `, (err) => {
      if (err) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Failed to cleanup downloads on init', { error: logger.formatError(err) });
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Downloads cleaned up on init');
      }
    });

    // 初始化时清理超出100条的播放历史记录
    db.run(`
      DELETE FROM play_history 
      WHERE id NOT IN (
        SELECT id FROM play_history 
        ORDER BY played_at DESC 
        LIMIT 100
      )
    `, (err) => {
      if (err) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Failed to cleanup play history on init', { error: logger.formatError(err) });
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Play history cleaned up on init');
      }
    });
  });
}

// 初始化默认管理员
async function initDefaultAdmin() {
  try {
    // 关键：按“是否还存在任意管理员(role=admin)”判断，而不是字面 username='admin'。
    // 否则用户把管理员改名后重启，会因找不到 username='admin' 而再补建一个 admin 账号。
    const row = await new Promise((resolve, reject) => {
      db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1", (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!row) {
      const now = Date.now();
      // 默认密码: admin，使用 bcrypt 生成哈希
      const passwordHash = await bcrypt.hash('admin', 10);
      
      const adminId = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO users (username, password_hash, role, remark, is_active, created_at, updated_at) 
           VALUES (?, ?, 'admin', '系统管理员', 1, ?, ?)`,
          ['admin', passwordHash, now, now],
          function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });
      
      // 创建管理员权限记录（全部启用）
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO user_permissions (
            user_id, can_access_recommend, can_access_toplist, can_access_search,
            can_access_download, can_access_favorites, can_access_play_history,
            can_manage_plugins, can_view_logs, can_manage_settings, created_at, updated_at
          ) VALUES (?, 1, 1, 1, 1, 1, 1, 1, 1, 1, ?, ?)`,
          [adminId, now, now],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      
      logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Default admin user created (username: admin, password: admin)', { status: 'success' });
    }
  } catch (err) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error initializing admin user', { status: 'failed', error: logger.formatError(err) });
  }
}

/**
 * 重置数据库和设置：清空所有业务表，并重建默认管理员账号（admin/admin）
 */
async function resetDatabase() {
  const tables = [
    'favorites', 'play_history', 'playlists', 'playlist_songs',
    'plugin_configs', 'plugin_auto_update', 'downloads', 'play_queue', 'player_state',
    'users', 'user_permissions', 'user_subscribed_toplists', 'subscribed_toplist_songs',
    'settings', 'scheduler_tasks'
  ];
  for (const t of tables) {
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM ${t}`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  // 清空后 admin 不存在，initDefaultAdmin 会自动重建默认管理员及权限
  await initDefaultAdmin();
}

// 初始化默认定时更新配置
function initDefaultAutoUpdateConfig() {
  db.get('SELECT id FROM plugin_auto_update LIMIT 1', (err, row) => {
    if (err) {
      logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking auto update config', { status: 'failed', error: logger.formatError(err) });
      return;
    }
    if (!row) {
      const now = Date.now();
      db.run(
        'INSERT INTO plugin_auto_update (enabled, cron_expression, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [0, '0 0 * * *', now, now],
        (err) => {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating default auto update config', { status: 'failed', error: logger.formatError(err) });
          } else {
            logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Default auto update config created', { status: 'success' });
          }
        }
      );
    }
  });
}

// ==================== 歌曲管理 ====================

// ==================== 网络歌曲缓存（静态元数据，非播放地址）====================

/**
 * 清洗封面 URL：插件/历史脏数据可能用反引号包住 URL，统一去除后再入库
 */
function cleanCoverUrl(u) {
  return u ? String(u).replace(/^`+|`+$/g, '').trim() : null;
}

/**
 * 将歌曲对象中的播放地址 / token 等时效字段剥离，避免缓存到数据库（红线）。
 * 只保留插件解析所需的静态标识与展示用元数据。
 * @param {Object} music
 * @returns {Object} 已剥离播放地址的副本
 */
function stripPlayUrlFromMusic(music) {
  if (!music || typeof music !== 'object') return music;
  const cloned = { ...music };
  // 播放地址（时效性）：绝不入库，运行时由 /rest/stream 实时向插件获取
  delete cloned.url;
  delete cloned._url;
  delete cloned.playUrl;
  delete cloned.play_url;
  delete cloned.mediaUrl;
  delete cloned.token;
  // 封面地址（时效性）：不持久化，运行时由 /rest/getCoverArt 实时向插件获取
  delete cloned.coverUrl;
  delete cloned.cover_url;
  delete cloned.cover_art_url;
  delete cloned.artwork;
  delete cloned.cover;
  delete cloned.pic;
  delete cloned.image;
  delete cloned.coverArt;
  // 部分插件把时效地址藏在 _data / additionalInfo 里，做浅层清理
  if (cloned._data && typeof cloned._data === 'object') {
    delete cloned._data.url;
    delete cloned._data.playUrl;
    delete cloned._data.play_url;
    delete cloned._data.coverUrl;
    delete cloned._data.cover_art_url;
    delete cloned._data.artwork;
    delete cloned._data.cover;
    delete cloned._data.pic;
    delete cloned._data.image;
  }
  return cloned;
}

/**
 * 计算静态年份（优先 music.year，其次从 releaseDate 取前 4 位）
 */
function extractYear(music) {
  if (music.year) {
    const y = parseInt(music.year, 10);
    if (!Number.isNaN(y)) return y;
  }
  const rd = music.releaseDate || music.release_date;
  if (rd) {
    const y = parseInt(String(rd).slice(0, 4), 10);
    if (!Number.isNaN(y)) return y;
  }
  return null;
}

/**
 * 缓存一首网络歌曲的静态元数据（幂等 upsert，按虚拟 ID 主键）。
 * 不写入任何播放地址 / token。
 * @param {Object} music - 歌曲对象（含 id / title / artist / album / cover 等）
 * @param {string} plugin - 音源（插件文件名）
 * @returns {Promise<string|null>} 成功返回虚拟 ID；本地歌曲或非网络歌曲返回 null
 */
function cacheNetworkSong(music, plugin) {
  return new Promise((resolve, reject) => {
    if (!music || music.id == null) { resolve(null); return; }
    const pid = plugin || music.plugin || music.platform || '';
    // 本地歌曲不进网络缓存
    if (!pid || pid === 'local' || pid === 'Local') { resolve(null); return; }

    const sourceSongId = String(music.id);
    const vId = buildVirtualId(pid, sourceSongId);
    const now = Date.now();
    const safeMusic = stripPlayUrlFromMusic(music);
    const musicData = JSON.stringify(safeMusic);
    const source = music.source || pid;
    const cover = cleanCoverUrl(music.cover || music.artwork || music.coverUrl);
    const year = extractYear(music);

    db.run(`
      INSERT INTO songs (id, source_song_id, plugin, source, title, artist, album, year, genre, cover_art_url, music_data, cache_at, last_access_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_song_id = excluded.source_song_id,
        plugin = excluded.plugin,
        source = excluded.source,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        year = excluded.year,
        genre = excluded.genre,
        cover_art_url = excluded.cover_art_url,
        music_data = excluded.music_data,
        cache_at = excluded.cache_at,
        last_access_at = excluded.last_access_at
    `, [
      vId, sourceSongId, pid, source,
      music.title || null,
      music.artist || null,
      music.album || null,
      year,
      music.genre || null,
      cover,
      musicData,
      now, now
    ], function (err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Cache network song failed', { error: logger.formatError(err), virtualId: vId });
        reject(err);
      } else {
        resolve(vId);
        // 网络歌曲缓存 LRU 上限控制：写入新记录后按 remote__* 条数裁剪最久未访问的
        enforceNetworkCacheLimit().catch(() => {});
      }
    });
  });
}

// ==================== 封面缓存同步清理 ====================
/**
 * songs 表删除记录后，同步删除对应的落盘封面缓存（netcover/）：
 * 仅当同一 cover_art_url 已无任何剩余 songs 行引用时才删文件（多首歌曲共享同一封面时不误删）。
 * 即使误删也无数据损失：收藏/最近播放等下次进列表会按直链重新下载落盘。
 * @param {Array<string>} urls 将被删除（已删除）记录的 cover_art_url 列表
 * @returns {Promise<number>} 实际删除的磁盘文件数
 */
function cleanupNetCoverCacheForSongs(urls) {
  const list = Array.from(new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean)));
  if (!list.length || !db) return Promise.resolve(0);
  return new Promise((resolve) => {
    const placeholders = list.map(() => '?').join(',');
    db.all(
      `SELECT DISTINCT cover_art_url FROM songs WHERE cover_art_url IN (${placeholders})`,
      list,
      (err, rows) => {
        const alive = new Set(err ? [] : (rows || []).map((r) => r.cover_art_url).filter(Boolean));
        const stale = list.filter((u) => !alive.has(u));
        if (!stale.length) return resolve(0);
        let removed = 0;
        let pending = stale.length;
        for (const u of stale) {
          netCoverCache.deleteCoverByUrl(u)
            .then((ok) => { if (ok) removed++; })
            .catch(() => {})
            .finally(() => { if (--pending === 0) resolve(removed); });
        }
      }
    );
  });
}

/**
 * 网络歌曲（songs，id LIKE 'remote__%'）缓存 LRU 上限：
 * 条数超过上限时删除最久未访问（last_access_at 升序）的 10 条；
 * 上限读取设置键 maxNetSongCache（默认 3000）。
 * 本地 local_songs / strm 不在范围内，永不淘汰。
 * 淘汰记录时同步删除其落盘封面缓存（netcover/，无剩余引用才删）。
 */
async function enforceNetworkCacheLimit() {
  let max = DEFAULT_MAX_NET_SONG_CACHE;
  try {
    const raw = await getSetting(NET_CACHE_SETTING_KEY, null);
    const n = parseInt(String(raw == null ? '' : raw), 10);
    if (Number.isFinite(n) && n > 0) max = n;
  } catch { /* 设置读取失败用默认值 */ }
  return new Promise((resolve) => {
    db.get("SELECT COUNT(*) AS cnt FROM songs WHERE id LIKE 'remote__%'", [], (err, row) => {
      const cnt = (row && row.cnt) || 0;
      if (err || cnt <= max) return resolve();
      // 先取将被淘汰的最冷 10 条的封面直链，删除后同步清理落盘封面
      db.all(
        `SELECT cover_art_url FROM songs WHERE id LIKE 'remote__%' ORDER BY last_access_at ASC LIMIT 10`,
        [],
        (selErr, rows) => {
          const coverUrls = (selErr ? [] : (rows || []).map((r) => r.cover_art_url).filter(Boolean));
          db.run(`DELETE FROM songs
                  WHERE id IN (
                    SELECT id FROM songs
                    WHERE id LIKE 'remote__%'
                    ORDER BY last_access_at ASC
                    LIMIT 10
                  )`, [], (delErr) => {
            if (delErr) {
              logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Enforce network song cache limit delete failed', { error: logger.formatError(delErr) });
              return resolve();
            }
            cleanupNetCoverCacheForSongs(coverUrls)
              .then((removed) => {
                if (removed > 0) {
                  logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Evicted songs cover cache cleaned', { files: removed });
                }
              })
              .catch(() => {})
              .finally(() => resolve());
          });
        }
      );
    });
  });
}

/**
 * 兼容别名：OpenSubsonic 等旧调用点仍使用 saveSong(music, plugin)。
 * 现统一改为「只缓存静态元数据」。
 * @returns {Promise<string|null>} 虚拟 ID
 */
function saveSong(music, plugin) {
  return cacheNetworkSong(music, plugin).catch((err) => {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'saveSong(cache) failed', { error: logger.formatError(err) });
    return null;
  });
}

/**
 * 网络歌曲歌词落库：只更新 songs 缓存行 lyric_raw / lyric_struct。
 * 仅在插件成功拿到有效歌词时调用（无歌词时不写入任何 null 以外的脏数据）。
 * lyric_struct 由 LRC 解析为结构化时间轴 JSON，前端可直接使用。
 */
function saveNetworkSongLyric(music, plugin, rawLyric) {
  const raw = String(rawLyric == null ? '' : rawLyric).trim();
  if (!raw) return Promise.resolve();
  const id = toStoredId(music, plugin);
  if (!id) return Promise.resolve();
  let struct = null;
  try {
    // eslint-disable-next-line global-require
    struct = JSON.stringify(require('./lib/lrc-utils').parseLrcStruct(raw));
  } catch { struct = null; }
  return new Promise((resolve) => {
    db.run(
      'UPDATE songs SET lyric_raw = ?, lyric_struct = ?, last_access_at = ? WHERE id = ?',
      [raw, struct, Date.now(), id],
      (err) => {
        if (err) {
          logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'saveNetworkSongLyric failed', { id, error: logger.formatError(err) });
        }
        resolve();
      }
    );
  });
}

/** 读取网络歌曲歌词（songs 行 lyric_raw / lyric_struct）；无则返回 null。
 * 读取视为一次访问：同步刷新 last_access_at（LRU 命中，避免因“只听歌但没再点元数据”被误淘汰）。 */
function loadNetworkSongLyric(music, plugin) {
  const id = toStoredId(music, plugin);
  if (!id) return Promise.resolve(null);
  touchNetworkSong(id).catch(() => {}); // fire-and-forget 刷新访问时间
  return new Promise((resolve) => {
    db.get(
      'SELECT lyric_raw, lyric_struct FROM songs WHERE id = ?',
      [id],
      (err, row) => {
        if (err) {
          logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'loadNetworkSongLyric failed', { id, error: logger.formatError(err) });
          resolve(null);
        } else {
          resolve(row || null);
        }
      }
    );
  });
}

/**
 * 业务表存入的 song_id：网络歌曲返回虚拟 ID，本地歌曲返回原始（纯数字）id。
 * @param {Object} music
 * @param {string} plugin
 * @returns {string}
 */
function toStoredId(music, plugin) {
  const id = music && music.id != null ? String(music.id) : '';
  if (!id) return id;
  if (isVirtualId(id)) return id; // 已经是虚拟 ID，原样返回（避免重复前缀）
  const pid = plugin || (music && (music.plugin || music.platform)) || '';
  if (!pid || pid === 'local' || pid === 'Local') return id; // 本地：保持原样
  return buildVirtualId(pid, id);
}

/**
 * 由调用方传入的 (musicId, plugin) 推导业务表可能存储的 song_id 候选（兼容旧数据与新虚拟 ID）。
 * @returns {string[]}
 */
function storedIdCandidates(musicId, plugin) {
  const id = musicId == null ? '' : String(musicId);
  if (!id) return [id];
  if (isVirtualId(id)) return [id];
  const pid = plugin || '';
  if (pid && pid !== 'local' && pid !== 'Local') return [buildVirtualId(pid, id), id];
  return [id];
}

/**
 * 构造「按 song_id 匹配」的 WHERE 片段，兼容虚拟 ID 与旧版原始 id 两种存储格式。
 * @returns {{sql:string, params:string[]}}
 */
function songIdMatch(musicId, plugin) {
  const cands = storedIdCandidates(musicId, plugin);
  const placeholders = cands.map(() => '?').join(',');
  let sql = `song_id IN (${placeholders})`;
  const params = [...cands];
  if (plugin) { sql += ' AND plugin = ?'; params.push(plugin); }
  return { sql, params };
}

// ==================== 歌曲键控操作的「显示名 / 入库名不一致」兜底 ====================
// 前端可能把「显示用平台名」（musicData.source，如 网易专辑）当作 plugin 传给删除/查询接口，
// 与该行入库时的 plugin 列、song_id 虚拟 ID 前缀（如 网易）不一致，songIdMatch 会命中 0 行
// （接口返回 success 但什么都没删）。兜底：按 plugin 列 + song_id 以 __<rawId> 结尾匹配——
// 虚拟 ID 结构固定为 remote__<source>__<id>，后缀匹配不会误删其它插件的同名数值 id。
function songMatchFallbackIds(table, extraWhereSql, extraParams, musicId, plugin) {
  return new Promise((resolve) => {
    const rawId = String(musicId == null ? '' : musicId);
    db.all(
      `SELECT id, song_id FROM ${table} WHERE ${extraWhereSql} AND plugin = ?`,
      [...extraParams, plugin],
      (err, rows) => {
        if (err || !rows) return resolve([]);
        resolve(
          rows
            .filter((r) => r.song_id === rawId || String(r.song_id || '').endsWith('__' + rawId))
            .map((r) => r.id)
        );
      }
    );
  });
}

// 兜底删除：按 songMatchFallbackIds 找出的主键集合删行，返回删除条数
function deleteRowsByIds(table, extraWhereSql, extraParams, ids) {
  return new Promise((resolve, reject) => {
    if (!ids || !ids.length) return resolve(0);
    const ph = ids.map(() => '?').join(',');
    db.run(
      `DELETE FROM ${table} WHERE ${extraWhereSql} AND id IN (${ph})`,
      [...extraParams, ...ids],
      function (err) {
        if (err) reject(err); else resolve(this.changes);
      }
    );
  });
}

/**
 * 更新缓存歌曲的最后访问时间（LRU 依据），失败静默。
 * @param {string} virtualId
 */
function touchNetworkSong(virtualId) {
  if (!virtualId) return Promise.resolve();
  return new Promise((resolve) => {
    db.run('UPDATE songs SET last_access_at = ? WHERE id = ?', [Date.now(), virtualId], () => resolve());
  });
}

/**
 * 按虚拟 ID 读取网络歌曲缓存（命中即更新 last_access_at）。
 * @param {string} virtualId
 * @returns {Promise<Object|null>}
 */
function getNetworkSongByVirtualId(virtualId) {
  return new Promise((resolve, reject) => {
    if (!virtualId) { resolve(null); return; }
    db.get('SELECT * FROM songs WHERE id = ?', [virtualId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting network song by virtual id', { error: logger.formatError(err), virtualId });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        touchNetworkSong(virtualId).catch(() => {});
        resolve(mapSongRow(row));
      }
    });
  });
}

/**
 * LRU / TTL 清理网络歌曲缓存。
 * - TTL：超过 maxAgeMs（默认 30 天）未访问的条目删除（cache_at 与 last_access_at 取较新者判断）。
 * - 容量上限：超过 maxEntries 时，按 last_access_at 升序删除最冷数据直到回到上限。
 * - 已卸载音源：plugin 不在 allowSources 集合的条目删除（allowSources 为当前已安装插件名）。
 * @param {Object} opts
 * @returns {Promise<{deleted:number, byTtl:number, byCapacity:number, bySource:number}>}
 */
async function cleanupNetworkSongCache(opts = {}) {
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : 30 * 24 * 60 * 60 * 1000; // 30 天
  const maxEntries = opts.maxEntries != null ? opts.maxEntries : 20000;
  const allowSources = opts.allowSources; // Set/Array<string>|undefined
  const now = Date.now();
  const result = { deleted: 0, byTtl: 0, byCapacity: 0, bySource: 0 };

  return new Promise((resolve, reject) => {
    const run = (sql, params, key) => new Promise((res) => {
      db.run(sql, params, function (err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'cleanupNetworkSongCache failed', { step: key, error: logger.formatError(err) });
        } else {
          result[key] += this.changes;
          result.deleted += this.changes;
        }
        res();
      });
    });

    // 取将被删除记录的封面直链（用于删除后同步清理落盘封面缓存）
    const selectCoverUrls = (sql, params) => new Promise((res) => {
      db.all(sql, params, (e, rows) => res(e ? [] : (rows || []).map((r) => r.cover_art_url).filter(Boolean)));
    });
    const coverUrls = [];

    (async () => {
      // 1) TTL 清理：取 cache_at 与 last_access_at 中较新者，超龄即删
      coverUrls.push(...await selectCoverUrls(
        `SELECT DISTINCT cover_art_url FROM songs WHERE (CASE WHEN last_access_at > cache_at THEN last_access_at ELSE cache_at END) < ?`,
        [now - maxAgeMs]
      ));
      await run(
        `DELETE FROM songs WHERE (CASE WHEN last_access_at > cache_at THEN last_access_at ELSE cache_at END) < ?`,
        [now - maxAgeMs], 'byTtl'
      );

      // 2) 已卸载音源清理
      if (allowSources && (Array.isArray(allowSources) || allowSources instanceof Set)) {
        const arr = Array.from(allowSources);
        if (arr.length) {
          // 兼容带/不带 .js 后缀的音源名，两种形态都纳入白名单
          const expanded = [];
          for (const s of arr) {
            expanded.push(s);
            if (/\.js$/i.test(s)) expanded.push(s.replace(/\.js$/i, ''));
            else expanded.push(`${s}.js`);
          }
          const placeholders = expanded.map(() => '?').join(',');
          coverUrls.push(...await selectCoverUrls(`SELECT DISTINCT cover_art_url FROM songs WHERE source NOT IN (${placeholders})`, expanded));
          await run(`DELETE FROM songs WHERE source NOT IN (${placeholders})`, expanded, 'bySource');
        }
        // 白名单为空（极端情况：插件列表暂未就绪）→ 不清理，避免误删全部缓存
      }

      // 3) 容量上限清理：按 last_access_at 升序删最冷数据
      const countRow = await new Promise((res) => {
        db.get('SELECT COUNT(*) AS n FROM songs', [], (e, r) => res(e ? null : r));
      });
      const total = (countRow && countRow.n) || 0;
      if (total > maxEntries) {
        const excess = total - maxEntries;
        // 先取最冷 excess 条的主键，再删除（SQLite 不支持 LIMIT in DELETE 的 ORDER BY 早期版本，这里稳妥用子查询）
        coverUrls.push(...await selectCoverUrls(
          `SELECT DISTINCT cover_art_url FROM songs WHERE id IN (SELECT id FROM songs ORDER BY last_access_at ASC LIMIT ?)`,
          [excess]
        ));
        await run(
          `DELETE FROM songs WHERE id IN (SELECT id FROM songs ORDER BY last_access_at ASC LIMIT ?)`,
          [excess], 'byCapacity'
        );
      }

      // 同步清理被删记录的落盘封面缓存（同一封面无剩余引用才删）
      try {
        const removedCover = await cleanupNetCoverCacheForSongs(coverUrls);
        if (removedCover > 0) result.coverFiles = removedCover;
      } catch { /* 封面清理失败不影响清理结果 */ }

      resolve(result);
    })().catch(reject);
  });
}

/**
 * 根据ID获取歌曲完整信息
 * @param {number} songId - 歌曲本地ID
 * @returns {Promise<Object>}
 */
function getSongById(songId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM songs WHERE id = ?', [songId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting song', { error: logger.formatError(err), songId });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve(mapSongRow(row));
      }
    });
  });
}

/**
 * 根据 song_id 和 plugin 获取歌曲
 * @param {string} musicId - 歌曲音乐ID
 * @param {string} plugin - 插件名称
 * @returns {Promise<Object>}
 */
function getSongByMusicId(musicId, plugin) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM songs WHERE source_song_id = ? AND plugin = ?', [musicId, plugin], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting song by song_id', { error: logger.formatError(err), musicId, plugin });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve(mapSongRow(row));
      }
    });
  });
}

/**
 * 跨插件按 song_id 查歌曲（OpenSubsonic 播放/封面用：客户端只带 song_id，无插件信息）。
 * 返回第一条命中的歌曲（含解析后的 music_data）。
 * @param {string} musicId
 */
/**
 * 业务表兜底查找（songs 缓存表未命中时使用）：
 * 网络歌曲的真值在各业务表（favorites / play_history / playlist_songs / play_queue）的
 * music_data JSON 中（含完整插件字段）。启动后 songs 表是空/被 LRU 清过，箭头音乐等客户端
 * 用旧 id 请求 getSong/stream/lyrics 时据此重建对象，并回写 songs 缓存。
 * 带「负缓存」防同一未知 id 高频全表扫描。
 */
const songBusinessMissCache = new Map();
const SONG_BUSINESS_MISS_TTL = 10 * 60 * 1000;

function escapeLikeValue(s) {
  // 用 '!' 作为 ESCAPE 字符，转义 '!' / '%' / '_' / '\'
  return String(s).replace(/[!%_\\]/g, (c) => '!' + c);
}

async function findMusicFromBusinessTables(musicId) {
  const idStr = String(musicId == null ? '' : musicId);
  if (!idStr) return null;
  const now = Date.now();
  const missAt = songBusinessMissCache.get(idStr);
  if (missAt && now - missAt < SONG_BUSINESS_MISS_TTL) return null;

  const tables = ['favorites', 'play_history', 'playlist_songs', 'play_queue'];
  const needles = ['%"id":"' + escapeLikeValue(idStr) + '"%'];
  if (/^\d+$/.test(idStr)) needles.push('%"id":' + escapeLikeValue(idStr) + '%');

  for (const table of tables) {
    for (const needle of needles) {
      const row = await new Promise((resolve) => {
        db.get(`SELECT plugin, music_data FROM ${table} WHERE music_data LIKE ? ESCAPE '!' LIMIT 1`, [needle], (err, r) => {
          if (err) {
            logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Business fallback lookup failed', { table, idStr, error: logger.formatError(err) });
            resolve(null);
          } else {
            resolve(r || null);
          }
        });
      });
      if (!row || !row.plugin || !row.music_data) continue;
      let md = {};
      try { md = JSON.parse(row.music_data); } catch { /* 忽略坏 JSON */ }
      const plugin = String(row.plugin);
      const music = {
        ...md,
        url: undefined,
        _url: undefined,
        plugin,
        platform: md.platform || plugin,
        source: md.source || plugin
      };
      if (!music || music.id == null) continue;
      // 回写 songs 缓存（后续请求直接命中，无需再扫业务表）
      cacheNetworkSong(music, plugin).catch(() => {});
      songBusinessMissCache.delete(idStr);
      return music;
    }
    // 按业务表 song_id 直接匹配（remote__ 虚拟 id 场景）
    const bySongId = await new Promise((resolve) => {
      db.get(`SELECT plugin, music_data FROM ${table} WHERE song_id = ? LIMIT 1`, [idStr], (err, r) => {
        if (err) { resolve(null); return; }
        resolve(r || null);
      });
    });
    if (bySongId && bySongId.plugin && bySongId.music_data) {
      let md = {};
      try { md = JSON.parse(bySongId.music_data); } catch { /* 忽略坏 JSON */ }
      const plugin = String(bySongId.plugin);
      const music = {
        ...md,
        url: undefined,
        _url: undefined,
        plugin,
        platform: md.platform || plugin,
        source: md.source || plugin
      };
      if (music && music.id != null) {
        cacheNetworkSong(music, plugin).catch(() => {});
        songBusinessMissCache.delete(idStr);
        return music;
      }
    }
  }
  songBusinessMissCache.set(idStr, now);
  return null;
}

/**
 * 按任意 id 查网络歌曲：优先 songs 缓存表（source_song_id 原始 id 或 remote__ 虚拟 id），
 * 未命中则从业务表 music_data 兜底重建并回写缓存。
 * @returns {Promise<Object|null>} 歌曲对象（含 plugin 与原始插件字段），找不到返回 null
 */
async function getSongByMusicIdAny(musicId, opts = {}) {
  const idStr = String(musicId == null ? '' : musicId);
  if (!idStr) return null;
  // 同一 raw id 可能存在多行（同一首歌历史上被多个插件缓存过，如插件改名/重装后）：
  // 取全部候选按最近访问排序；调用方提供 isPluginValid 时优先返回「插件当前真实存在」的行，
  // 避免命中已卸载/改名的旧插件行——否则播放历史会记录下无法播放的 plugin，
  // web 播放时报「无法识别音源（缺少 platform 字段）」
  const rows = await new Promise((resolve, reject) => {
    db.all('SELECT * FROM songs WHERE source_song_id = ? OR id = ? ORDER BY last_access_at DESC', [idStr, idStr], (err, r) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting song by song_id (any)', { error: logger.formatError(err), musicId });
        reject(err);
      } else {
        resolve(r || []);
      }
    });
  });
  if (rows.length) {
    const validate = typeof opts.isPluginValid === 'function' ? opts.isPluginValid : null;
    let picked = null;
    if (validate) {
      picked = rows.find((r) => { try { return validate(r.plugin); } catch { return true; } })
        || rows.find((r) => { try { return validate(r.source); } catch { return false; } })
        || null;
    }
    if (!picked) picked = rows[0];
    return mapSongRow(picked);
  }
  // songs 缓存未命中 → 业务表兜底（启动后 songs 重建 / 被 LRU 淘汰的历史歌曲）
  return findMusicFromBusinessTables(idStr);
}

/**
 * 按 raw id 列出 songs 缓存中全部候选行（跨插件，按最近访问排序），mapSongRow 形状。
 * 供读取侧把旧插件名规范化为当前已安装的插件（getSongByMusicIdAny 只返回单行，这里给全量候选）。
 * @returns {Promise<Array<Object>>}
 */
async function getSongCandidatesByRawId(rawId) {
  const idStr = String(rawId == null ? '' : rawId);
  if (!idStr) return [];
  return new Promise((resolve) => {
    db.all('SELECT * FROM songs WHERE source_song_id = ? ORDER BY last_access_at DESC', [idStr], (err, rows) => {
      if (err) {
        logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'getSongCandidatesByRawId failed', { error: logger.formatError(err), rawId });
        resolve([]);
        return;
      }
      resolve((rows || []).map(mapSongRow));
    });
  });
}

/**
 * 按 标题 + 艺术家 查歌曲（OpenSubsonic 本地无封面歌曲回退网络封面用）。
 * 标题精确匹配；艺术家优先精确、其次包含匹配。返回含 pic 的歌曲对象。
 * @param {string} title
 * @param {string} artist
 */
function findSongByTitleArtist(title, artist) {
  return new Promise((resolve, reject) => {
    if (!title) return resolve(null);
    const safeArtist = String(artist || '').replace(/[%_]/g, '');
    const like = `%${safeArtist}%`;
    db.all(
      `SELECT * FROM songs
       WHERE title = ?
         AND (artist = ? OR (? <> '' AND artist LIKE ?))
       ORDER BY (artist = ?) DESC, cache_at DESC
       LIMIT 1`,
      [title, artist || null, safeArtist, like, artist || null],
      (err, rows) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error finding song by title/artist', { error: logger.formatError(err), title, artist });
          reject(err);
        } else if (!rows || rows.length === 0) {
          resolve(null);
        } else {
          resolve(mapSongRow(rows[0]));
        }
      }
    );
  });
}

// 歌曲行 → 对外对象（含解析后的 music_data）
// 红线：绝不返回播放地址 / token；url 一律不输出。
function mapSongRow(row) {
  let musicData = {};
  if (row.music_data) {
    try {
      // 读取侧清洗：剥离老记录残留的时效性 url/封面地址（同上）
      musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {});
    } catch {
      // Ignore parse error
    }
  }
  const cover = row.cover_art_url || musicData.cover || musicData.artwork || musicData.coverUrl || null;
  return {
    ...musicData,
    // 剥离任何可能混入的播放地址（双重保险）
    url: undefined,
    _url: undefined,
    localId: row.id,
    virtualId: row.id,            // 对外虚拟 ID: remote__{source}__{id}
    id: row.source_song_id,      // 第三方原始 id（供插件解析播放）
    title: row.title || musicData.title,
    artist: row.artist || musicData.artist,
    album: row.album || musicData.album,
    artwork: cover,
    cover,
    duration: musicData.duration != null ? musicData.duration : (row.duration != null ? row.duration : undefined),
    plugin: row.plugin,
    platform: row.source || row.plugin,
    source: row.source || row.plugin,
    genre: row.genre || musicData.genre,
    year: row.year || musicData.year,
    releaseDate: musicData.releaseDate || musicData.release_date,
    cacheAt: row.cache_at,
    lastAccessAt: row.last_access_at
  };
}

// ==================== 最近播放管理 ====================

/**
 * 添加播放记录
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 */
async function addPlayHistory(music, plugin, options = {}, userId = 0) {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  const playedAt = Date.now();
  const playbackPosition = options.position || 0;
  const playbackDevice = options.device || null;

  // 读取最近播放上限（设置项 maxRecentPlay，默认 100）
  let maxRecent = DEFAULT_MAX_RECENT_PLAY;
  try {
    const raw = await getSetting(RECENT_PLAY_SETTING_KEY, null);
    const n = parseInt(String(raw == null ? '' : raw), 10);
    if (Number.isFinite(n) && n > 0) maxRecent = n;
  } catch { /* 设置读取失败用默认值 */ }

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO play_history (user_id, song_id, plugin, music_data, played_at, playback_position, playback_device, play_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [userId, musicId, plugin, musicData, playedAt, playbackPosition, playbackDevice], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Add play history failed', { error: logger.formatError(err), musicId });
        reject(err);
      } else {
        // 清理超出上限的旧记录
        db.run(`
          DELETE FROM play_history 
          WHERE user_id = ? AND id NOT IN (
            SELECT id FROM play_history 
            WHERE user_id = ?
            ORDER BY played_at DESC 
            LIMIT ?
          )
        `, [userId, userId, maxRecent], (cleanupErr) => {
          if (cleanupErr) {
            logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Failed to cleanup old play history', { error: logger.formatError(cleanupErr) });
          }
          memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
        });
        resolve({ id: this.lastID, musicId, playedAt });
      }
    });
  });
}

/**
 * 内部：从数据库加载用户完整播放历史（供内存缓存使用；写入时已裁剪，数据量小）
 */
function loadPlayHistoryFull(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT id, song_id, plugin, music_data, played_at, playback_position, playback_device, play_count
      FROM play_history
      WHERE user_id = ?
      ORDER BY played_at DESC
    `, [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting recent plays', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        const result = rows.map(row => {
          let musicData = {};
          if (row.music_data) {
            try {
              // 读取侧统一清洗：老记录（改造前入库）可能残留时效性 url/封面地址，
              // 一律剥离，强制前端走 /rest/stream 与 /api/cover 实时获取最新数据
              musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {});
            } catch {
              // Ignore parse error
            }
          }
          return {
            ...musicData,
            id: (musicData.id != null ? String(musicData.id) : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            // 虚拟封面 ID：与 OpenSubsonic toChild 约定一致，前端据此经 /api/cover 实时获取封面
            coverArt: row.song_id,
            plugin: row.plugin,
            platform: musicData.source || row.plugin,
            source: musicData.source || row.plugin,
            playedAt: row.played_at,
            playbackPosition: row.playback_position,
            playbackDevice: row.playback_device,
            playCount: row.play_count,
            // 行主键：读取侧把旧插件名规范为现役插件后就地回写用（不发给前端业务逻辑使用）
            _histId: row.id
          };
        });
        resolve(result);
      }
    });
  });
}

/**
 * 获取最近播放列表（读内存缓存，缓存未初始化时查库加载）
 * @param {number} limit
 * @param {number} offset
 */
function getRecentPlays(limit = 100, offset = 0, userId = 0) {
  return memSliceOrLoad(`playHistory:${userId}`, () => loadPlayHistoryFull(userId), limit, offset);
}

/**
 * 清空播放历史
 */
function clearPlayHistory(userId = 0) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM play_history WHERE user_id = ?', [userId], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing play history', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Play history cleared', { deleted: this.changes });
        // 写后刷新内存缓存（清空后缓存为空列表）
        memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
        resolve({ deleted: this.changes });
      }
    });
  });
}

/**
 * 清空所有用户的播放历史（管理员「清零数据」用）：含各用户的播放进度（随流水行删除）。
 * 写后失效全部 playHistory:* 内存缓存。
 */
function clearAllUsersPlayHistory() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM play_history', [], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing all users play history', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        memDelPrefix('playHistory:');
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'All users play history cleared', { deleted: this.changes });
        resolve({ deleted: this.changes });
      }
    });
  });
}

/**
 * 清空所有用户的播放队列（管理员「清零数据」用；play_queue 无内存缓存，直接查库）
 */
function clearAllUsersPlayQueue() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM play_queue', [], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing all users play queue', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'All users play queue cleared', { deleted: this.changes });
        resolve({ deleted: this.changes });
      }
    });
  });
}

/**
 * 删除单条播放记录
 */
function deletePlayHistory(musicId, plugin, userId = 0) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    const refresh = () => memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
    db.run(
      `DELETE FROM play_history WHERE user_id = ? AND ${m.sql}`,
      [userId, ...m.params],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting play history', { error: logger.formatError(err), musicId });
          reject(err);
          return;
        }
        if (this.changes > 0) {
          refresh();
          resolve({ deleted: this.changes });
          return;
        }
        // 兜底：前端可能传「显示用平台名」，与入库 plugin/song_id 前缀不一致 → 按 plugin + 后缀匹配删
        songMatchFallbackIds('play_history', 'user_id = ?', [userId], musicId, plugin)
          .then((ids) => deleteRowsByIds('play_history', 'user_id = ?', [userId], ids))
          .then((n) => { refresh(); resolve({ deleted: n }); })
          .catch((e) => {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting play history (fallback)', { error: logger.formatError(e), musicId });
            reject(e);
          });
      }
    );
  });
}

// ==================== 收藏管理 ====================

/**
 * 添加收藏
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 */
async function addFavorite(music, plugin, userId = 0) {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  const createdAt = Date.now();

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO favorites (user_id, song_id, plugin, music_data, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, song_id, plugin) DO UPDATE SET
        music_data = excluded.music_data,
        created_at = excluded.created_at
    `, [userId, musicId, plugin, musicData, createdAt], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding favorite', { error: logger.formatError(err), musicId });
        reject(err);
      } else {
        memRefreshAsync(`favorites:${userId}`, () => loadFavoritesFull(userId));
        resolve({ id: this.lastID, musicId, plugin, createdAt });
      }
    });
  });
}

/**
 * 内部：从数据库加载用户完整收藏列表（供内存缓存使用）
 */
function loadFavoritesFull(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT song_id, plugin, music_data, created_at as added_at
      FROM favorites
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting favorites', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        const favorites = rows.map(row => {
          let musicData = {};
          if (row.music_data) {
            try {
              // 读取侧统一清洗：老记录（改造前入库）可能残留时效性 url/封面地址，
              // 一律剥离，强制前端走 /rest/stream 与 /api/cover 实时获取最新数据
              musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {});
            } catch {
              // Ignore parse error
            }
          }
          return {
            ...musicData,
            id: (musicData.id != null ? String(musicData.id) : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            // 虚拟封面 ID：与 OpenSubsonic toChild 约定一致，前端据此经 /api/cover 实时获取封面
            coverArt: row.song_id,
            plugin: row.plugin,
            platform: musicData.source || row.plugin,
            source: musicData.source || row.plugin,
            addedAt: row.added_at
          };
        });
        resolve(favorites);
      }
    });
  });
}

/**
 * 获取所有收藏（读内存缓存，缓存未初始化时查库加载）
 */
function getFavorites(userId = 0) {
  return memGetOrLoad(`favorites:${userId}`, () => loadFavoritesFull(userId));
}

/**
 * 检查是否已收藏
 */
function isFavorite(musicId, plugin, userId = 0) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    db.get(
      `SELECT id FROM favorites WHERE user_id = ? AND ${m.sql}`,
      [userId, ...m.params],
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking favorite', { error: logger.formatError(err), musicId, plugin });
          reject(err);
        } else if (row) {
          resolve(true);
        } else {
          // 兜底：显示名/入库名不一致时按后缀匹配再查一次
          songMatchFallbackIds('favorites', 'user_id = ?', [userId], musicId, plugin)
            .then((ids) => resolve(ids.length > 0))
            .catch(() => resolve(false));
        }
      }
    );
  });
}

/**
 * 取消收藏
 */
function removeFavorite(musicId, plugin, userId = 0) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    const refresh = () => memRefreshAsync(`favorites:${userId}`, () => loadFavoritesFull(userId));
    db.run(
      `DELETE FROM favorites WHERE user_id = ? AND ${m.sql}`,
      [userId, ...m.params],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing favorite', { error: logger.formatError(err), musicId });
          reject(err);
        } else if (this.changes > 0) {
          refresh();
          resolve({ deleted: this.changes });
        } else {
          // 兜底：显示名/入库名不一致 → 按 plugin + song_id 后缀匹配删
          songMatchFallbackIds('favorites', 'user_id = ?', [userId], musicId, plugin)
            .then((ids) => deleteRowsByIds('favorites', 'user_id = ?', [userId], ids))
            .then((n) => { refresh(); resolve({ deleted: n }); })
            .catch(reject);
        }
      }
    );
  });
}

/**
 * 清空所有收藏
 */
function clearFavorites() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM favorites', function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing favorites', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Favorites cleared', { deleted: this.changes });
        // 清空所有用户的收藏缓存，避免返回陈旧数据
        memDelPrefix('favorites:');
        resolve({ deleted: this.changes });
      }
    });
  });
}

// ==================== 歌单管理 ====================

// 创建歌单
function createPlaylist(name, description = '', cover = '', userId = 0) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    // 获取当前最大 sort_order
    db.get('SELECT MAX(sort_order) as max_order FROM playlists WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting max sort_order', { error: logger.formatError(err) });
        reject(err);
        return;
      }

      const sortOrder = (row?.max_order || 0) + 1;

      db.run(
        'INSERT INTO playlists (user_id, name, description, cover, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, name, description, cover, sortOrder, now, now],
        function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating playlist', { error: logger.formatError(err), name });
            reject(err);
          } else {
            // 写后刷新内存缓存
            refreshPlaylistListsCache(userId);
            resolve({
              id: this.lastID,
              name,
              description,
              cover,
              sortOrder,
              createdAt: now,
              updatedAt: now
            });
          }
        }
      );
    });
  });
}

// 内部：从数据库加载用户歌单列表（legacy 形状，供内存缓存使用）
function loadPlaylistsLegacy(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT 
        p.*,
        COUNT(ps.id) as song_count
      FROM playlists p
      LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id AND ps.user_id = p.user_id
      WHERE p.user_id = ?
      GROUP BY p.id
      ORDER BY p.sort_order DESC, p.created_at DESC
    `, [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting playlists', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        resolve(rows.map(row => ({
          id: row.id,
          name: row.name,
          description: row.description,
          cover: row.cover,
          sortOrder: row.sort_order,
          songCount: row.song_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        })));
      }
    });
  });
}

// 获取所有歌单（读内存缓存，缓存未初始化时查库加载）
function getPlaylists(userId = 0) {
  return memGetOrLoad(`playlists:${userId}`, () => loadPlaylistsLegacy(userId));
}

// 获取歌单详情
function getPlaylist(playlistId, userId = 0) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM playlists WHERE id = ? AND user_id = ?', [playlistId, userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting playlist', { error: logger.formatError(err), playlistId });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          id: row.id,
          name: row.name,
          description: row.description,
          cover: row.cover,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        });
      }
    });
  });
}

// 按 id 获取歌单（不限拥有者），供“公开歌单”跨用户查看时使用
function getPlaylistById(playlistId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM playlists WHERE id = ?', [playlistId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting playlist by id', { error: logger.formatError(err), playlistId });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          id: row.id,
          userId: row.user_id,
          name: row.name,
          description: row.description,
          cover: row.cover,
          isPublic: !!row.is_public,
          sourceType: row.source_type || null,
          sourcePlatform: row.source_platform || null,
          sourceToplistId: row.source_toplist_id || null,
          cachedSongCount: (row.cached_song_count != null ? row.cached_song_count : null),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        });
      }
    });
  });
}

// 更新歌单
function updatePlaylist(playlistId, updates, userId = 0) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.cover !== undefined) {
      fields.push('cover = ?');
      values.push(updates.cover);
    }

    if (fields.length === 0) {
      resolve({ updated: 0 });
      return;
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(playlistId);
    values.push(userId);

    db.run(
      `UPDATE playlists SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating playlist', { error: logger.formatError(err), playlistId });
          reject(err);
        } else {
          // 写后刷新内存缓存
          refreshPlaylistListsCache(userId);
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

// 删除歌单
function deletePlaylist(playlistId, userId = 0) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM playlists WHERE id = ? AND user_id = ?', [playlistId, userId], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting playlist', { error: logger.formatError(err), playlistId });
        reject(err);
      } else {
        // 写后刷新内存缓存（歌单已删除，歌曲缓存直接失效）
        refreshPlaylistListsCache(userId);
        memDel(`playlistSongs:${userId}:${playlistId}`);
        memDel(`userPlaylistSongs:${userId}:${playlistId}`);
        resolve({ deleted: this.changes });
      }
    });
  });
}

// 更新歌单排序
function updatePlaylistOrder(playlistOrders, userId = 0) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(playlistOrders) || playlistOrders.length === 0) {
      resolve({ updated: 0 });
      return;
    }

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const stmt = db.prepare('UPDATE playlists SET sort_order = ? WHERE id = ? AND user_id = ?');
      let updatedCount = 0;

      playlistOrders.forEach((item, index) => {
        stmt.run(index + 1, item.id, userId, function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating playlist order', { error: logger.formatError(err), playlistId: item.id });
          } else {
            updatedCount += this.changes;
          }
        });
      });

      stmt.finalize((err) => {
        if (err) {
          db.run('ROLLBACK');
          reject(err);
        } else {
          db.run('COMMIT');
          // 排序变更，刷新内存缓存
          refreshPlaylistListsCache(userId);
          resolve({ updated: updatedCount });
        }
      });
    });
  });
}

// 添加歌曲到歌单
async function addSongToPlaylist(playlistId, music, plugin, userId = 0) {
  const musicId = toStoredId(music, plugin);
  // 入库仅存静态元数据：歌名/歌手/专辑/时长 + 插件索引(plugin/song_id)；
  // 播放地址与封面地址全部剥离，运行时播放/拿封面时实时向插件获取。
  const musicData = JSON.stringify(stripPlayUrlFromMusic(music));
  const addedAt = Date.now();

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO playlist_songs (user_id, playlist_id, song_id, plugin, music_data, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, playlist_id, song_id, plugin) DO UPDATE SET
        music_data = excluded.music_data,
        added_at = excluded.added_at
    `, [userId, playlistId, musicId, plugin, musicData, addedAt], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding song to playlist', { error: logger.formatError(err), playlistId, musicId });
        reject(err);
      } else {
        refreshPlaylistListsCache(userId);
        refreshPlaylistSongsCache(userId, playlistId);
        resolve({ id: this.lastID, playlistId, musicId, plugin, addedAt });
      }
    });
  });
}

function removeSongFromPlaylist(playlistId, musicId, plugin, userId = 0) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM playlist_songs WHERE user_id = ? AND playlist_id = ? AND song_id = ? AND plugin = ?',
      [userId, playlistId, musicId, plugin],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing song from playlist', { error: logger.formatError(err), playlistId, musicId });
          reject(err);
        } else {
          refreshPlaylistListsCache(userId);
          refreshPlaylistSongsCache(userId, playlistId);
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

// 清空歌单中的所有歌曲
function clearPlaylistSongs(playlistId, userId = 0) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM playlist_songs WHERE user_id = ? AND playlist_id = ?',
      [userId, playlistId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing playlist songs', { error: logger.formatError(err), playlistId });
          reject(err);
        } else {
          // 写后刷新内存缓存
          refreshPlaylistListsCache(userId);
          refreshPlaylistSongsCache(userId, playlistId);
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

// 内部：从数据库加载歌单歌曲列表（legacy 形状，按加入时间倒序，供内存缓存使用）
function loadPlaylistSongsLegacy(userId, playlistId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT song_id, plugin, music_data, added_at
      FROM playlist_songs
      WHERE user_id = ? AND playlist_id = ?
      ORDER BY added_at DESC
    `, [userId, playlistId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting playlist songs', { error: logger.formatError(err), playlistId });
        reject(err);
      } else {
        const songs = rows.map(row => {
          let musicData = {};
          if (row.music_data) {
            try {
              // 读取侧统一清洗：老记录（改造前入库）可能残留时效性 url/封面地址，
              // 一律剥离，强制前端走 /rest/stream 与 /api/cover 实时获取最新数据
              musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {});
            } catch {
              // Ignore parse error
            }
          }
          return {
            ...musicData,
            id: (musicData.id != null ? String(musicData.id) : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            // 虚拟封面 ID：与 OpenSubsonic toChild 约定一致，前端据此经 /api/cover 实时获取封面
            coverArt: row.song_id,
            plugin: row.plugin,
            platform: musicData.source || row.plugin,
            source: musicData.source || row.plugin,
            addedAt: row.added_at
          };
        });
        resolve(songs);
      }
    });
  });
}

// 获取歌单歌曲列表（读内存缓存，缓存未初始化时查库加载）
function getPlaylistSongs(playlistId, userId = 0) {
  return memGetOrLoad(`playlistSongs:${userId}:${playlistId}`, () => loadPlaylistSongsLegacy(userId, playlistId));
}

// ==================== 用户隔离歌单管理 ====================

/**
 * 创建用户歌单
 * @param {number} userId - 用户ID
 * @param {string} name - 歌单名称
 * @param {string} description - 歌单描述
 * @param {string} cover - 封面图片
 */
function createUserPlaylist(userId, name, description = '', cover = '', isPublic = false, source = null) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.get('SELECT MAX(sort_order) as max_order FROM playlists WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting max sort_order', { error: logger.formatError(err), userId });
        reject(err);
        return;
      }

      const sortOrder = (row?.max_order || 0) + 1;

      // 动态来源：type（toplist 榜单 / playlist 热门歌单）+ platform + toplistId 三者齐全才打标
      const sourceType = (source && (source.type === 'toplist' || source.type === 'playlist') && source.platform && source.toplistId != null && source.toplistId !== '')
        ? source.type : null;
      const sourcePlatform = sourceType ? source.platform : null;
      const sourceToplistId = sourceType ? String(source.toplistId) : null;

      db.run(
        'INSERT INTO playlists (user_id, name, description, cover, is_public, sort_order, created_at, updated_at, source_type, source_platform, source_toplist_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, name, description, cover, isPublic ? 1 : 0, sortOrder, now, now, sourceType, sourcePlatform, sourceToplistId],
        function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating user playlist', { error: logger.formatError(err), userId, name });
            reject(err);
          } else {
            // 写后刷新内存缓存
            refreshPlaylistListsCache(userId);
            resolve({
              id: this.lastID,
              userId,
              name,
              description,
              cover,
              isPublic: !!isPublic,
              sortOrder,
              sourceType,
              sourcePlatform,
              sourceToplistId,
              createdAt: now,
              updatedAt: now
            });
          }
        }
      );
    });
  });
}

// 设置歌单的动态榜单来源（榜单歌单打标用）：打标后进入歌单实时向插件拉取，不再读快照
function setPlaylistSource(playlistId, source) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE playlists SET source_type = ?, source_platform = ?, source_toplist_id = ?, updated_at = ? WHERE id = ?',
      [source.type, source.platform || null, source.toplistId != null ? String(source.toplistId) : null, Date.now(), playlistId],
      function (err) { if (err) reject(err); else resolve(this.changes > 0); }
    );
  });
}

/**
 * 获取用户的所有歌单
 * @param {number} userId - 用户ID
 */
// 内部：从数据库加载用户歌单列表（user 形状，含 type 字段，供内存缓存使用）
function loadPlaylistsUser(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT 
        p.*,
        u.username as owner_username,
        COUNT(ps.id) as song_count,
        p.cached_song_count,
        -- 歌单来源构成（卡片角标用）：落雪音源的 plugin 形如 lx:kg
        SUM(CASE WHEN ps.plugin LIKE 'lx:%' THEN 1 ELSE 0 END) as lx_count,
        SUM(CASE WHEN ps.plugin IS NOT NULL AND ps.plugin != '' AND ps.plugin NOT LIKE 'lx:%'
                  AND ps.plugin NOT IN ('local','undefined','null') THEN 1 ELSE 0 END) as mf_count,
        EXISTS(
          SELECT 1 FROM playlist_songs ps2
          WHERE ps2.playlist_id = p.id AND ps2.user_id = p.user_id
            AND ps2.plugin IS NOT NULL AND ps2.plugin != ''
            AND ps2.plugin != 'local' AND ps2.plugin != 'undefined' AND ps2.plugin != 'null'
        ) as has_network
      FROM playlists p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id AND ps.user_id = p.user_id
      WHERE p.user_id = ? OR p.is_public = 1
      GROUP BY p.id
      ORDER BY p.sort_order DESC, p.created_at DESC
    `, [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user playlists', { status: 'failed', error: logger.formatError(err), userId });
        reject(err);
      } else {
        resolve(rows.map(row => ({
          id: row.id,
          userId: row.user_id,
          name: row.name,
          description: row.description,
          cover: row.cover,
          isPublic: !!row.is_public,
          ownerUsername: row.owner_username,
          sortOrder: row.sort_order,
          songCount: row.song_count,
          cachedSongCount: (row.cached_song_count != null ? row.cached_song_count : null),
          // MF（MusicFree 插件）/ LX（落雪音源）曲目数：歌单卡片角标据此显示
          mfCount: row.mf_count || 0,
          lxCount: row.lx_count || 0,
          type: row.has_network ? 'network' : 'local',
          sourceType: row.source_type || null,
          sourcePlatform: row.source_platform || null,
          sourceToplistId: row.source_toplist_id || null,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        })));
      }
    });
  });
}

/**
 * 获取用户歌单列表（读内存缓存，缓存未初始化时查库加载）
 * @param {number} userId - 用户ID
 */
function getUserPlaylists(userId) {
  return memGetOrLoad(`userPlaylists:${userId}`, () => loadPlaylistsUser(userId));
}

/**
 * 获取用户歌单详情
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 */
function getUserPlaylist(userId, playlistId) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT p.*, u.username as owner_username
      FROM playlists p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.id = ? AND (p.user_id = ? OR p.is_public = 1)
    `, [playlistId, userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user playlist', { error: logger.formatError(err), userId, playlistId });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          id: row.id,
          userId: row.user_id,
          name: row.name,
          description: row.description,
          cover: row.cover,
          isPublic: !!row.is_public,
          ownerUsername: row.owner_username,
          sortOrder: row.sort_order,
          sourceType: row.source_type || null,
          sourcePlatform: row.source_platform || null,
          sourceToplistId: row.source_toplist_id || null,
          cachedSongCount: (row.cached_song_count != null ? row.cached_song_count : null),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        });
      }
    });
  });
}

/**
 * 更新用户歌单
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 * @param {Object} updates - 更新内容
 */
function updateUserPlaylist(userId, playlistId, updates, force = false, ownerId = null, wasPublic = false) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.cover !== undefined) {
      fields.push('cover = ?');
      values.push(updates.cover);
    }
    if (updates.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      values.push(updates.sortOrder);
    }
    if (updates.isPublic !== undefined) {
      fields.push('is_public = ?');
      values.push(updates.isPublic ? 1 : 0);
    }

    if (fields.length === 0) {
      resolve({ updated: 0 });
      return;
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(playlistId);
    // 管理员强制更新他人歌单时忽略所有者限制
    if (!force) values.push(userId);

    db.run(
      `UPDATE playlists SET ${fields.join(', ')} WHERE id = ?${force ? '' : ' AND user_id = ?'}`,
      values,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating user playlist', { error: logger.formatError(err), userId, playlistId, force });
          reject(err);
        } else {
          // 写后刷新内存缓存
          // 歌曲按所有者 userId 存储，force 更新他人歌单时必须用实际 owner 失效缓存
          const cacheOwner = ownerId != null ? ownerId : userId;
          // 公开歌单对所有用户可见（loadPlaylistsUser 含 OR is_public=1），
          // 或管理员更新他人歌单时，仅失效 owner 缓存会导致其他用户列表残留旧数据，
          // 因此须失效全部用户的歌单列表缓存
          if (force || wasPublic || updates.isPublic !== undefined) {
            memDelPrefix('userPlaylists:');
            memDelPrefix('playlists:');
          } else {
            refreshPlaylistListsCache(cacheOwner);
          }
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

/**
 * 删除用户歌单
 * @param {number} userId - 操作者ID（普通用户须为歌单所有者）
 * @param {number} playlistId - 歌单ID
 * @param {boolean} [force=false] - 是否为管理员强制删除（忽略所有者限制，可删他人歌单）
 * @param {number} [ownerId=null] - force 为 true 时歌单实际所有者的 userId，用于正确失效其缓存
 * @param {boolean} [wasPublic=false] - 被删歌单是否为公开歌单（公开歌单对所有用户可见，须失效全部用户缓存）
 */
function deleteUserPlaylist(userId, playlistId, force = false, ownerId = null, wasPublic = false) {
  return new Promise((resolve, reject) => {
    const sql = force
      ? 'DELETE FROM playlists WHERE id = ?'
      : 'DELETE FROM playlists WHERE id = ? AND user_id = ?';
    const params = force ? [playlistId] : [playlistId, userId];
    db.run(sql, params, function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting user playlist', { error: logger.formatError(err), userId, playlistId, force });
        reject(err);
      } else {
        // 写后刷新内存缓存（歌单已删除，歌曲缓存直接失效）
        // 歌曲按所有者 userId 存储，force 删除他人歌单时必须用实际 owner 失效缓存
        const cacheOwner = ownerId != null ? ownerId : userId;
        memDel(`playlistSongs:${cacheOwner}:${playlistId}`);
        memDel(`userPlaylistSongs:${cacheOwner}:${playlistId}`);
        // 公开歌单对所有用户可见（loadPlaylistsUser 含 OR is_public=1），
        // 或管理员删除他人歌单时，仅失效 owner 缓存会导致其他用户列表仍残留该歌单，
        // 因此须失效全部用户的歌单列表缓存
        if (force || wasPublic) {
          memDelPrefix('userPlaylists:');
          memDelPrefix('playlists:');
        } else {
          refreshPlaylistListsCache(cacheOwner);
        }
        resolve({ deleted: this.changes });
      }
    });
  });
}

/**
 * 仅刷新歌单的 updated_at（用于记录“从插件刷新”的时间）
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 * @returns {Promise<number|null>} 新的 updated_at 时间戳；歌单不存在或无权时返回 null
 */
function touchUserPlaylist(userId, playlistId) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      'UPDATE playlists SET updated_at = ? WHERE id = ? AND user_id = ?',
      [now, playlistId, userId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error touching user playlist updated_at', { error: logger.formatError(err), userId, playlistId });
          reject(err);
        } else {
          // 写后刷新内存缓存（updated_at 变化会体现在列表）
          refreshPlaylistListsCache(userId);
          resolve(this.changes > 0 ? now : null);
        }
      }
    );
  });
}

/**
 * 添加歌曲到用户歌单
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 */
async function addSongToUserPlaylist(userId, playlistId, music, plugin) {
  // 验证歌单属于该用户
  const playlist = await getUserPlaylist(userId, playlistId);
  if (!playlist) throw new Error('Playlist not found or access denied');

  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  const addedAt = Date.now();

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    db.get('SELECT MAX(sort_order) as max_order FROM playlist_songs WHERE playlist_id = ?', [playlistId], (err, row) => {
      if (err) { reject(err); return; }
      const sortOrder = (row?.max_order || 0) + 1;

      db.run(
        `INSERT INTO playlist_songs (user_id, playlist_id, song_id, plugin, music_data, added_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, playlist_id, song_id, plugin) DO UPDATE SET
           music_data = excluded.music_data,
           added_at = excluded.added_at`,
        [userId, playlistId, musicId, plugin, musicData, addedAt, sortOrder],
        function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding song to user playlist', { error: logger.formatError(err), userId, playlistId, musicId });
            reject(err);
          } else {
            refreshPlaylistListsCache(userId);
            refreshPlaylistSongsCache(userId, playlistId);
            resolve({ id: this.lastID, musicId, addedAt });
          }
        }
      );
    });
  });
}

/**
 * 从用户歌单移除歌曲
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 * @param {string} musicId - 歌曲音乐ID
 * @param {string} plugin - 插件名称
 */
function removeSongFromUserPlaylist(userId, playlistId, musicId, plugin) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    const where = 'user_id = ? AND playlist_id = ?';
    const whereParams = [userId, playlistId];
    const refresh = () => {
      refreshPlaylistListsCache(userId);
      refreshPlaylistSongsCache(userId, playlistId);
    };
    db.run(
      `DELETE FROM playlist_songs WHERE ${where} AND ${m.sql}`,
      [...whereParams, ...m.params],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing song from user playlist', { error: logger.formatError(err), userId, playlistId, musicId });
          reject(err);
        } else if (this.changes > 0) {
          refresh();
          resolve({ deleted: this.changes });
        } else {
          // 兜底：显示名/入库名不一致 → 按 plugin + song_id 后缀匹配删
          songMatchFallbackIds('playlist_songs', where, whereParams, musicId, plugin)
            .then((ids) => deleteRowsByIds('playlist_songs', where, whereParams, ids))
            .then((n) => { refresh(); resolve({ deleted: n }); })
            .catch(reject);
        }
      }
    );
  });
}

// 内部：从数据库加载用户歌单歌曲列表（user 形状，按 sort_order 排序，供内存缓存使用）
function loadPlaylistSongsUser(userId, playlistId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT song_id, plugin, music_data, added_at, sort_order
      FROM playlist_songs
      WHERE user_id = ? AND playlist_id = ?
      ORDER BY sort_order ASC, added_at DESC
    `, [userId, playlistId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user playlist songs', { error: logger.formatError(err), userId, playlistId });
        reject(err);
      } else {
        const songs = rows.map(row => {
          let musicData = {};
          if (row.music_data) {
            try { musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {}); } catch { /* Ignore parse error */ }
          }
          return {
            ...musicData,
            id: (musicData.id != null ? String(musicData.id) : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            // 虚拟封面 ID：与 OpenSubsonic toChild 约定一致，前端据此经 /api/cover 实时获取封面
            coverArt: row.song_id,
            plugin: row.plugin,
            platform: musicData.source || row.plugin,
            source: musicData.source || row.plugin,
            addedAt: row.added_at,
            sortOrder: row.sort_order
          };
        });
        resolve(songs);
      }
    });
  });
}

/**
 * 获取用户歌单歌曲列表（读内存缓存，缓存未初始化时查库加载）
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 */
function getUserPlaylistSongs(userId, playlistId) {
  return memGetOrLoad(`userPlaylistSongs:${userId}:${playlistId}`, () => loadPlaylistSongsUser(userId, playlistId));
}

// 刷新指定用户的歌单列表缓存（legacy + user 两套）
function refreshPlaylistListsCache(userId) {
  memRefreshAsync(`playlists:${userId}`, () => loadPlaylistsLegacy(userId));
  memRefreshAsync(`userPlaylists:${userId}`, () => loadPlaylistsUser(userId));
}

// 刷新指定歌单的歌曲缓存（legacy + user 两套）
function refreshPlaylistSongsCache(userId, playlistId) {
  memRefreshAsync(`playlistSongs:${userId}:${playlistId}`, () => loadPlaylistSongsLegacy(userId, playlistId));
  memRefreshAsync(`userPlaylistSongs:${userId}:${playlistId}`, () => loadPlaylistSongsUser(userId, playlistId));
}

/**
 * 清空用户歌单歌曲
 * @param {number} userId - 用户ID
 * @param {number} playlistId - 歌单ID
 */
function clearUserPlaylistSongs(userId, playlistId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM playlist_songs WHERE user_id = ? AND playlist_id = ?',
      [userId, playlistId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing user playlist songs', { error: logger.formatError(err), userId, playlistId });
          reject(err);
        } else {
          // 写后刷新内存缓存
          refreshPlaylistListsCache(userId);
          refreshPlaylistSongsCache(userId, playlistId);
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

// ==================== 插件配置管理 ====================

// 获取所有插件配置
function getPluginConfigs() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM plugin_configs ORDER BY created_at DESC', [], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting plugin configs', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        resolve(rows.map(row => ({
          id: row.id,
          pluginName: row.plugin_name,
          url: row.url,
          displayName: row.display_name,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        })));
      }
    });
  });
}

// 获取单个插件配置
function getPluginConfig(pluginName) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM plugin_configs WHERE plugin_name = ?',
      [pluginName],
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting plugin config', { error: logger.formatError(err), pluginName });
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          resolve({
            id: row.id,
            pluginName: row.plugin_name,
            url: row.url,
            displayName: row.display_name,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          });
        }
      }
    );
  });
}

// 保存插件配置
function savePluginConfig(pluginName, url, displayName) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      `INSERT INTO plugin_configs (plugin_name, url, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(plugin_name) DO UPDATE SET
         url = excluded.url,
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
      [pluginName, url, displayName || pluginName, now, now],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving plugin config', { error: logger.formatError(err), pluginName });
          reject(err);
        } else {
          resolve({
            id: this.lastID,
            pluginName,
            url,
            displayName: displayName || pluginName,
            createdAt: now,
            updatedAt: now
          });
        }
      }
    );
  });
}

// 删除插件配置
function deletePluginConfig(pluginName) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM plugin_configs WHERE plugin_name = ?',
      [pluginName],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting plugin config', { error: logger.formatError(err), pluginName });
          reject(err);
        } else {
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

// ==================== 定时更新配置管理 ====================

// 获取定时更新配置
function getAutoUpdateConfig() {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM plugin_auto_update LIMIT 1', (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting auto update config', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          id: row.id,
          enabled: row.enabled === 1,
          cronExpression: row.cron_expression,
          lastUpdateTime: row.last_update_time,
          lastUpdateTotal: row.last_update_total,
          lastUpdateSuccess: row.last_update_success,
          lastUpdateFailed: row.last_update_failed,
          notifyEnabled: row.notify_enabled === 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        });
      }
    });
  });
}

// 更新定时更新配置
function updateAutoUpdateConfig(updates) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];

    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.cronExpression !== undefined) {
      fields.push('cron_expression = ?');
      values.push(updates.cronExpression);
    }
    if (updates.lastUpdateTime !== undefined) {
      fields.push('last_update_time = ?');
      values.push(updates.lastUpdateTime);
    }
    if (updates.lastUpdateTotal !== undefined) {
      fields.push('last_update_total = ?');
      values.push(updates.lastUpdateTotal);
    }
    if (updates.lastUpdateSuccess !== undefined) {
      fields.push('last_update_success = ?');
      values.push(updates.lastUpdateSuccess);
    }
    if (updates.lastUpdateFailed !== undefined) {
      fields.push('last_update_failed = ?');
      values.push(updates.lastUpdateFailed);
    }
    if (updates.notifyEnabled !== undefined) {
      fields.push('notify_enabled = ?');
      values.push(updates.notifyEnabled ? 1 : 0);
    }

    if (fields.length === 0) {
      resolve({ updated: 0 });
      return;
    }

    fields.push('updated_at = ?');
    values.push(Date.now());

    db.run(
      `UPDATE plugin_auto_update SET ${fields.join(', ')}`,
      values,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating auto update config', { status: 'failed', error: logger.formatError(err) });
          reject(err);
        } else {
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

// ==================== 下载管理 ====================

// 添加下载记录
async function addDownload(music, plugin, quality = 'standard') {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  const createdAt = Date.now();

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO downloads (song_id, plugin, music_data, quality, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(song_id, plugin) DO UPDATE SET
        music_data = excluded.music_data,
        quality = excluded.quality,
        status = 'pending',
        progress = 0,
        error_msg = NULL,
        created_at = excluded.created_at,
        completed_at = NULL
    `, [musicId, plugin, musicData, quality, createdAt], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding download', { error: logger.formatError(err), musicId });
        reject(err);
      } else {
        // 清理超出5000条的旧记录（保留最新的5000条，去重窗口更大）
        db.run(`
          DELETE FROM downloads 
          WHERE id NOT IN (
            SELECT id FROM downloads 
            ORDER BY created_at DESC 
            LIMIT 5000
          )
        `, (cleanupErr) => {
          if (cleanupErr) {
            logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Failed to cleanup old downloads', { error: logger.formatError(cleanupErr) });
          }
        });
        memRefreshAsync('downloads:all', loadDownloadsAll);
        resolve({ id: this.lastID, musicId, plugin, quality, status: 'pending', createdAt });
      }
    });
  });
}

// 更新下载状态
function updateDownloadStatus(musicId, plugin, updates) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.progress !== undefined) {
      fields.push('progress = ?');
      values.push(updates.progress);
    }
    if (updates.filePath !== undefined) {
      fields.push('file_path = ?');
      values.push(updates.filePath);
    }
    if (updates.fileSize !== undefined) {
      fields.push('file_size = ?');
      values.push(updates.fileSize);
    }
    if (updates.errorMsg !== undefined) {
      fields.push('error_msg = ?');
      values.push(updates.errorMsg);
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      fields.push('completed_at = ?');
      values.push(Date.now());
    }

    if (fields.length === 0) {
      resolve({ updated: 0 });
      return;
    }

    // 兼容虚拟 ID / 原始 id 两种存储格式（与全库 songIdMatch 约定一致）：
    // addDownload 把 song_id 存成 toStoredId 虚拟 ID，而调用方常传入原始 musicId，
    // 若只做 song_id = ? 精确匹配会命中 0 行，导致状态卡在 pending。
    const match = songIdMatch(musicId, plugin);
    const runValues = [...values, ...match.params];

    db.run(
      `UPDATE downloads SET ${fields.join(', ')} WHERE ${match.sql}`,
      runValues,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating download status', { error: logger.formatError(err), musicId });
          reject(err);
        } else {
          memRefreshDebounced('downloads:all', loadDownloadsAll);
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

// 内部：从数据库加载完整下载列表（最多100条，供内存缓存使用）
function loadDownloadsAll() {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT d.*
      FROM downloads d
      ORDER BY d.created_at DESC LIMIT 100
    `, [], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting downloads', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        const downloads = rows.map(row => {
          let musicData = {};
          if (row.music_data) {
            try {
              // 读取侧统一清洗：老记录（改造前入库）可能残留时效性 url/封面地址，
              // 一律剥离，强制前端走 /rest/stream 与 /api/cover 实时获取最新数据
              musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {});
            } catch {
              // Ignore parse error
            }
          }
          return {
            ...musicData,
            id: (musicData.id != null ? String(musicData.id) : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            // 虚拟封面 ID：与 OpenSubsonic toChild 约定一致，前端据此经 /api/cover 实时获取封面
            coverArt: row.song_id,
            plugin: row.plugin,
            platform: musicData.source || row.plugin,
            source: musicData.source || row.plugin,
            downloadId: row.id,
            filePath: row.file_path,
            fileSize: row.file_size,
            quality: row.quality,
            status: row.status,
            progress: row.progress,
            downloadSpeed: row.download_speed,
            retryCount: row.retry_count,
            errorMsg: row.error_msg,
            errorCode: row.error_code,
            createdAt: row.created_at,
            startedAt: row.started_at,
            completedAt: row.completed_at
          };
        });
        resolve(downloads);
      }
    });
  });
}

// 获取所有下载记录（读内存缓存，缓存未初始化时查库加载；按状态在内存筛选）
function getDownloads(status = 'all') {
  return memGetOrLoad('downloads:all', loadDownloadsAll).then((list) => {
    if (status === 'completed') return list.filter((d) => d.status === 'completed');
    if (status === 'active') return list.filter((d) => d.status !== 'completed');
    return list;
  });
}

// 获取单个下载记录
function getDownload(musicId, plugin) {
  return new Promise((resolve, reject) => {
    const match = songIdMatch(musicId, plugin);
    db.get(
      `SELECT * FROM downloads WHERE ${match.sql}`,
      match.params,
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting download', { error: logger.formatError(err), musicId, plugin });
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          let musicData = {};
          if (row.music_data) {
            try {
              // 读取侧统一清洗：老记录（改造前入库）可能残留时效性 url/封面地址，
              // 一律剥离，强制前端走 /rest/stream 与 /api/cover 实时获取最新数据
              musicData = stripPlayUrlFromMusic(JSON.parse(row.music_data) || {});
            } catch {
              // Ignore parse error
            }
          }
          resolve({
            ...musicData,
            id: (musicData.id != null ? String(musicData.id) : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            // 虚拟封面 ID：与 OpenSubsonic toChild 约定一致，前端据此经 /api/cover 实时获取封面
            coverArt: row.song_id,
            plugin: row.plugin,
            platform: musicData.source || row.plugin,
            source: musicData.source || row.plugin,
            downloadId: row.id,
            filePath: row.file_path,
            fileSize: row.file_size,
            quality: row.quality,
            status: row.status,
            progress: row.progress,
            downloadSpeed: row.download_speed,
            retryCount: row.retry_count,
            errorMsg: row.error_msg,
            errorCode: row.error_code,
            createdAt: row.created_at,
            startedAt: row.started_at,
            completedAt: row.completed_at
          });
        }
      }
    );
  });
}

// 删除下载记录
function deleteDownload(musicId, plugin) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM downloads WHERE (song_id = ? OR id = ?) AND plugin = ?',
      [musicId, musicId, plugin],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting download', { error: logger.formatError(err), musicId });
          reject(err);
        } else {
          logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Download deleted', { musicId, deleted: this.changes });
          memRefreshAsync('downloads:all', loadDownloadsAll);
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

// 清理下载记录（保留最近100条）
function cleanupDownloads() {
  return new Promise((resolve, reject) => {
    db.run(`
      DELETE FROM downloads 
      WHERE id NOT IN (
        SELECT id FROM downloads 
        ORDER BY created_at DESC 
        LIMIT 5000
      )
    `, function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error cleaning up downloads', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Downloads cleaned up', { deleted: this.changes });
        // 写后刷新内存缓存
        memRefreshAsync('downloads:all', loadDownloadsAll);
        resolve({ deleted: this.changes });
      }
    });
  });
}

// ==================== 播放队列管理 ====================

/**
 * 获取播放队列中的所有歌曲
 * @returns {Promise<Array>} - 返回歌曲列表
 */
function getPlayQueue(userId = 0) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT
        pq.song_id,
        pq.plugin,
        pq.music_data,
        pq.sort_order
      FROM play_queue pq
      WHERE pq.user_id = ?
      ORDER BY pq.sort_order ASC, pq.created_at ASC
    `, [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting play queue', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        const songs = rows.map(row => {
          const m = row.music_data ? stripPlayUrlFromMusic(JSON.parse(row.music_data) || {}) : {};
          return {
            id: (isVirtualId(row.song_id) ? parseVirtualId(row.song_id).sourceSongId : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            plugin: row.plugin,
            ...m,
            title: m.title || null,
            artist: m.artist || null,
            album: m.album || null,
            artwork: m.artwork || m.cover || null,
            cover: m.cover || m.artwork || null,
            duration: m.duration || null,
            url: m.url || null,
            source: m.source || row.plugin
          };
        });
        resolve(songs);
      }
    });
  });
}

/**
 * 添加歌曲到播放队列
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 * @returns {Promise<Object>} - 返回操作结果
 */
async function addToPlayQueue(music, plugin, userId = 0) {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    const now = Date.now();

    // 获取当前最大排序值
    db.get('SELECT MAX(sort_order) as max_order FROM play_queue WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting max sort order', { status: 'failed', error: logger.formatError(err) });
        reject(err);
        return;
      }

      const sortOrder = (row?.max_order || 0) + 1;

      db.run(
        'INSERT OR REPLACE INTO play_queue (user_id, song_id, plugin, music_data, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, musicId, plugin, musicData, sortOrder, now],
        function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding to play queue', { status: 'failed', error: logger.formatError(err) });
            reject(err);
          } else {
            resolve({ success: true, id: this.lastID });
          }
        }
      );
    });
  });
}

/**
 * 从播放队列中移除歌曲
 * @param {string} musicId - 歌曲音乐ID
 * @param {string} plugin - 插件名称
 * @returns {Promise<Object>} - 返回操作结果
 */
function removeFromPlayQueue(musicId, plugin, userId = 0) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    db.run(`DELETE FROM play_queue WHERE user_id = ? AND ${m.sql}`, [userId, ...m.params], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing from play queue', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else if (this.changes > 0) {
        resolve({ deleted: this.changes });
      } else {
        // 兜底：显示名/入库名不一致 → 按 plugin + song_id 后缀匹配删
        songMatchFallbackIds('play_queue', 'user_id = ?', [userId], musicId, plugin)
          .then((ids) => deleteRowsByIds('play_queue', 'user_id = ?', [userId], ids))
          .then((n) => resolve({ deleted: n }))
          .catch(reject);
      }
    });
  });
}

/**
 * 清空播放队列
 * @returns {Promise<Object>} - 返回操作结果
 */
function clearPlayQueue(userId = 0) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM play_queue WHERE user_id = ?', [userId], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing play queue', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Play queue cleared', { deleted: this.changes });
        resolve({ deleted: this.changes });
      }
    });
  });
}

/**
 * 保存整个播放队列（替换现有队列）
 * @param {Array} songs - 歌曲列表
 * @returns {Promise<Object>} - 返回操作结果
 */
async function savePlayQueue(songs, userId = 0) {
  try {
    // 先清空现有队列
    await clearPlayQueue(userId);
    
    // 批量添加歌曲
    const results = [];
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const plugin = song.plugin || song.platform;
      if (song.id && plugin) {
        const result = await addToPlayQueue(song, plugin, userId);
        results.push(result);
      }
    }
    
    return { success: true, added: results.length };
  } catch (err) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving play queue', { status: 'failed', error: logger.formatError(err) });
    throw err;
  }
}

// ==================== 播放器状态管理 ====================

/**
 * 获取播放器状态
 * @returns {Promise<Object>} - 返回播放器状态
 */
function getPlayerState(userId = 0) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM player_state WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting player state', { status: 'failed', error: logger.formatError(err) });
        reject(err);
      } else if (!row) {
        // 如果没有记录，返回默认状态
        resolve({
          currentIndex: 0,
          currentTime: 0,
          isPlaying: false,
          playMode: 'list',
          isShuffle: false,
          volume: 1.0
        });
      } else {
        resolve({
          currentIndex: row.current_index,
          currentTime: row.current_time,
          isPlaying: Boolean(row.is_playing),
          playMode: row.play_mode,
          isShuffle: Boolean(row.is_shuffle),
          volume: row.volume,
          updatedAt: row.updated_at
        });
      }
    });
  });
}

/**
 * 保存播放器状态
 * @param {Object} state - 播放器状态
 * @returns {Promise<Object>} - 返回操作结果
 */
function savePlayerState(state, userId = 0) {
  return new Promise((resolve, reject) => {
    const {
      currentIndex = 0,
      currentTime = 0,
      isPlaying = false,
      playMode = 'list',
      isShuffle = false,
      volume = 1.0
    } = state;

    const now = Date.now();

    db.run(
      `INSERT INTO player_state (user_id, current_index, current_time, is_playing, play_mode, is_shuffle, volume, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         current_index = excluded.current_index,
         current_time = excluded.current_time,
         is_playing = excluded.is_playing,
         play_mode = excluded.play_mode,
         is_shuffle = excluded.is_shuffle,
         volume = excluded.volume,
         updated_at = excluded.updated_at`,
      [userId, currentIndex, currentTime, isPlaying ? 1 : 0, playMode, isShuffle ? 1 : 0, volume, now],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving player state', { status: 'failed', error: logger.formatError(err) });
          reject(err);
        } else {
          resolve({ success: true });
        }
      }
    );
  });
}

// ==================== 用户隔离播放队列管理 ====================

/**
 * 获取用户播放队列
 * @param {number} userId - 用户ID
 * @returns {Promise<Array>} - 返回歌曲列表
 */
function getUserPlayQueue(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT
        pq.song_id,
        pq.plugin,
        pq.music_data,
        pq.sort_order
      FROM play_queue pq
      WHERE pq.user_id = ?
      ORDER BY pq.sort_order ASC, pq.created_at ASC
    `, [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user play queue', { status: 'failed', error: logger.formatError(err), userId });
        reject(err);
      } else {
        const songs = rows.map(row => {
          const m = row.music_data ? stripPlayUrlFromMusic(JSON.parse(row.music_data) || {}) : {};
          return {
            id: (isVirtualId(row.song_id) ? parseVirtualId(row.song_id).sourceSongId : row.song_id),
            virtualId: (isVirtualId(row.song_id) ? row.song_id : null),
            plugin: row.plugin,
            ...m,
            title: m.title || null,
            artist: m.artist || null,
            album: m.album || null,
            artwork: m.artwork || m.cover || null,
            cover: m.cover || m.artwork || null,
            duration: m.duration || null,
            url: m.url || null,
            source: m.source || row.plugin
          };
        });
        resolve(songs);
      }
    });
  });
}

/**
 * 添加歌曲到用户播放队列
 * @param {number} userId - 用户ID
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 * @returns {Promise<Object>} - 返回操作结果
 */
async function addToUserPlayQueue(userId, music, plugin) {
  if (!music || music.id == null) {
    return Promise.reject(new Error('addToUserPlayQueue: music.id is required'));
  }
  const musicId = String(music.id);
  const musicData = JSON.stringify(music);
  return new Promise((resolve, reject) => {
    const now = Date.now();

    // 获取当前用户队列的最大排序值
    db.get('SELECT MAX(sort_order) as max_order FROM play_queue WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting max sort order', { status: 'failed', error: logger.formatError(err), userId });
        reject(err);
        return;
      }

      const sortOrder = (row?.max_order || 0) + 1;

      db.run(
        'INSERT OR REPLACE INTO play_queue (user_id, song_id, plugin, music_data, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, musicId, plugin, musicData, sortOrder, now],
        function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding to user play queue', { status: 'failed', error: logger.formatError(err), userId });
            reject(err);
          } else {
            resolve({ success: true, id: this.lastID });
          }
        }
      );
    });
  });
}

/**
 * 从用户播放队列中移除歌曲
 * @param {number} userId - 用户ID
 * @param {string} musicId - 歌曲音乐ID
 * @param {string} plugin - 插件名称
 * @returns {Promise<Object>} - 返回操作结果
 */
function removeFromUserPlayQueue(userId, musicId, plugin) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    db.run(`DELETE FROM play_queue WHERE user_id = ? AND ${m.sql}`, [userId, ...m.params], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing from user play queue', { status: 'failed', error: logger.formatError(err), userId });
        reject(err);
      } else if (this.changes > 0) {
        resolve({ deleted: this.changes });
      } else {
        // 兜底：显示名/入库名不一致 → 按 plugin + song_id 后缀匹配删
        songMatchFallbackIds('play_queue', 'user_id = ?', [userId], musicId, plugin)
          .then((ids) => deleteRowsByIds('play_queue', 'user_id = ?', [userId], ids))
          .then((n) => resolve({ deleted: n }))
          .catch(reject);
      }
    });
  });
}

/**
 * 清空用户播放队列
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} - 返回操作结果
 */
function clearUserPlayQueue(userId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM play_queue WHERE user_id = ?', [userId], function(err) {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing user play queue', { status: 'failed', error: logger.formatError(err), userId });
        reject(err);
      } else {
        logger.info(DB_MODULE, SYSTEM_REQ_ID, 'User play queue cleared', { deleted: this.changes, userId });
        resolve({ deleted: this.changes });
      }
    });
  });
}

/**
 * 保存用户整个播放队列（替换现有队列）
 * @param {number} userId - 用户ID
 * @param {Array} songs - 歌曲列表
 * @returns {Promise<Object>} - 返回操作结果
 */
async function saveUserPlayQueue(userId, songs) {
  try {
    // 先清空用户现有队列
    await clearUserPlayQueue(userId);
    
    // 批量添加歌曲
    const results = [];
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const plugin = song.plugin || song.platform;
      if (song.id && plugin) {
        const result = await addToUserPlayQueue(userId, song, plugin);
        results.push(result);
      }
    }
    
    return { success: true, added: results.length };
  } catch (err) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving user play queue', { status: 'failed', error: logger.formatError(err), userId });
    throw err;
  }
}

// ==================== 用户隔离播放器状态管理 ====================

/**
 * 获取用户播放器状态
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} - 返回播放器状态
 */
function getUserPlayerState(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM player_state WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user player state', { status: 'failed', error: logger.formatError(err), userId });
        reject(err);
      } else if (!row) {
        // 如果没有记录，返回默认状态
        resolve({
          currentIndex: 0,
          currentTime: 0,
          isPlaying: false,
          playMode: 'list',
          isShuffle: false,
          volume: 1.0
        });
      } else {
        resolve({
          currentIndex: row.current_index,
          currentTime: row.current_time,
          isPlaying: Boolean(row.is_playing),
          playMode: row.play_mode,
          isShuffle: Boolean(row.is_shuffle),
          volume: row.volume,
          updatedAt: row.updated_at
        });
      }
    });
  });
}

/**
 * 保存用户播放器状态
 * @param {number} userId - 用户ID
 * @param {Object} state - 播放器状态
 * @returns {Promise<Object>} - 返回操作结果
 */
function saveUserPlayerState(userId, state) {
  return new Promise((resolve, reject) => {
    const {
      currentIndex = 0,
      currentTime = 0,
      isPlaying = false,
      playMode = 'list',
      isShuffle = false,
      volume = 1.0
    } = state;

    const now = Date.now();

    db.run(
      `INSERT INTO player_state (user_id, current_index, current_time, is_playing, play_mode, is_shuffle, volume, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         current_index = excluded.current_index,
         current_time = excluded.current_time,
         is_playing = excluded.is_playing,
         play_mode = excluded.play_mode,
         is_shuffle = excluded.is_shuffle,
         volume = excluded.volume,
         updated_at = excluded.updated_at`,
      [userId, currentIndex, currentTime, isPlaying ? 1 : 0, playMode, isShuffle ? 1 : 0, volume, now],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving user player state', { status: 'failed', error: logger.formatError(err), userId });
          reject(err);
        } else {
          resolve({ success: true });
        }
      }
    );
  });
}

// ==================== 用户系统管理 ====================

/**
 * 根据用户名获取用户
 * @param {string} username - 用户名
 * @returns {Promise<Object>} - 返回用户信息
 */
function getUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user', { error: logger.formatError(err), username });
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * 根据ID获取用户
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} - 返回用户信息
 */
function getUserById(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, username, role, remark, is_active, created_at FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user by id', { error: logger.formatError(err), userId });
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * 获取所有用户
 * @returns {Promise<Array>} - 返回用户列表
 */
function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT u.id, u.username, u.role, u.remark, u.is_active, u.created_at,
             p.can_access_recommend, p.can_access_toplist, p.can_access_search,
             p.can_access_download, p.can_access_favorites, p.can_access_play_history,
             p.can_manage_plugins, p.can_view_logs, p.can_manage_settings
      FROM users u
      LEFT JOIN user_permissions p ON u.id = p.user_id
      ORDER BY u.created_at DESC
    `, (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting all users', { error: logger.formatError(err) });
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * 创建用户
 * @param {Object} user - 用户信息
 * @param {string} passwordHash - 密码哈希
 * @returns {Promise<Object>} - 返回创建结果
 */
function createUser(user, passwordHash) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      `INSERT INTO users (username, password_hash, role, remark, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user.username, passwordHash, user.role || 'user', user.remark || '', user.is_active !== false ? 1 : 0, now, now],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating user', { error: logger.formatError(err), username: user.username });
          reject(err);
        } else {
          const userId = this.lastID;
          // 创建默认权限
          const isAdmin = user.role === 'admin';
          db.run(
            `INSERT INTO user_permissions (
              user_id, can_access_recommend, can_access_toplist, can_access_search,
              can_access_download, can_access_favorites, can_access_play_history,
              can_manage_plugins, can_view_logs, can_manage_settings, created_at, updated_at
            ) VALUES (?, 1, 1, 1, 1, 1, 1, ?, ?, ?, ?, ?)`,
            [userId, isAdmin ? 1 : 0, isAdmin ? 1 : 0, isAdmin ? 1 : 0, now, now],
            (err) => {
              if (err) {
                logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error creating user permissions', { error: logger.formatError(err), userId });
              }
            }
          );
          resolve({ id: userId, username: user.username });
        }
      }
    );
  });
}

/**
 * 更新用户信息
 * @param {number} userId - 用户ID
 * @param {Object} updates - 更新内容
 * @returns {Promise<Object>} - 返回更新结果
 */
function updateUser(userId, updates) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];
    
    if (updates.username !== undefined) {
      fields.push('username = ?');
      values.push(updates.username);
    }
    if (updates.role !== undefined) {
      fields.push('role = ?');
      values.push(updates.role);
    }
    if (updates.remark !== undefined) {
      fields.push('remark = ?');
      values.push(updates.remark);
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(updates.is_active ? 1 : 0);
    }
    
    if (fields.length === 0) {
      resolve({ updated: 0 });
      return;
    }
    
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(userId);
    
    db.run(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
      values,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating user', { error: logger.formatError(err), userId });
          reject(err);
        } else {
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

/**
 * 更新用户密码
 * @param {number} userId - 用户ID
 * @param {string} passwordHash - 新密码哈希
 * @returns {Promise<Object>} - 返回更新结果
 */
function updateUserPassword(userId, passwordHash) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      [passwordHash, Date.now(), userId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating password', { error: logger.formatError(err), userId });
          reject(err);
        } else {
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

/**
 * 删除用户
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} - 返回删除结果
 */
function deleteUser(userId) {
  return new Promise((resolve, reject) => {
    // 显式级联删除该用户的所有子表数据，避免依赖外键 ON DELETE CASCADE。
    // 原因：favorites / play_history / playlists / playlist_songs / play_queue 等子表的
    // user_id 没有外键约束，删除用户不会自动清理，会残留孤儿数据。
    // 注意：downloads 表无 user_id（全局下载任务），不在此清理。
    const tables = [
      'favorites', 'play_history', 'playlists', 'playlist_songs',
      'play_queue', 'user_permissions', 'user_subscribed_toplists',
      'subscribed_toplist_songs',
      'ratings'
    ];
    db.serialize(() => {
      db.run('BEGIN');
      let remaining = tables.length;
      let failed = false;
      const finishDelete = () => {
        db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
          if (err) {
            db.run('ROLLBACK');
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting user record', { error: logger.formatError(err), userId });
            return reject(err);
          }
          db.run('COMMIT', (commitErr) => {
            if (commitErr) return reject(commitErr);
            // 清空该用户相关的全部内存缓存，避免删除后残留陈旧数据
            memDelUser(userId);
            resolve({ deleted: 1 });
          });
        });
      };
      const onStep = (err, table) => {
        if (failed) return;
        if (err) {
          failed = true;
          db.run('ROLLBACK');
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error deleting user data', { error: logger.formatError(err), userId, table });
          return reject(err);
        }
        if (--remaining === 0) finishDelete();
      };
      if (remaining === 0) return finishDelete();
      tables.forEach((t) => {
        db.run(`DELETE FROM ${t} WHERE user_id = ?`, [userId], (err) => onStep(err, t));
      });
    });
  });
}

// ==================== 用户数据隔离 API ====================

/**
 * 添加用户收藏
 * @param {number} userId - 用户ID
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 */
async function addUserFavorite(userId, music, plugin) {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  const createdAt = Date.now();

  // 网络歌曲：缓存静态元数据（不缓存播放地址）
  await cacheNetworkSong(music, plugin).catch(() => {});

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO favorites (user_id, song_id, plugin, music_data, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, song_id, plugin) DO UPDATE SET
         music_data = excluded.music_data,
         created_at = excluded.created_at`,
      [userId, musicId, plugin, musicData, createdAt],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding user favorite', { error: logger.formatError(err), userId, musicId });
          reject(err);
        } else {
          memRefreshAsync(`favorites:${userId}`, () => loadFavoritesFull(userId));
          resolve({ id: this.lastID, musicId, plugin, createdAt });
        }
      }
    );
  });
}

/**
 * 获取用户收藏列表（读内存缓存，缓存未初始化时查库加载）
 * @param {number} userId - 用户ID
 */
function getUserFavorites(userId) {
  return memGetOrLoad(`favorites:${userId}`, () => loadFavoritesFull(userId));
}

/**
 * 检查用户是否已收藏
 * @param {number} userId - 用户ID
 * @param {string} musicId - 歌曲音乐ID
 * @param {string} plugin - 插件名称
 */
function isUserFavorite(userId, musicId, plugin) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    db.get(
      `SELECT id FROM favorites WHERE user_id = ? AND ${m.sql}`,
      [userId, ...m.params],
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error checking user favorite', { error: logger.formatError(err), userId, musicId });
          reject(err);
        } else if (row) {
          resolve(true);
        } else {
          // 兜底：显示名/入库名不一致时按后缀匹配再查一次
          songMatchFallbackIds('favorites', 'user_id = ?', [userId], musicId, plugin)
            .then((ids) => resolve(ids.length > 0))
            .catch(() => resolve(false));
        }
      }
    );
  });
}

/**
 * 批量检查收藏状态（/api/my/favorites/check-batch 专用）：
 * 把 N 条 songIdMatch 条件以 OR 合并成一条 SQL（单次往返），未命中的项再走
 * songMatchFallbackIds 单条兜底（通常为 0 条）。语义与逐条 isUserFavorite 完全一致。
 * @param {number} userId
 * @param {Array<{musicId:string, plugin:string}>} items
 * @returns {Promise<Map<string, boolean>>} key = `${plugin}:${musicId}`
 */
async function filterUserFavorites(userId, items) {
  const entries = [];
  for (const it of items || []) {
    const musicId = it && it.musicId;
    const plugin = it && it.plugin;
    if (!musicId || !plugin) continue;
    entries.push({ musicId: String(musicId), plugin: String(plugin), key: `${plugin}:${musicId}` });
  }
  const result = new Map(entries.map((e) => [e.key, false]));
  if (!entries.length) return result;

  // SQLite 变量数上限保护：按组（每组 ≤3 个参数）分批合并查询
  const CHUNK_GROUPS = 200;
  for (let i = 0; i < entries.length; i += CHUNK_GROUPS) {
    const chunk = entries.slice(i, i + CHUNK_GROUPS);
    const groups = [];
    const params = [userId];
    for (const e of chunk) {
      const m = songIdMatch(e.musicId, e.plugin);
      groups.push(`(${m.sql})`);
      params.push(...m.params);
    }
    let rows = [];
    try {
      rows = await new Promise((resolve, reject) => {
        db.all(
          `SELECT song_id, plugin FROM favorites WHERE user_id = ? AND (${groups.join(' OR ')})`,
          params,
          (err, r) => (err ? reject(err) : resolve(r || []))
        );
      });
    } catch (e) {
      logger.error(DB_MODULE, SYSTEM_REQ_ID, 'filterUserFavorites query failed', { error: logger.formatError(e), userId });
      throw e;
    }
    // 在返回行上按 songIdMatch 的语义逐条判定
    for (const e of chunk) {
      const cands = storedIdCandidates(e.musicId, e.plugin);
      if (rows.some((r) => r.plugin === e.plugin && cands.includes(String(r.song_id)))) {
        result.set(e.key, true);
      }
    }
  }

  // 未命中的走原单条兜底（显示名/入库名不一致），通常为 0 条
  const misses = entries.filter((e) => !result.get(e.key));
  await Promise.all(misses.map(async (e) => {
    try {
      const ids = await songMatchFallbackIds('favorites', 'user_id = ?', [userId], e.musicId, e.plugin);
      if (ids.length) result.set(e.key, true);
    } catch { /* 保持 false */ }
  }));
  return result;
}

/**
 * 取消用户收藏
 * @param {number} userId - 用户ID
 * @param {string} musicId - 歌曲音乐ID
 * @param {string} plugin - 插件名称
 */
function removeUserFavorite(userId, musicId, plugin) {
  return new Promise((resolve, reject) => {
    const m = songIdMatch(musicId, plugin);
    db.run(
      `DELETE FROM favorites WHERE user_id = ? AND ${m.sql}`,
      [userId, ...m.params],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing user favorite', { error: logger.formatError(err), userId, musicId });
          reject(err);
        } else {
          memRefreshAsync(`favorites:${userId}`, () => loadFavoritesFull(userId));
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

// ==================== 评分（OpenSubsonic setRating/getRating） ====================

/**
 * 设置用户评分（1-5）；rating<=0 表示移除评分。
 * @param {number} userId
 * @param {string} mediaId - OpenSubsonic 实体 id（tr- 或网络 song_id）
 * @param {number} rating
 */
function setUserRating(userId, mediaId, rating) {
  return new Promise((resolve, reject) => {
    const r = parseInt(rating, 10);
    if (Number.isNaN(r)) return reject(new Error('Invalid rating'));
    const now = Date.now();
    if (r <= 0) {
      db.run('DELETE FROM ratings WHERE user_id = ? AND media_id = ?', [userId, mediaId], function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing rating', { error: logger.formatError(err), userId, mediaId });
          reject(err);
        } else {
          resolve({ rating: 0, deleted: this.changes });
        }
      });
    } else {
      db.run(
        `INSERT INTO ratings (user_id, media_id, rating, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, media_id) DO UPDATE SET
           rating = excluded.rating,
           updated_at = excluded.updated_at`,
        [userId, mediaId, Math.min(5, Math.max(1, r)), now],
        function(err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error setting rating', { error: logger.formatError(err), userId, mediaId });
            reject(err);
          } else {
            resolve({ rating: Math.min(5, Math.max(1, r)), id: this.lastID });
          }
        }
      );
    }
  });
}

/**
 * 获取单个评分。
 * @param {number} userId
 * @param {string} mediaId
 * @returns {Promise<number>} 0 表示未评分
 */
function getUserRating(userId, mediaId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT rating FROM ratings WHERE user_id = ? AND media_id = ?', [userId, mediaId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting rating', { error: logger.formatError(err), userId, mediaId });
        reject(err);
      } else {
        resolve(row ? row.rating : 0);
      }
    });
  });
}

/**
 * 获取用户全部评分。
 * @param {number} userId
 * @returns {Promise<Map<string, number>>} mediaId -> rating
 */
function getUserRatings(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT media_id, rating FROM ratings WHERE user_id = ?', [userId], (err, rows) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user ratings', { error: logger.formatError(err), userId });
        reject(err);
      } else {
        const map = new Map();
        for (const r of rows) map.set(r.media_id, r.rating);
        resolve(map);
      }
    });
  });
}

/** 播放流水裁剪：每个用户只保留最新 maxRecentPlay 条（设置项，默认 100），删除更早的旧记录 */
async function trimPlayHistoryToLimit(userId) {
  let max = DEFAULT_MAX_RECENT_PLAY;
  try {
    const raw = await getSetting(RECENT_PLAY_SETTING_KEY, null);
    const n = parseInt(String(raw == null ? '' : raw), 10);
    if (Number.isFinite(n) && n > 0) max = n;
  } catch { /* 设置读取失败用默认值 */ }
  return new Promise((resolve) => {
    db.get('SELECT COUNT(*) AS cnt FROM play_history WHERE user_id = ?', [userId], (err, row) => {
      const cnt = (row && row.cnt) || 0;
      if (err || cnt <= max) { resolve(); return; }
      const overflow = cnt - max;
      db.run(
        `DELETE FROM play_history
         WHERE user_id = ?
         AND id IN (
           SELECT id FROM play_history
           WHERE user_id = ?
           ORDER BY id ASC
           LIMIT ?
         )`,
        [userId, userId, overflow],
        (delErr) => {
          if (delErr) {
            logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Trim play history failed', { userId, error: logger.formatError(delErr) });
          }
          memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
          resolve();
        }
      );
    });
  });
}

/**
 * 添加用户播放历史（每首歌每用户只保留最新一行）：
 * 同一首歌已存在记录 → 更新该行（played_at 置为本次、play_count+1、刷新进度/设备/元数据），
 * 使"最近播放"始终是"每首歌一次"（再播只会上浮+累计次数），避免循环播放/多端上报产生大量重复；
 * 不存在 → INSERT 新行（play_count=1）。随后裁剪该用户最老记录，保留最新 MAX_PLAY_HISTORY_PER_USER 首不同歌曲。
 * @param {number} userId - 用户ID
 * @param {Object} music - 歌曲对象
 * @param {string} plugin - 插件名称
 * @param {Object} options - 选项 { position, device }
 */
async function addUserPlayHistory(userId, music, plugin, options = {}) {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  const playedAt = Date.now();
  const playbackPosition = options.position || 0;
  const device = (options && options.device) ? String(options.device) : null;

  // 网络歌曲：缓存静态元数据（不缓存播放地址；同时会更新 last_access_at）
  await cacheNetworkSong(music, plugin).catch(() => {});

  const updated = await new Promise((resolve, reject) => {
    db.run(
      `UPDATE play_history
       SET played_at = ?, music_data = ?, playback_position = ?, playback_device = COALESCE(?, playback_device), play_count = play_count + 1
       WHERE id = (SELECT id FROM play_history WHERE user_id = ? AND song_id = ? AND plugin = ? ORDER BY played_at DESC, id DESC LIMIT 1)`,
      [playedAt, musicData, playbackPosition, device, userId, musicId, plugin],
      function (err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error upserting user play history', { error: logger.formatError(err), userId, musicId });
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      }
    );
  });

  if (!updated) {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO play_history (user_id, song_id, plugin, music_data, played_at, playback_position, playback_device, play_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [userId, musicId, plugin, musicData, playedAt, playbackPosition, device],
        function (err) {
          if (err) {
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding user play history', { error: logger.formatError(err), userId, musicId });
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }

  // 写入成功后裁剪本用户最老记录（保留最新 MAX_PLAY_HISTORY_PER_USER 首不同歌曲）
  await trimPlayHistoryToLimit(userId).catch(() => {});
  memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
  return { id: null, musicId, playedAt };
}

/**
 * OpenSubsonic savePlayPosition：保存播放进度（毫秒）。
 * play_history 现为完整流水：savePlayPosition 只更新「该歌最新一条流水」的进度（不新增流水行）；
 * 若该歌还没有流水记录，则插入一条进度占位行（play_count=0，不参与播放次数/裁剪计数）。
 * 本地/网络歌曲统一支持：song_id 由 toStoredId 归一化（本地 tr-xxx / 网络 remote__）。
 * @param {number} userId
 * @param {Object} music - 歌曲对象（可为 null）
 * @param {string} plugin - 音源（local / 平台插件名）
 * @param {Object} options - { position: 毫秒, device }
 */
function savePlaybackPosition(userId, music, plugin, options = {}) {
  const musicId = toStoredId(music, plugin);
  const pos = Math.max(0, Number(options && options.position) || 0);
  const musicData = JSON.stringify(music || { id: musicId });
  const device = (options && options.device) ? String(options.device) : null;
  const now = Date.now();
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE play_history
       SET playback_position = ?, music_data = ?, playback_device = COALESCE(?, playback_device), played_at = ?
       WHERE id = (SELECT id FROM play_history WHERE user_id = ? AND song_id = ? AND plugin = ? ORDER BY id DESC LIMIT 1)`,
      [pos, musicData, device, now, userId, musicId, plugin],
      function (err) {
        if (err) {
          logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'savePlaybackPosition failed', { error: logger.formatError(err), userId, musicId });
          reject(err);
        } else if (this.changes > 0) {
          memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
          resolve({ songId: musicId, position: pos, updated: this.changes });
        } else {
          // 兜底：显示名/入库名不一致（plugin 列对得上但 song_id 虚拟前缀对不上）时，
          // 先按 plugin + song_id 后缀匹配更新最新一条流水，仍无命中才插入占位行（防止同一首歌重复占位）
          songMatchFallbackIds('play_history', 'user_id = ?', [userId], musicId, plugin)
            .then((ids) => {
              if (!ids.length) return Promise.resolve(0);
              const target = Math.max(...ids);
              return new Promise((res2, rej2) => {
                db.run(
                  `UPDATE play_history
                   SET playback_position = ?, music_data = ?, playback_device = COALESCE(?, playback_device), played_at = ?
                   WHERE id = ?`,
                  [pos, musicData, device, now, target],
                  (e2) => { if (e2) rej2(e2); else res2(1); }
                );
              });
            })
            .then((updated) => {
              if (updated > 0) {
                memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
                resolve({ songId: musicId, position: pos, updated });
                return;
              }
              // 该歌还没有任何流水：插入一条进度占位行（不作为播放事件）
          db.run(
            `INSERT INTO play_history (user_id, song_id, plugin, music_data, played_at, playback_position, playback_device, play_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
            [userId, musicId, plugin, musicData, now, pos, device],
            (iErr) => {
              if (iErr) {
                logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'savePlaybackPosition insert placeholder failed', { error: logger.formatError(iErr), userId, musicId });
                reject(iErr);
              } else {
                memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
                resolve({ songId: musicId, position: pos, updated: 1 });
              }
            }
          );
            });
        }
      }
    );
  });
}

/** 按已存 song_id 直接更新进度（解析不到完整歌曲对象时使用，如本地 tr- id）：只更新该歌最新一条流水 */
function setPlaybackPositionBySongId(userId, songId, position) {
  const pos = Math.max(0, Number(position) || 0);
  if (!songId) return Promise.resolve({ updated: 0 });
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE play_history SET playback_position = ?, played_at = ?
       WHERE id = (SELECT id FROM play_history WHERE user_id = ? AND song_id = ? ORDER BY id DESC LIMIT 1)`,
      [pos, Date.now(), userId, String(songId)],
      function (err) {
        if (err) {
          logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'setPlaybackPositionBySongId failed', { error: logger.formatError(err), userId, songId });
          reject(err);
        } else {
          if ((this.changes || 0) > 0) {
            memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
          }
          resolve({ updated: this.changes || 0 });
        }
      }
    );
  });
}

/**
 * 获取用户播放历史（读内存缓存，缓存未初始化时查库加载）
 * @param {number} userId - 用户ID
 * @param {number} limit - 限制数量
 * @param {number} offset - 偏移量
 */
function getUserPlayHistory(userId, limit = 100, offset = 0) {
  return memSliceOrLoad(`playHistory:${userId}`, () => loadPlayHistoryFull(userId), limit, offset);
}

/**
 * 就地修复播放历史行（旧插件名 → 现役插件）：
 * 读取侧把失效 plugin 的历史规范为同 raw id 的有效插件后调用，回写 song_id/plugin/music_data，
 * 使该行与正常播放记录一致（再次播放时 upsert 能命中同一行，不产生重复条目）。
 * @param {number} userId
 * @param {number} rowId play_history 行主键
 * @param {Object} music 修正后的歌曲对象（含有效 plugin）
 * @param {string} plugin 有效插件名
 * @returns {Promise<{updated:number}>}
 */
function fixPlayHistoryRow(userId, rowId, music, plugin) {
  const musicId = toStoredId(music, plugin);
  const musicData = JSON.stringify(music);
  if (!rowId || !musicId || !plugin) return Promise.resolve({ updated: 0 });
  return new Promise((resolve) => {
    db.run(
      `UPDATE play_history SET song_id = ?, plugin = ?, music_data = ? WHERE id = ? AND user_id = ?`,
      [musicId, plugin, musicData, rowId, userId],
      function (err) {
        if (err) {
          logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'fixPlayHistoryRow failed', { rowId, error: logger.formatError(err) });
          resolve({ updated: 0 });
        } else {
          const updated = this.changes || 0;
          if (updated > 0) {
            memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
          }
          resolve({ updated });
        }
      }
    );
  });
}

// 播放历史总数（前端分页用）。复用内存全量加载：播放历史体量小，开销可控。
async function getUserPlayHistoryTotal(userId) {
  try {
    const all = await loadPlayHistoryFull(userId);
    return all.length;
  } catch {
    return 0;
  }
}

/**
 * 清除用户播放历史
 * @param {number} userId - 用户ID
 */
function clearUserPlayHistory(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM play_history WHERE user_id = ?',
      [userId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing user play history', { error: logger.formatError(err), userId });
          reject(err);
        } else {
          logger.info(DB_MODULE, SYSTEM_REQ_ID, 'User play history cleared', { userId, deleted: this.changes });
          // 写后刷新内存缓存（清空后缓存为空列表）
          memRefreshAsync(`playHistory:${userId}`, () => loadPlayHistoryFull(userId));
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

/**
 * 获取用户权限
 * @param {number} userId - 用户ID
 * @returns {Promise<Object>} - 返回权限信息
 */
function getUserPermissions(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM user_permissions WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user permissions', { error: logger.formatError(err), userId });
        reject(err);
      } else if (!row) {
        // 返回默认权限
        resolve({
          can_access_recommend: 1,
          can_access_toplist: 1,
          can_access_search: 1,
          can_access_download: 1,
          can_access_favorites: 1,
          can_access_play_history: 1,
          can_manage_plugins: 0,
          can_view_logs: 0,
          can_manage_settings: 0
        });
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * 更新用户权限
 * @param {number} userId - 用户ID
 * @param {Object} permissions - 权限对象
 * @returns {Promise<Object>} - 返回更新结果
 */
function updateUserPermissions(userId, permissions) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      `INSERT INTO user_permissions (
        user_id, can_access_recommend, can_access_toplist, can_access_search,
        can_access_download, can_access_favorites, can_access_play_history,
        can_manage_plugins, can_view_logs, can_manage_settings, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        can_access_recommend = excluded.can_access_recommend,
        can_access_toplist = excluded.can_access_toplist,
        can_access_search = excluded.can_access_search,
        can_access_download = excluded.can_access_download,
        can_access_favorites = excluded.can_access_favorites,
        can_access_play_history = excluded.can_access_play_history,
        can_manage_plugins = excluded.can_manage_plugins,
        can_view_logs = excluded.can_view_logs,
        can_manage_settings = excluded.can_manage_settings,
        updated_at = excluded.updated_at`,
      [
        userId,
        permissions.can_access_recommend !== false ? 1 : 0,
        permissions.can_access_toplist !== false ? 1 : 0,
        permissions.can_access_search !== false ? 1 : 0,
        permissions.can_access_download !== false ? 1 : 0,
        permissions.can_access_favorites !== false ? 1 : 0,
        permissions.can_access_play_history !== false ? 1 : 0,
        permissions.can_manage_plugins ? 1 : 0,
        permissions.can_view_logs ? 1 : 0,
        permissions.can_manage_settings ? 1 : 0,
        now, now
      ],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating user permissions', { error: logger.formatError(err), userId });
          reject(err);
        } else {
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

// ==================== 用户订阅榜单（用户隔离）====================

/**
 * 获取用户订阅的榜单
 * @param {number} userId - 用户ID
 * @returns {Promise<Array>} 订阅的榜单列表
 */
// 从数据库加载某用户全部订阅（含隐藏），作为 toplists 内存缓存的完整数据源
function loadSubscribedToplistsFull(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM user_subscribed_toplists WHERE user_id = ? ORDER BY created_at DESC`,
      [userId],
      (err, rows) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting user subscribed toplists', { error: logger.formatError(err), userId });
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}

/**
 * 获取用户订阅的榜单列表（读内存缓存，未命中时查库加载进内存）
 * @param {number} userId - 用户ID
 * @param {boolean} includeHidden - 是否包含隐藏订阅（默认只返回未隐藏）
 * @returns {Promise<Array>}
 */
async function getUserSubscribedToplists(userId, includeHidden = false) {
  const list = await memGetOrLoad(`toplists:${userId}`, () => loadSubscribedToplistsFull(userId));
  if (includeHidden) return list;
  return list.filter((s) => !(s.is_hidden === 1));
}

/**
 * 根据ID获取单个订阅（从缓存列表派生，避免额外查询）
 * @param {number} userId - 用户ID
 * @param {number} subscriptionId - 订阅ID
 * @returns {Promise<Object|null>} 订阅详情
 */
async function getUserSubscribedToplistById(userId, subscriptionId) {
  const list = await getUserSubscribedToplists(userId, true);
  return list.find((s) => String(s.id) === String(subscriptionId)) || null;
}

/**
 * 添加榜单订阅
 * @param {number} userId - 用户ID
 * @param {Object} toplist - 榜单信息
 * @returns {Promise<Object>} 订阅结果
 */
function addUserSubscribedToplist(userId, toplist) {
  return new Promise((resolve, reject) => {
    if (!userId || !toplist || !toplist.platform || !toplist.toplistId) {
      return reject(new Error('参数错误：缺少platform或toplistId，无法添加订阅'));
    }
    const now = Date.now();
    const cronExpression = toplist.cronExpression || '0 0 * * *';
    const downloadQuality = toplist.downloadQuality || 'standard';
    const sourceType = toplist.sourceType || 'toplist';
    const isEnabled = toplist.isEnabled !== undefined ? toplist.isEnabled : 0; // 默认关闭订阅
    const isHidden = toplist.isHidden !== undefined ? toplist.isHidden : 0; // 默认在列表中显示
    const totalSongs = toplist.totalSongs || 0; // 歌曲总数
    const excludeEnabled = toplist.excludeEnabled !== undefined ? toplist.excludeEnabled : 1; // 默认启用下载排除/过滤

    db.run(
      `INSERT INTO user_subscribed_toplists (
        user_id, platform, toplist_id, title, description, cover,
        source_type, cron_expression, download_quality, is_enabled, is_hidden, total_songs, exclude_enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, toplist.platform, toplist.toplistId, toplist.title,
        toplist.description || '', toplist.cover || '',
        sourceType, cronExpression, downloadQuality, isEnabled, isHidden, totalSongs, excludeEnabled ? 1 : 0, now
      ],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error adding user subscribed toplist', { error: logger.formatError(err), userId, toplist });
          reject(err);
        } else {
          memRefreshAsync(`toplists:${userId}`, () => loadSubscribedToplistsFull(userId));
          resolve({ id: this.lastID });
        }
      }
    );
  });
}

/**
 * 更新订阅配置
 * @param {number} userId - 用户ID
 * @param {string} platform - 平台
 * @param {string} toplistId - 榜单ID
 * @param {Object} config - 配置信息
 * @returns {Promise<Object>} 更新结果
 */
function updateSubscribedToplistConfig(userId, platform, toplistId, config) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];

    if (config.isEnabled !== undefined) {
      fields.push('is_enabled = ?');
      values.push(config.isEnabled ? 1 : 0);
    }
    if (config.cronExpression !== undefined) {
      fields.push('cron_expression = ?');
      values.push(config.cronExpression);
    }
    if (config.downloadQuality !== undefined) {
      fields.push('download_quality = ?');
      values.push(config.downloadQuality);
    }
    if (config.lastRunAt !== undefined) {
      fields.push('last_run_at = ?');
      values.push(config.lastRunAt);
    }
    if (config.nextRunAt !== undefined) {
      fields.push('next_run_at = ?');
      values.push(config.nextRunAt);
    }
    if (config.status !== undefined) {
      fields.push('status = ?');
      values.push(config.status);
    }
    if (config.totalSongs !== undefined) {
      fields.push('total_songs = ?');
      values.push(config.totalSongs);
    }
    if (config.downloadedCount !== undefined) {
      fields.push('downloaded_count = ?');
      values.push(config.downloadedCount);
    }
    if (config.failedCount !== undefined) {
      fields.push('failed_count = ?');
      values.push(config.failedCount);
    }
    if (config.lastError !== undefined) {
      fields.push('last_error = ?');
      values.push(config.lastError);
    }
    if (config.isHidden !== undefined) {
      fields.push('is_hidden = ?');
      values.push(config.isHidden ? 1 : 0);
    }
    if (config.excludeEnabled !== undefined) {
      fields.push('exclude_enabled = ?');
      values.push(config.excludeEnabled ? 1 : 0);
    }
    if (config.notifyEnabled !== undefined) {
      fields.push('notify_enabled = ?');
      values.push(config.notifyEnabled ? 1 : 0);
    }

    if (fields.length === 0) {
      resolve({ updated: 0 });
      return;
    }

    values.push(userId, platform, toplistId);

    db.run(
      `UPDATE user_subscribed_toplists SET ${fields.join(', ')} WHERE user_id = ? AND platform = ? AND toplist_id = ?`,
      values,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating subscribed toplist config', { error: logger.formatError(err), userId, platform, toplistId });
          reject(err);
        } else {
          memRefreshAsync(`toplists:${userId}`, () => loadSubscribedToplistsFull(userId));
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

/**
 * 按订阅主键 id 直接更新下载统计（更可靠，不依赖 platform/toplist_id 匹配）
 * @param {number} subscriptionId
 * @param {Object} stats { downloadedCount, totalSongs, failedCount, lastRunAt }
 * @param {number} [userId] - 可选，用于刷新该用户的订阅列表缓存
 */
function updateSubscribedToplistStats(subscriptionId, stats = {}, userId) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];
    if (stats.downloadedCount !== undefined) {
      fields.push('downloaded_count = ?');
      values.push(stats.downloadedCount);
    }
    if (stats.totalSongs !== undefined) {
      fields.push('total_songs = ?');
      values.push(stats.totalSongs);
    }
    if (stats.failedCount !== undefined) {
      fields.push('failed_count = ?');
      values.push(stats.failedCount);
    }
    // 下载也是一次「运行」：写完 last_run_at，前端卡片「更新」不再显示「从未运行」
    if (stats.lastRunAt !== undefined) {
      fields.push('last_run_at = ?');
      values.push(stats.lastRunAt);
    }
    if (fields.length === 0) {
      return resolve({ updated: 0 });
    }
    values.push(subscriptionId);
    db.run(
      `UPDATE user_subscribed_toplists SET ${fields.join(', ')} WHERE id = ?`,
      values,
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating subscribed toplist stats', { error: logger.formatError(err), subscriptionId });
          reject(err);
        } else {
          if (userId !== undefined && userId !== null) {
            memRefreshAsync(`toplists:${userId}`, () => loadSubscribedToplistsFull(userId));
          }
          resolve({ updated: this.changes });
        }
      }
    );
  });
}

/**
 * 获取所有启用的订阅（用于定时任务）
 * @returns {Promise<Array>} 启用的订阅列表
 */
function getEnabledSubscribedToplists() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM user_subscribed_toplists WHERE is_enabled = 1`,
      (err, rows) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting enabled subscribed toplists', { error: logger.formatError(err) });
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}

/**
 * 获取用户启用的订阅榜单
 * @param {number} userId - 用户ID
 * @returns {Promise<Array>}
 */
function getEnabledSubscribedToplistsByUser(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM user_subscribed_toplists WHERE user_id = ? AND is_enabled = 1`,
      [userId],
      (err, rows) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting enabled subscribed toplists by user', { error: logger.formatError(err), userId });
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}

// ==================== 定时任务配置管理 ====================

/**
 * 获取定时任务配置
 * @param {string} taskId - 任务ID
 * @returns {Promise<Object|null>} 任务配置
 */
function getSchedulerTaskConfig(taskId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM scheduler_tasks WHERE task_id = ?',
      [taskId],
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting scheduler task config', { error: logger.formatError(err), taskId });
          reject(err);
        } else {
          if (row) {
            resolve({
              taskId: row.task_id,
              enabled: row.enabled === 1,
              cronExpression: row.cron_expression,
              notifyEnabled: row.notify_enabled === 1,
              lastRunAt: row.last_run_at,
              nextRunAt: row.next_run_at,
              createdAt: row.created_at,
              updatedAt: row.updated_at
            });
          } else {
            resolve(null);
          }
        }
      }
    );
  });
}

/**
 * 保存或更新定时任务配置
 * @param {string} taskId - 任务ID
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>} 保存结果
 */
function saveSchedulerTaskConfig(taskId, config) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const enabled = config.enabled !== undefined ? (config.enabled ? 1 : 0) : 0;
    const cronExpression = config.cronExpression || '0 1 * * *';
    const notifyEnabled = config.notifyEnabled !== undefined ? (config.notifyEnabled ? 1 : 0) : 0;
    const lastRunAt = config.lastRunAt || null;
    const nextRunAt = config.nextRunAt || null;

    db.run(
      `INSERT INTO scheduler_tasks (task_id, enabled, cron_expression, notify_enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         enabled = excluded.enabled,
         cron_expression = excluded.cron_expression,
         notify_enabled = excluded.notify_enabled,
         last_run_at = excluded.last_run_at,
         next_run_at = excluded.next_run_at,
         updated_at = excluded.updated_at`,
      [taskId, enabled, cronExpression, notifyEnabled, lastRunAt, nextRunAt, now, now],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving scheduler task config', { error: logger.formatError(err), taskId, config });
          reject(err);
        } else {
          resolve({
            taskId,
            enabled: enabled === 1,
            cronExpression,
            notifyEnabled: notifyEnabled === 1,
            lastRunAt,
            nextRunAt,
            updatedAt: now
          });
        }
      }
    );
  });
}

/**
 * 更新定时任务通知设置
 * @param {string} taskId - 任务ID
 * @param {boolean} notifyEnabled - 是否启用通知
 * @returns {Promise<Object>} 更新结果
 */
function updateSchedulerTaskNotify(taskId, notifyEnabled) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      `UPDATE scheduler_tasks SET notify_enabled = ?, updated_at = ? WHERE task_id = ?`,
      [notifyEnabled ? 1 : 0, now, taskId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating scheduler task notify', { error: logger.formatError(err), taskId, notifyEnabled });
          reject(err);
        } else {
          resolve({ updated: this.changes > 0 });
        }
      }
    );
  });
}

/**
 * 更新定时任务最后执行时间
 * @param {string} taskId - 任务ID
 * @param {number} lastRunAt - 最后执行时间戳
 * @param {number} nextRunAt - 下次执行时间戳
 * @returns {Promise<Object>} 更新结果
 */
function updateSchedulerTaskRunTime(taskId, lastRunAt, nextRunAt) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.run(
      `UPDATE scheduler_tasks SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE task_id = ?`,
      [lastRunAt, nextRunAt, now, taskId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error updating scheduler task run time', { error: logger.formatError(err), taskId, lastRunAt, nextRunAt });
          reject(err);
        } else {
          resolve({ updated: this.changes > 0 });
        }
      }
    );
  });
}

/**
 * 取消榜单订阅
 * @param {number} userId - 用户ID
 * @param {string} platform - 平台
 * @param {string} toplistId - 榜单ID
 * @returns {Promise<Object>} 取消结果
 */
// 按订阅 id 级联删除订阅及其歌曲（核心逻辑，供按 id / 按 platform+toplistId 两种入口复用）
function removeUserSubscribedToplistById(userId, subscriptionId) {
  return new Promise((resolve, reject) => {
    // 显式级联删除关联歌曲，不依赖 FK ON DELETE CASCADE。
    // 原因：表用 CREATE TABLE IF NOT EXISTS 创建，旧库表可能不含外键约束，CASCADE 不生效会导致歌曲残留。
    // 显式删除即便在 CASCADE 已生效时也只是影响 0 行，无副作用。
    db.serialize(() => {
      db.run('BEGIN');
      db.run(
        `DELETE FROM subscribed_toplist_songs WHERE user_id = ? AND subscription_id = ?`,
        [userId, subscriptionId],
        (songErr) => {
          if (songErr) {
            db.run('ROLLBACK');
            logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing subscribed toplist songs', { error: logger.formatError(songErr), userId, subscriptionId });
            return reject(songErr);
          }
          db.run(
            `DELETE FROM user_subscribed_toplists WHERE user_id = ? AND id = ?`,
            [userId, subscriptionId],
            (subErr) => {
              if (subErr) {
                db.run('ROLLBACK');
                logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error removing user subscribed toplist by id', { error: logger.formatError(subErr), userId, subscriptionId });
                return reject(subErr);
              }
              db.run('COMMIT', (commitErr) => {
                if (commitErr) return reject(commitErr);
                memRefreshAsync(`toplists:${userId}`, () => loadSubscribedToplistsFull(userId));
                memDel(`toplistSongs:${userId}:${subscriptionId}`);
                resolve({ deleted: 1 });
              });
            }
          );
        }
      );
    });
  });
}

// 取消榜单订阅：支持按订阅 id 或 (platform + toplistId) 删除。
// 原因：前端删除订阅通常只传入订阅记录 id，旧接口仅按 platform+toplistId 匹配会删 0 行却返回成功，
// 导致前端列表消失而数据库记录残留（"删了但库里没删"）。
function removeUserSubscribedToplist(userId, platform, toplistId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM user_subscribed_toplists WHERE user_id = ? AND platform = ? AND toplist_id = ?`,
      [userId, platform, toplistId],
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error finding subscription before delete', { error: logger.formatError(err), userId, platform, toplistId });
          return reject(err);
        }
        if (!row) {
          // 未找到对应订阅（可能已被删除），视为成功，避免误报
          return resolve({ deleted: 0 });
        }
        removeUserSubscribedToplistById(userId, row.id).then(resolve, reject);
      }
    );
  });
}

/**
 * 检查用户是否订阅了某个榜单
 * @param {number} userId - 用户ID
 * @param {string} platform - 平台
 * @param {string} toplistId - 榜单ID
 * @returns {Promise<boolean>} 是否已订阅
 */
async function isUserSubscribedToplist(userId, platform, toplistId) {
  const list = await getUserSubscribedToplists(userId, true);
  return list.some(
    (s) => String(s.platform) === String(platform) && String(s.toplist_id) === String(toplistId)
  );
}

/**
 * 保存订阅榜单的歌曲列表
 * @param {number} userId - 用户ID
 * @param {number} subscriptionId - 订阅ID
 * @param {Array} songs - 歌曲列表 [{ musicId, title, artist, album, rank }]
 * @returns {Promise<Object>}
 */
async function saveSubscribedToplistSongs(userId, subscriptionId, songs) {
  const now = Date.now();
  const results = { saved: 0, updated: 0, errors: [] };

  // 先清空该订阅的现有歌曲
  await clearSubscribedToplistSongs(userId, subscriptionId);

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const rank = song.rank !== undefined ? song.rank : i;
    // 兼容 id 和 musicId 两种字段名
    const musicId = song.musicId || song.id;

    // 准备 music_data（存储完整歌曲数据）
    const musicDataJson = JSON.stringify(song);

    try {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO subscribed_toplist_songs (user_id, subscription_id, song_id, title, artist, album, artwork, platform, duration, rank, music_data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, subscription_id, song_id) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           album = excluded.album,
           artwork = excluded.artwork,
           platform = excluded.platform,
           duration = excluded.duration,
           rank = excluded.rank,
           music_data = excluded.music_data`,
          [userId, subscriptionId, musicId, song.title, song.artist || null, song.album || null, song.artwork || null, song.platform || null, song.duration || null, rank, musicDataJson, now],
          function(err) {
            if (err) {
              reject(err);
            } else {
              if (this.changes > 0) {
                results.saved++;
              } else {
                results.updated++;
              }
              resolve();
            }
          }
        );
      });
    } catch (error) {
      results.errors.push({ song: song.title, error: error.message });
    }
  }

  logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Saved subscribed songs', { userId, subscriptionId, saved: results.saved });

  // 写入完成后刷新歌曲内存缓存，保证前端读到最新榜单
  memRefreshAsync(`toplistSongs:${userId}:${subscriptionId}`, () => loadSubscribedToplistSongsFull(userId, subscriptionId));

  return results;
}

/**
 * 获取订阅榜单的歌曲列表（读内存缓存，未命中时查库加载进内存）
 * @param {number} userId - 用户ID
 * @param {number} subscriptionId - 订阅ID
 * @returns {Promise<Array>}
 */
async function getSubscribedToplistSongs(userId, subscriptionId) {
  return memGetOrLoad(
    `toplistSongs:${userId}:${subscriptionId}`,
    () => loadSubscribedToplistSongsFull(userId, subscriptionId)
  );
}

// 从数据库加载订阅歌曲完整列表（作为 toplistSongs 内存缓存的完整数据源）
function loadSubscribedToplistSongsFull(userId, subscriptionId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM subscribed_toplist_songs WHERE user_id = ? AND subscription_id = ? ORDER BY rank ASC, id ASC`,
      [userId, subscriptionId],
      (err, rows) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting subscribed toplist songs', { error: logger.formatError(err), userId, subscriptionId });
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}


/**
 * 规范化歌曲标题（用于匹配）
 * @param {string} title - 原始标题
 * @returns {string} 规范化后的标题
 */
function normalizeSongTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .trim()
    // 统一中点符号：把 "·" 和 "•" 替换为 "."
    .replace(/[\u00B7\u2022]/g, '.')
    // 移除常见后缀（如 "(Live)", "(Remix)" 等）用于匹配
    .replace(/\s*[\(\[【].*?[\)\]】]\s*$/g, '')
    // 移除空格、标点符号（保留.用于匹配）
    .replace(/[\s\-_，,、；;：:!！?？""''《》<>]/g, '')
    // 移除 "MV"、"Official" 等常见词
    .replace(/(official|mv|musicvideo|video|audio|lyrics?|hd|hq|4k|1080p|720p)/gi, '');
}

/**
 * 将歌手字符串转换为规范化后的字符串集合
 * 用于宽松匹配（歌名相同，歌手有交集即可）
 * @param {string} artist - 原始歌手名
 * @returns {Set<string>} 规范化后的歌手集合
 */
function normalizeArtistToSet(artist) {
  if (!artist) return new Set();
  const artists = artist
    .toLowerCase()
    .trim()
    // 统一多种分隔符为逗号
    .replace(/[\u3001&\/]/g, ',')
    // 按逗号分割
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0);
  return new Set(artists);
}

/**
 * 检查两个字符串是否有共同字符
 * @param {string} str1 - 字符串1
 * @param {string} str2 - 字符串2
 * @returns {boolean} 是否有共同字符
 */
function hasCommonChar(str1, str2) {
  if (!str1 || !str2) return false;
  const set1 = new Set(str1.split(''));
  for (const char of str2) {
    if (set1.has(char)) {
      return true;
    }
  }
  return false;
}

/**
 * 清空订阅榜单的歌曲列表
 * @param {number} userId - 用户ID
 * @param {number} subscriptionId - 订阅ID
 * @returns {Promise<Object>}
 */
function clearSubscribedToplistSongs(userId, subscriptionId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM subscribed_toplist_songs WHERE user_id = ? AND subscription_id = ?`,
      [userId, subscriptionId],
      function(err) {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error clearing subscribed toplist songs', { error: logger.formatError(err), userId, subscriptionId });
          reject(err);
        } else {
          // 清空后使歌曲缓存失效（最终状态由 saveSubscribedToplistSongs 刷新）
          memDel(`toplistSongs:${userId}:${subscriptionId}`);
          resolve({ deleted: this.changes });
        }
      }
    );
  });
}

/**
 * 获取系统设置
 * @param {string} key - 设置键名
 * @param {any} defaultValue - 默认值
 * @returns {Promise<any>} 设置值
 */
async function getSetting(key, defaultValue = null) {
  // 系统设置类键：路由到 config.json 的 settings 字段
  if (SYSTEM_SETTING_KEYS.has(key)) {
    return configStore.getConfigSetting(key, defaultValue);
  }
  return new Promise((resolve) => {
    db.get(
      `SELECT value FROM settings WHERE key = ?`,
      [key],
      (err, row) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error getting setting', { error: logger.formatError(err), key });
          resolve(defaultValue);
        } else if (row) {
          try {
            resolve(JSON.parse(row.value));
          } catch {
            resolve(row.value);
          }
        } else {
          resolve(defaultValue);
        }
      }
    );
  });
}

/**
 * 保存系统设置
 * @param {string} key - 设置键名
 * @param {any} value - 设置值
 * @returns {Promise<void>}
 */
async function saveSetting(key, value) {
  // 系统设置类键：路由到 config.json 的 settings 字段
  if (SYSTEM_SETTING_KEYS.has(key)) {
    configStore.setConfigSetting(key, value);
    return;
  }
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
      [key, valueStr, now, valueStr, now],
      (err) => {
        if (err) {
          logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Error saving setting', { error: logger.formatError(err), key });
          reject(err);
        } else {
          // 大值（如封面 URL 索引 netcover_url_index）不打印内容，只记长度，避免日志刷屏/泄露图片地址
          const logValue = (typeof valueStr === 'string' && valueStr.length > 200)
            ? `<${valueStr.length} chars>`
            : valueStr;
          logger.debug(DB_MODULE, SYSTEM_REQ_ID, 'Setting saved', { key, value: logValue });
          resolve();
        }
      }
    );
  });
}

/**
 * 一次性迁移：把 SQLite settings 表中属于「系统设置」的键合并进 config.json。
 * 仅在 config.json 尚无该键值时写入，已存在则保留（幂等，可重复调用）。
 */
async function migrateSystemSettingsToConfig() {
  if (!configStore || typeof configStore.getConfigSetting !== 'function') return;
  try {
    for (const key of SYSTEM_SETTING_KEYS) {
      // 若 config.json 已有该值则跳过，避免覆盖用户已有配置
      const existing = configStore.getConfigSetting(key, undefined);
      if (existing !== undefined) continue;
      const value = await new Promise((resolve) => {
        db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
          if (err || !row) return resolve(undefined);
          try { resolve(JSON.parse(row.value)); } catch { resolve(row.value); }
        });
      });
      if (value !== undefined) {
        configStore.setConfigSetting(key, value);
        logger.info('SYSTEM', 'config', `Migrated setting '${key}' from SQLite to config.json`);
      }
    }
  } catch (e) {
    logger.error('SYSTEM', 'config', 'Failed to migrate system settings to config.json', { error: e.message });
  }
}

/**
 * 一次性迁移：把旧 local_meta 表的全部键值并入系统 settings 表（键加 'local_meta:' 前缀），
 * 迁移完成后删除 local_meta 表。幂等：表不存在或已迁移时安全跳过，可重复调用。
 */
async function migrateLocalMetaToSettings() {
  if (!db) return;
  try {
    const exists = await new Promise((resolve, reject) => {
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='local_meta'",
        (err, row) => { if (err) reject(err); else resolve(!!row); }
      );
    });
    if (!exists) return; // 已迁移或从未存在

    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT key, value FROM local_meta', (err, rs) => {
        if (err) reject(err); else resolve(rs || []);
      });
    });

    const now = Date.now();
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [`local_meta:${r.key}`, r.value, now],
          (err) => { if (err) reject(err); else resolve(); }
        );
      });
    }

    await new Promise((resolve) => {
      db.run('DROP TABLE IF EXISTS local_meta', (err) => {
        if (err) logger.warn(DB_MODULE, SYSTEM_REQ_ID, 'Drop local_meta failed', { error: logger.formatError(err) });
        else logger.info(DB_MODULE, SYSTEM_REQ_ID, 'local_meta table dropped after merge into settings');
        resolve();
      });
    });

    logger.info(DB_MODULE, SYSTEM_REQ_ID, `Migrated ${rows.length} local_meta row(s) into settings`);
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Failed to migrate local_meta into settings', { error: e && e.message });
  }
}

/**
 * 一次性清空已停用的 songs 表数据（保留表结构）。网络歌曲不再入库（停 songs 表），
 * 启动时清空其历史行；用 settings 标志位保证仅执行一次，避免每次重启都误删运行时数据。
 */
async function clearSongsTableData() {
  if (!db) return;
  try {
    const done = await getSetting('songs_data_cleared', false);
    if (done) return; // 已清空过，幂等跳过

    const exists = await new Promise((resolve, reject) => {
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='songs'",
        (err, row) => { if (err) reject(err); else resolve(!!row); }
      );
    });
    if (!exists) {
      await saveSetting('songs_data_cleared', true);
      return;
    }

    const changes = await new Promise((resolve, reject) => {
      db.run('DELETE FROM songs', function run(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    await saveSetting('songs_data_cleared', true);
    logger.info(DB_MODULE, SYSTEM_REQ_ID, `Cleared ${changes} row(s) from deprecated songs table`);
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Failed to clear songs table data', { error: e && e.message });
  }
}

/**
 * 统计当前网络歌曲缓存条数（songs 表中 id LIKE 'remote__%' 的记录）
 * @returns {Promise<number>}
 */
async function getNetworkSongCount() {
  if (!db) return 0;
  try {
    const row = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) AS cnt FROM songs WHERE id LIKE 'remote__%'", [], (err, r) => {
        if (err) reject(err); else resolve(r);
      });
    });
    return (row && row.cnt) || 0;
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Failed to count network songs', { error: e && e.message });
    return 0;
  }
}

/**
 * 清空网络歌曲缓存（songs 表中 id LIKE 'remote__%' 的记录），返回删除条数
 * 本地歌曲（local__* / tr- 等）不受影响。
 * @returns {Promise<number>}
 */
async function clearNetworkSongCache() {
  if (!db) return 0;
  try {
    // 先收集封面直链，清空后同步删除对应落盘封面缓存（netcover/）
    const coverUrls = await new Promise((resolve) => {
      db.all("SELECT DISTINCT cover_art_url FROM songs WHERE id LIKE 'remote__%' AND cover_art_url IS NOT NULL", [], (e, rows) => {
        resolve(e ? [] : (rows || []).map((r) => r.cover_art_url).filter(Boolean));
      });
    });
    const deleted = await new Promise((resolve, reject) => {
      db.run("DELETE FROM songs WHERE id LIKE 'remote__%'", function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
    const removedCover = await cleanupNetCoverCacheForSongs(coverUrls).catch(() => 0);
    logger.info(DB_MODULE, SYSTEM_REQ_ID, `Cleared ${deleted} network song cache row(s), removed ${removedCover} cover cache file(s)`);
    return deleted;
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Failed to clear network song cache', { error: e && e.message });
    throw e;
  }
}


// 导出所有函数
// ==================== 电台（数据库驱动，不再依赖插件平铺数组） ====================
function radioRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function radioAll(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
function radioGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function mapRadioRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    province: row.province || '',
    category: row.category || '',
    network: row.network || '',
    genre: row.genre || '',
    bitrate: row.bitrate || 0,
    cover_url: row.cover_url || '',
    sort_order: row.sort_order || 0
  };
}

async function getRadioStationByIdDB(id) {
  return mapRadioRow(await radioGet('SELECT * FROM radio_stations WHERE id = ?', [id]));
}

async function getRadioStationsDB() {
  const rows = await radioAll('SELECT * FROM radio_stations ORDER BY sort_order ASC, id ASC');
  return rows.map(mapRadioRow);
}

async function createRadioStation(data) {
  const info = await radioRun(
    `INSERT INTO radio_stations (name, url, province, category, network, genre, bitrate, cover_url, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name || '',
      data.url || '',
      data.province || '',
      data.category || '',
      data.network || '',
      data.genre || '',
      parseInt(data.bitrate, 10) || 0,
      data.cover_url || '',
      parseInt(data.sort_order, 10) || 0
    ]
  );
  return getRadioStationByIdDB(info.lastID);
}

async function updateRadioStation(id, data) {
  const fields = [];
  const params = [];
  const set = (k, v) => { fields.push(k + ' = ?'); params.push(v); };
  if (data.name !== undefined) set('name', data.name);
  if (data.url !== undefined) set('url', data.url);
  if (data.province !== undefined) set('province', data.province);
  if (data.category !== undefined) set('category', data.category);
  if (data.network !== undefined) set('network', data.network);
  if (data.genre !== undefined) set('genre', data.genre);
  if (data.bitrate !== undefined) set('bitrate', parseInt(data.bitrate, 10) || 0);
  if (data.cover_url !== undefined) set('cover_url', data.cover_url);
  if (data.sort_order !== undefined) set('sort_order', parseInt(data.sort_order, 10) || 0);
  if (!fields.length) return getRadioStationByIdDB(id);
  params.push(id);
  await radioRun('UPDATE radio_stations SET ' + fields.join(', ') + ' WHERE id = ?', params);
  return getRadioStationByIdDB(id);
}

async function deleteRadioStation(id) {
  await radioRun('DELETE FROM radio_stations WHERE id = ?', [id]);
  return true;
}

// 重排某个分组（维度 + 子项）内电台的顺序：把 orderedIds 的新顺序写回 sort_order。
// 通过「全局顺序重建」实现，仅移动本组电台到其原位置并保持新局部顺序，
// 其余分组的相对顺序不受干扰（解决不同分组 sort_order 交错的问题）。
async function reorderRadioStationsGroup(dimension, subTitle, orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return false;
  const all = await radioAll('SELECT * FROM radio_stations ORDER BY sort_order ASC, id ASC');
  const keyOf = (s) => {
    if (dimension === '省市台') return s.province;
    if (dimension === '分类') return s.category;
    if (dimension === '网络台') return s.network;
    if (dimension === '未分类') return (!s.province && !s.category && !s.network) ? '未分类' : null;
    return null;
  };
  const set = new Set(orderedIds.map(String));
  const byId = {};
  all.forEach((s) => { if (set.has(String(s.id))) byId[String(s.id)] = s; });
  const newGroup = orderedIds.map((id) => byId[String(id)]).filter(Boolean);
  if (!newGroup.length) return false;
  const rest = all.filter((s) => !set.has(String(s.id)));
  const firstIdx = all.findIndex((s) => set.has(String(s.id)));
  if (firstIdx < 0) rest.push(...newGroup);
  else rest.splice(firstIdx, 0, ...newGroup);
  for (let i = 0; i < rest.length; i++) {
    await radioRun('UPDATE radio_stations SET sort_order = ? WHERE id = ?', [i, rest[i].id]);
  }
  return true;
}

// 清空全部电台数据（保留收藏；封面文件随重新导入自动重建，此处不删除磁盘文件）
async function clearRadioStationsDB() {
  await radioRun('DELETE FROM radio_stations');
  return true;
}

// 首次启动把插件里的电台灌入数据库（幂等：仅当表为空时执行一次）
async function migrateRadioStationsFromPlugin() {
  try {
    const countRow = await radioGet('SELECT COUNT(*) AS c FROM radio_stations');
    if (countRow && countRow.c > 0) return 0;
    const pluginPath = path.join(__dirname, '..', 'data', 'plugins', '电台', 'radio.js');
    if (!fs.existsSync(pluginPath)) return 0;
    const mod = require(pluginPath);
    const stations = (mod && mod.stations) || [];
    let n = 0;
    for (const s of stations) {
      if (!s || !s.url) continue;
      await createRadioStation({
        name: s.name || s.title || '未知电台',
        url: s.url || s.streamUrl || '',
        province: s.province || '',
        category: Array.isArray(s.categories) ? (s.categories[0] || '') : (s.category || ''),
        network: s.network || '',
        genre: s.genre || '',
        bitrate: s.bitrate || 0,
        sort_order: n
      });
      n++;
    }
    // 收藏按名称重映射：旧收藏 id 形如「广播电台:名称」，迁移后为整数 id，按名称对齐
    try {
      const favPath = path.join(__dirname, '..', 'data', 'radio-favorites.json');
      if (fs.existsSync(favPath)) {
        const favs = JSON.parse(fs.readFileSync(favPath, 'utf8') || '[]');
        const rows = await radioAll('SELECT id, name FROM radio_stations');
        const nameToId = {};
        for (const r of rows) nameToId[r.name] = r.id;
        let changed = false;
        const newFavs = favs.map((f) => {
          if (f && f.name && nameToId[f.name] != null && String(f.id) !== String(nameToId[f.name])) {
            changed = true;
            return Object.assign({}, f, { id: String(nameToId[f.name]) });
          }
          return f;
        });
        if (changed) fs.writeFileSync(favPath, JSON.stringify(newFavs, null, 2));
      }
    } catch (e) { /* 收藏重映射失败不影响主流程 */ }
    return n;
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Migrate radio stations failed', { error: logger.formatError(e) });
    return 0;
  }
}

// 读取某用户的电台收藏（优先数据库；返回完整电台对象数组，与旧 JSON 文件结构一致）
async function getRadioFavoritesDB(userId) {
  const uid = userId != null ? (parseInt(userId, 10) || 0) : 0;
  try {
    const rows = await radioAll(
      'SELECT favorite_data FROM radio_favorites WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
      [uid]
    );
    return (rows || []).map((r) => {
      try { return JSON.parse(r.favorite_data); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// 写入某用户的电台收藏（整体覆盖；opts.merge=true 时与现有收藏按 url/name/id 去重合并）
async function setRadioFavoritesDB(userId, list, opts) {
  const uid = userId != null ? (parseInt(userId, 10) || 0) : 0;
  const items = Array.isArray(list) ? list : [];
  let toInsert = items;
  if (opts && opts.merge) {
    const existing = await getRadioFavoritesDB(uid);
    const seen = new Set(existing.map((x) => String(x.url || x.name || x.id)));
    const merged = existing.slice();
    for (const it of items) {
      const key = String(it.url || it.name || it.id);
      if (!seen.has(key)) { seen.add(key); merged.push(it); }
    }
    toInsert = merged;
  }
  await radioRun('DELETE FROM radio_favorites WHERE user_id = ?', [uid]);
  for (let i = 0; i < toInsert.length; i++) {
    await radioRun(
      'INSERT INTO radio_favorites (user_id, station_id, favorite_data, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
      [uid, null, JSON.stringify(toInsert[i]), i, Date.now()]
    );
  }
  return toInsert;
}

// 首次启动：把遗留的 radio-favorites-*.json（含全局 radio-favorites.json）迁移进数据库，
// 迁移成功后删除旧文件（幂等：文件已删除则跳过）。遗留全局文件归 admin(userId=1)。
async function migrateRadioFavoritesFromFiles() {
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    const files = fs.readdirSync(dataDir).filter((f) => /^radio-favorites(?:-(\d+))?\.json$/.test(f));
    if (!files.length) return 0;
    let total = 0;
    for (const f of files) {
      const m = f.match(/^radio-favorites(?:-(\d+))?\.json$/);
      const userId = m && m[1] ? parseInt(m[1], 10) : 1;
      const fp = path.join(dataDir, f);
      let list;
      try { list = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]'); } catch { continue; }
      if (!Array.isArray(list)) continue;
      await setRadioFavoritesDB(userId, list, { merge: true });
      total += list.length;
      try { fs.unlinkSync(fp); } catch { /* 删除失败不影响数据 */ }
    }
    if (total) logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Radio favorites migrated to database', { count: total });
    return total;
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Migrate radio favorites failed', { error: logger.formatError(e) });
    return 0;
  }
}

// 首次启动：把按用户隔离的电台收藏合并为全站共享（user_id=0）。
// 幂等：每次启动重读全表，按 (url/name/id) 去重写回 user_id=0；已共享的数据不会损坏。
// 这样“我的电台”对所有人可见、可共同编辑，且不丢失既有收藏。
async function migrateRadioFavoritesToShared() {
  try {
    const rows = await radioAll('SELECT favorite_data, created_at FROM radio_favorites ORDER BY id ASC');
    if (!rows || !rows.length) return 0;
    const seen = new Set();
    const toInsert = [];
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.favorite_data); } catch { continue; }
      const key = String(data.url || data.name || data.id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      toInsert.push({ data: row.favorite_data, createdAt: row.created_at || Date.now() });
    }
    if (!toInsert.length) return 0;
    // 仅在有内容可写回时才清空，避免极端情况下误删
    await radioRun('DELETE FROM radio_favorites');
    for (let i = 0; i < toInsert.length; i++) {
      await radioRun(
        'INSERT INTO radio_favorites (user_id, station_id, favorite_data, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
        [0, null, toInsert[i].data, i, toInsert[i].createdAt]
      );
    }
    logger.info(DB_MODULE, SYSTEM_REQ_ID, 'Radio favorites merged to shared', { count: toInsert.length });
    return toInsert.length;
  } catch (e) {
    logger.error(DB_MODULE, SYSTEM_REQ_ID, 'Migrate radio favorites to shared failed', { error: logger.formatError(e) });
    return 0;
  }
}

// ==================== 本地曲库优先播放（插件音源匹配 NAS 本地库）====================
// 仅对插件（网络）音源生效：播放插件歌曲时，用其 歌名+歌手（可选时长）在本地库做精确匹配，
// 命中则改播本地音频文件；未命中/超时/缺字段/异常 → 调用方回退插件网络源（绝不中断播放）。
const LOCAL_PRIORITY_MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, '..', 'music');

function localPriorityRelToFull(relPath) {
  if (!relPath) return null;
  const base = String(LOCAL_PRIORITY_MUSIC_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
  return `${base}/${String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

// 歌手文本 → 归一化的歌手集合：拆分多歌手拼接符（/ 、 , ， & ; ;|feat. ft. with），去空白、转小写。
// 不同插件对同一首歌的歌手写法差异很大（拼接符/featuring/多歌手顺序），用集合交集判定是否同一歌手。
function localPriorityExtractArtists(artistRaw) {
  let raw = artistRaw;
  if (Array.isArray(raw)) raw = raw.join('/');
  const text = String(raw || '').toLowerCase();
  if (!text.trim()) return [];
  return text
    .split(/[\/、,，;；&]|feat\.|ft\.|with\b/)
    .map((s) => s.replace(/\s+/g, '').trim())
    .filter(Boolean);
}

// 按 歌名+歌手 匹配本地库：歌名用 LOWER(TRIM) 精确比对（SQL 不做模糊 LIKE），
// 歌手做集合交集（不同插件多歌手拼接符/featuring 写法不一致，任一歌手一致即算匹配）。
// 不使用时长参与匹配。结果打印 debug 日志（播放路径另在 matchLocalLibraryForPlay 打 info）。
function findLocalSongByMeta(title, artist) {
  return new Promise((resolve) => {
    if (!title) return resolve(null);
    const wantArtists = localPriorityExtractArtists(artist);
    db.all(
      `SELECT id, title, artist, rel_path, is_strm, strm_file_path, duration
       FROM local_songs
       WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))
         AND (is_strm IS NULL OR is_strm = 0)
       LIMIT 20`,
      [String(title).trim()],
      (err, rows) => {
        if (err) {
          logger.warn(DB_MODULE, SYSTEM_REQ_ID, '本地曲库匹配查询失败', { error: err.message, title });
          return resolve(null);
        }
        if (!rows || !rows.length) {
          logger.trace(DB_MODULE, SYSTEM_REQ_ID, '本地匹配未命中：本地库无同名歌曲', { title, artist });
          return resolve(null);
        }
        // 歌名候选中找歌手交集（任一歌手一致即算匹配）
        const hit = rows.find((row) => {
          const localArtists = localPriorityExtractArtists(row.artist);
          return wantArtists.length > 0 && wantArtists.some((a) => localArtists.includes(a));
        });
        if (hit) {
          logger.debug(DB_MODULE, SYSTEM_REQ_ID, '本地匹配命中（歌名+歌手）',
            { title, artist, localId: hit.id, localArtist: hit.artist, relPath: hit.rel_path });
          resolve(hit);
        } else {
          logger.trace(DB_MODULE, SYSTEM_REQ_ID, '本地匹配未命中：歌手不一致',
            { title, artist, localCandidates: rows.map((r) => r.artist) });
          resolve(null);
        }
      }
    );
  });
}

function localSongStreamParts(row) {
  if (!row) return null;
  const isStrm = row.is_strm === 1 || row.is_strm === true || row.is_strm === '1';
  const filePath = isStrm && row.strm_file_path
    ? String(row.strm_file_path).replace(/\\/g, '/')
    : localPriorityRelToFull(row.rel_path);
  if (!filePath) return null;
  return {
    id: row.id,
    filePath,
    url: `/api/local-files/stream?path=${encodeURIComponent(filePath)}`,
    duration: row.duration
  };
}

// 对外主入口：给定插件歌曲的 歌名/歌手，返回本地命中信息（含可直连的流地址）。
// 超时保护（2s）：超时 / 文件不存在 / 任何异常 → 返回 null，调用方回退网络源。
// 命中 / 未命中均打印 info 日志，便于排查「为什么没匹配上」。
async function matchLocalLibraryForPlay(title, artist) {
  let row = null;
  try {
    row = await Promise.race([
      findLocalSongByMeta(title, artist),
      new Promise((res) => setTimeout(() => res(null), 2000))
    ]);
  } catch { row = null; }
  if (!row) {
    logger.debug(DB_MODULE, SYSTEM_REQ_ID, '本地曲库匹配未命中，回退插件网络源', { title, artist });
    return null;
  }
  const parts = localSongStreamParts(row);
  if (!parts) return null;
  // 文件必须真实存在，否则回退网络源（避免给出死链）
  try {
    if (!fs.existsSync(parts.filePath)) {
      logger.debug(DB_MODULE, SYSTEM_REQ_ID, '本地曲库匹配命中但文件不存在，回退网络源', { title, artist, file: parts.filePath });
      return null;
    }
  } catch { return null; }
  logger.debug(DB_MODULE, SYSTEM_REQ_ID, '本地曲库匹配命中，改播本地文件',
    { title, artist, localId: row.id, localArtist: row.artist, file: parts.filePath });
  return parts;
}

module.exports = {
  stripPlayUrlFromMusic,
  refreshPlaylistSongsCache,
  refreshPlaylistListsCache,
  setPlaylistSource,
  // 电台（数据库驱动，取代插件平铺数组）
  getRadioStationsDB,
  getRadioStationByIdDB,
  createRadioStation,
  updateRadioStation,
  deleteRadioStation,
  clearRadioStationsDB,
  reorderRadioStationsGroup,
  migrateRadioStationsFromPlugin,
  getRadioFavoritesDB,
  setRadioFavoritesDB,
  migrateRadioFavoritesFromFiles,

  // 歌曲管理
  saveSong,
  cacheNetworkSong,
  saveNetworkSongLyric,
  loadNetworkSongLyric,
  getSongById,
  getSongByMusicId,
  getSongByMusicIdAny,
  getNetworkSongByVirtualId,
  findSongByTitleArtist,
  touchNetworkSong,
  cleanupNetworkSongCache,
  toStoredId,
  songIdMatch,

  // 最近播放
  addPlayHistory,
  getRecentPlays,
  clearPlayHistory,
  deletePlayHistory,

  // 收藏
  addFavorite,
  getFavorites,
  isFavorite,
  removeFavorite,
  clearFavorites,

  // 歌单
  createPlaylist,
  getPlaylists,
  getPlaylist,
  getPlaylistById,
  updatePlaylist,
  deletePlaylist,
  updatePlaylistOrder,
  addSongToPlaylist,
  removeSongFromPlaylist,
  clearPlaylistSongs,
  getPlaylistSongs,

  // 插件配置
  getPluginConfigs,
  getPluginConfig,
  savePluginConfig,
  deletePluginConfig,

  // 定时更新
  getAutoUpdateConfig,
  updateAutoUpdateConfig,

  // 下载
  addDownload,
  updateDownloadStatus,
  getDownloads,
  getDownload,
  deleteDownload,
  cleanupDownloads,

  // 本地曲库优先播放（插件音源匹配 NAS 本地库）
  findLocalSongByMeta,
  localSongStreamParts,
  matchLocalLibraryForPlay,

  // 播放队列
  getPlayQueue,
  addToPlayQueue,
  removeFromPlayQueue,
  clearPlayQueue,
  savePlayQueue,

  // 播放器状态
  getPlayerState,
  savePlayerState,

  // 用户系统
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  updateUser,
  updateUserPassword,
  deleteUser,
  resetDatabase,
  getUserPermissions,
  updateUserPermissions,

  // 用户数据隔离 - 收藏
  addUserFavorite,
  getUserFavorites,
  isUserFavorite,
  filterUserFavorites,
  getSongCandidatesByRawId,
  fixPlayHistoryRow,
  removeUserFavorite,

  // 用户数据隔离 - 评分（OpenSubsonic setRating/getRating）
  setUserRating,
  getUserRating,
  getUserRatings,

  // 用户数据隔离 - 播放历史
  addUserPlayHistory,
  getUserPlayHistory,
  getUserPlayHistoryTotal,
  clearUserPlayHistory,
  clearAllUsersPlayHistory,
  clearAllUsersPlayQueue,
  savePlaybackPosition,
  setPlaybackPositionBySongId,

  // 用户数据隔离 - 播放队列
  getUserPlayQueue,
  addToUserPlayQueue,
  removeFromUserPlayQueue,
  clearUserPlayQueue,
  saveUserPlayQueue,

  // 用户数据隔离 - 播放器状态
  getUserPlayerState,
  saveUserPlayerState,

  // 用户隔离歌单
  createUserPlaylist,
  getUserPlaylists,
  getUserPlaylist,
  updateUserPlaylist,
  touchUserPlaylist,
  deleteUserPlaylist,
  addSongToUserPlaylist,
  removeSongFromUserPlaylist,
  clearUserPlaylistSongs,
  getUserPlaylistSongs,

  // 用户订阅榜单
  getUserSubscribedToplists,
  getUserSubscribedToplistById,
  addUserSubscribedToplist,
  removeUserSubscribedToplist,
  removeUserSubscribedToplistById,
  isUserSubscribedToplist,
  updateSubscribedToplistConfig,
  updateSubscribedToplistStats,
  getEnabledSubscribedToplists,
  getEnabledSubscribedToplistsByUser,

  // 订阅榜单歌曲管理
  saveSubscribedToplistSongs,
  getSubscribedToplistSongs,
  clearSubscribedToplistSongs,

  // 系统设置
  getSetting,
  saveSetting,
  migrateSystemSettingsToConfig,
  migrateLocalMetaToSettings,
  clearSongsTableData,
  getNetworkSongCount,
  clearNetworkSongCache,


  // 定时任务配置
  getSchedulerTaskConfig,
  saveSchedulerTaskConfig,
  updateSchedulerTaskNotify,
  updateSchedulerTaskRunTime,

  // 工具
  bcrypt,

  // 数据库实例（谨慎使用）
  db
};
