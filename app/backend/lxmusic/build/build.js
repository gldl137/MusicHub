/* eslint-disable no-console */
'use strict';

/**
 * 洛雪（LX）内置音源 SDK 打包脚本
 * ================================================================
 * 把 lx-music-desktop 源码里的 musicSdk（ESM + 无扩展名导入 + @renderer/@common 别名）
 * 打包成单个 CJS 文件，供 MusicHub 后端 require。
 *
 * 一期只打包「各平台排行榜(leaderboard) + 歌单(songList)」，刻意避开
 * 歌词(lyric)/评论(comment)/播放解析(api-source) 等重依赖。
 *
 * 用法： node app/backend/lxmusic/build/build.js
 * 产物： app/backend/lxmusic/musicSdk.cjs
 */

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const LXT_SRC = process.env.LX_SRC_DIR
  ? path.resolve(process.env.LX_SRC_DIR)
  : path.resolve(__dirname, '..', '..', '..', '..', '源码', 'lx-music-desktop-master', 'src');

const UTILS_ROOT = path.join(LXT_SRC, 'renderer', 'utils');
const MUSICSDK_DIR = path.join(UTILS_ROOT, 'musicSdk');
const COMMON_ROOT = path.join(LXT_SRC, 'common');
const SHIMS = path.join(__dirname, 'shims');
const OUT = path.resolve(__dirname, '..', 'musicSdk.cjs');

if (!fs.existsSync(MUSICSDK_DIR)) {
  console.error('[lx-build] 未找到落雪源码目录：', MUSICSDK_DIR);
  console.error('           可通过环境变量 LX_SRC_DIR 指定 lx-music-desktop 的 src 目录');
  process.exit(1);
}

/** 依次尝试 base / base.js / base.ts / base/index.js / base/index.ts */
function resolveFile(base) {
  const candidates = [
    base,
    base + '.js',
    base + '.ts',
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

const aliasPlugin = {
  name: 'lx-alias',
  setup(build) {
    // @renderer/store → 替身
    build.onResolve({ filter: /^@renderer\/store$/ }, () => ({ path: path.join(SHIMS, 'store.js') }));

    // @renderer/utils（精确）→ 工具替身
    build.onResolve({ filter: /^@renderer\/utils$/ }, () => ({ path: path.join(SHIMS, 'renderer-utils.js') }));

    // @renderer/utils/xxx → 源码真实文件（如 musicSdk/kg/vendors/infSign.min）
    build.onResolve({ filter: /^@renderer\/utils\// }, (args) => {
      const rest = args.path.replace(/^@renderer\/utils\//, '');
      const p = resolveFile(path.join(UTILS_ROOT, rest));
      return p ? { path: p } : null;
    });

    // @common/ipcNames、@common/rendererIpc → 替身
    build.onResolve({ filter: /^@common\/ipcNames$/ }, () => ({ path: path.join(SHIMS, 'ipc-names.js') }));
    build.onResolve({ filter: /^@common\/rendererIpc$/ }, () => ({ path: path.join(SHIMS, 'renderer-ipc.js') }));

    // 其它 @common/xxx → 尽量映射到源码真实文件
    build.onResolve({ filter: /^@common\// }, (args) => {
      const rest = args.path.replace(/^@common\//, '');
      const p = resolveFile(path.join(COMMON_ROOT, rest));
      return p ? { path: p } : null;
    });

    // 相对路径的 request（../../request、../../../request）→ axios 替身
    build.onResolve({ filter: /(^|\/)request$/ }, () => ({ path: path.join(SHIMS, 'request.js') }));

    // 相对路径的 renderer/utils/index（../../index）→ 工具替身
    build.onResolve({ filter: /^(\.\.\/)+index$/ }, () => ({ path: path.join(SHIMS, 'renderer-utils.js') }));
  },
};

const ENTRY = `
export { default as kwLeaderboard } from './kw/leaderboard'
export { default as kwSongList } from './kw/songList'
export { default as kwMusicSearch } from './kw/musicSearch'
export { default as kgLeaderboard } from './kg/leaderboard'
export { default as kgSongList } from './kg/songList'
export { default as kgMusicSearch } from './kg/musicSearch'
export { default as txLeaderboard } from './tx/leaderboard'
export { default as txSongList } from './tx/songList'
export { default as txMusicSearch } from './tx/musicSearch'
export { default as wyLeaderboard } from './wy/leaderboard'
export { default as wySongList } from './wy/songList'
export { default as wyMusicSearch } from './wy/musicSearch'
export { default as mgLeaderboard } from './mg/leaderboard'
export { default as mgSongList } from './mg/songList'
export { default as mgMusicSearch } from './mg/musicSearch'
`;

async function main() {
  const result = await esbuild.build({
    stdin: {
      contents: ENTRY,
      resolveDir: MUSICSDK_DIR,
      sourcefile: 'lx-entry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node16',
    outfile: OUT,
    plugins: [aliasPlugin],
    // 运行期由 MusicHub 后端提供（node_modules 已具备）
    external: ['axios', 'crypto-js', 'he', 'cheerio', 'needle', 'tunnel'],
    logLevel: 'info',
    metafile: false,
  });

  console.log('[lx-build] 打包完成 →', OUT);
  return result;
}

main().catch((err) => {
  console.error('[lx-build] 打包失败：', err);
  process.exit(1);
});
