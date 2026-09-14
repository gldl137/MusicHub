'use strict';

// ==================== OpenSubsonic (Subsonic REST) API 路由 ====================
// 对外提供 /rest/<method> 接口，媒体库数据源为本地音乐库（/app/music）。

const ctx = require('../lib/context');
const rest = require('../rest/opensubsonic');
const localMusic = require('./local-music');

module.exports = function (app) {
  // 注意：这里【不做】启动扫描。本地音乐库由 local-music 模块开机时从数据库快速加载
  // （warm load，无文件变化时既不扫描也不联网）；缺失数据只会在「文件首次入库 / 手动
  // 点击扫描 / 播放时」才补全。首个 OpenSubsonic/Web 请求按需 ensureScanned 懒加载。
  rest.register(app, ctx);
};
