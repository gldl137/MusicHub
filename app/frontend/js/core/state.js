// ==================== 状态管理 ====================

// 播放器状态
window.currentMusic = null;
window.isPlaying = false;
window.currentPage = '';
window.currentPlaylist = [];
window.currentIndex = 0;

// 插件相关状态
window.installedPlugins = [];
window.topListPlugins = [];  // 支持榜单的插件
window.recommendPlugins = [];  // 支持热门歌单的插件
window.currentTopListPlugin = null;  // 当前选中的榜单插件
window.currentRecommendPlugin = null;  // 当前选中的热门歌单插件

// 页面状态
window.currentTopListTitle = null;  // 当前查看的榜单标题（用于详情页）
window.currentSearchQuery = '';  // 当前搜索关键词（用于保持搜索框文字）
window.currentSearchType = 'music';  // 当前搜索类型
window.currentRecommendSearchQuery = '';  // 热门歌单当前搜索关键词
window.currentSheetTitle = null;  // 当前查看的歌单标题（用于详情页）

// 热门歌单状态
window.currentRecommendTag = null;  // 当前选中的热门歌单标签
window.recommendTags = [];  // 热门歌单标签列表
window.recommendTagsPinned = [];  // 热门歌单固定标签列表
window.recommendSheetsPage = 1;  // 当前页码
window.recommendSheetsData = [];  // 已加载的歌单数据
window.isRecommendSheetsEnd = false;  // 是否已加载完所有数据
window.isRecommendSheetsLoading = false;  // 是否正在加载
window.recommendSheetsObserver = null;  // IntersectionObserver 实例
window.hasTriggeredFirst = false;  // 首次触发标志

// 当前页面显示的歌曲列表（用于播放上下文）
window.currentPageMusicList = [];

// 音质配置
const QUALITY_CONFIG = {
    'low': { name: '低音质', abbr: '低' },
    'standard': { name: '标准音质', abbr: '标' },
    'high': { name: '高音质', abbr: '高' },
    'super': { name: '超高音质', abbr: '超' },
    'lossless': { name: '无损', abbr: '无' }
};

// 获取当前页面歌曲列表
function getCurrentPageMusicList() {
    return window.currentPageMusicList;
}

// 设置当前页面歌曲列表
function setCurrentPageMusicList(list) {
    window.currentPageMusicList = list || [];
}

// ==================== 收藏状态管理 ====================

// 收藏状态缓存（用于快速查询）
let favoritesCache = new Set();
let favoritesNegativeCache = new Set();
let favoritesCacheInitialized = false;

// 初始化收藏缓存
async function initFavoritesCache() {
    if (favoritesCacheInitialized) return;

    try {
        // 使用用户隔离的API
        const result = await API.myFavorites.getAll();

        if (result.success && result.data) {
            favoritesCache.clear();
            favoritesNegativeCache.clear();
            result.data.forEach(song => {
                const key = song.platform ? `${song.platform}:${song.id}` : song.id;
                favoritesCache.add(key);
            });
            favoritesCacheInitialized = true;
        }
    } catch (error) {
        console.error('初始化收藏缓存失败', error);
    }
}

// 检查歌曲是否已收藏（先查缓存，缓存未命中则查数据库）
async function isSongFavorited(musicId, platform) {
    // 先检查缓存
    const key = platform ? `${platform}:${musicId}` : musicId;
    if (favoritesCache.has(key)) {
        return true;
    }

    // 负缓存命中：已查过且未收藏，直接返回，不再打接口
    if (favoritesNegativeCache.has(key)) {
        return false;
    }
    // 缓存未命中，查询数据库 - 使用用户隔离的API
    try {
        const result = await API.myFavorites.check(musicId, platform);

        if (result.success && result.data && result.data.isFavorite) {
            favoritesCache.add(key);
            return true;
        }
        favoritesNegativeCache.add(key);
        return false;
    } catch (error) {
        console.error('检查收藏状态失败', error);
        return false;
    }
}

// 同步检查歌曲是否已收藏（仅检查缓存，用于渲染时）
function isSongFavoritedSync(musicId, platform) {
    const key = platform ? `${platform}:${musicId}` : musicId;
    return favoritesCache.has(key);
}

// 添加歌曲到缓存
function addToFavoritesCache(musicId, platform) {
    const key = platform ? `${platform}:${musicId}` : musicId;
    favoritesCache.add(key);
    favoritesNegativeCache.delete(key);
}

// 从缓存中移除歌曲
function removeFromFavoritesCache(musicId, platform) {
    const key = platform ? `${platform}:${musicId}` : musicId;
    favoritesCache.delete(key);
    favoritesNegativeCache.delete(key);
}

// 批量检查收藏状态并写入正负缓存（歌单/列表场景，避免逐首打接口）
async function checkBatchFavorites(songs) {
    if (!Array.isArray(songs) || !songs.length) return;
    const items = songs
        .map((s) => ({ musicId: s.id != null ? String(s.id) : s.musicId, plugin: s.plugin || s.platform }))
        .filter((it) => it.musicId && it.plugin);
    if (!items.length) return;
    try {
        const result = await API.myFavorites.checkBatch(items);
        if (result && result.success && result.data) {
            items.forEach((it) => {
                const key = `${it.plugin}:${it.musicId}`;
                if (result.data[key]) favoritesCache.add(key);
                else favoritesNegativeCache.add(key);
            });
        }
    } catch (error) {
        console.error('批量检查收藏状态失败', error);
    }
}
window.checkBatchFavorites = checkBatchFavorites;

// 切换歌曲收藏状态（调用 API）
async function toggleFavoriteSong(song) {
    if (!song || !song.id) return false;

    // 优先使用 plugin 字段（插件文件名），与后端数据库一致
    const platform = song.plugin || song.platform;

    const isFav = await isSongFavorited(song.id, platform);

    if (isFav) {
        // 取消收藏 - 使用用户隔离的API
        try {
            console.log('[INFO] [] Deleting favorite:', { id: song.id, platform });

            const result = await API.myFavorites.remove(song.id, platform);

            console.log('[INFO] [] Delete result:', result);

            if (result.success) {
                removeFromFavoritesCache(song.id, platform);
                emitFavoriteChange(song.id, platform, false, song);
                return false;
            }
        } catch (error) {
            console.error('取消收藏失败:', error);
        }
    } else {
        // 添加收藏 - 使用用户隔离的API
        try {
            // 获取当前插件/来源信息（统一取名：落雪 lx:xx 等非插件来源也能得到可读名字）
            const pluginFileName = platform || window.currentPluginFileName || window.currentPluginName;
            const plugin = window.installedPlugins?.find(p => p.name === pluginFileName);
            const source = (typeof getMusicSourceText === 'function')
                ? (getMusicSourceText(pluginFileName) || '-')
                : (plugin?.platform || '-');

            // 构建完整的音乐对象，确保包含所有必要字段
            const musicData = {
                ...song,
                id: song.id,
                title: song.title,
                artist: song.artist,
                album: song.album,
                duration: song.duration,
                artwork: song.artwork || song.coverImg || song.cover || song.pic,
                platform: platform,
                plugin: platform,
                source: source
            };

            const result = await API.myFavorites.add(musicData, platform);

            if (result.success) {
                addToFavoritesCache(song.id, platform);
                emitFavoriteChange(song.id, platform, true, song);
                return true;
            }
        } catch (error) {
            console.error('添加收藏失败:', error);
        }
    }
    return isFav;
}

// 收藏状态变更监听器列表
const favoriteChangeListeners = [];

// 订阅收藏状态变化
function onFavoriteChange(callback) {
    favoriteChangeListeners.push(callback);
}

// 取消订阅收藏状态变化
function offFavoriteChange(callback) {
    const index = favoriteChangeListeners.indexOf(callback);
    if (index > -1) {
        favoriteChangeListeners.splice(index, 1);
    }
}

// 触发收藏状态变更事件
function emitFavoriteChange(musicId, platform, isFavorited, song) {
    favoriteChangeListeners.forEach(callback => {
        try {
            callback({ musicId, platform, isFavorited, song });
        } catch (e) {
            console.error('收藏状态变更监听器执行失败:', e);
        }
    });
}

// 导出到全局作用域
window.getCurrentPageMusicList = getCurrentPageMusicList;
window.setCurrentPageMusicList = setCurrentPageMusicList;
window.QUALITY_CONFIG = QUALITY_CONFIG;
window.initFavoritesCache = initFavoritesCache;
window.isSongFavorited = isSongFavorited;
window.isSongFavoritedSync = isSongFavoritedSync;
window.addToFavoritesCache = addToFavoritesCache;
window.removeFromFavoritesCache = removeFromFavoritesCache;
window.toggleFavoriteSong = toggleFavoriteSong;
window.onFavoriteChange = onFavoriteChange;
window.offFavoriteChange = offFavoriteChange;
window.emitFavoriteChange = emitFavoriteChange;
