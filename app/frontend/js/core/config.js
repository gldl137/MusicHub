// ==================== 配置和常量 ====================

// API 基础 URL
// 本地开发: http://localhost:8000
// Docker部署: window.location.origin (同域名)
const API_BASE = window.location.protocol === 'file:'
    ? 'http://localhost:8000'  // 本地直接打开HTML文件
    : window.location.origin;   // 通过HTTP服务器访问

// 页面标题映射
const pageTitles = {
    // MF 专区页面标题加「MF」前缀，与 LX 专区（'LX 排行榜' / 'LX 热门歌单'）保持一致的命名
    'toplist': 'MF 排行榜',
    'recommend': 'MF 热门歌单',
    'download': '下载管理',
    'local': '本地音乐',
    'recent': '最近播放',
    'plugins': '插件管理',
    'settings': '系统设置',
    'subscribed-toplist': '下载订阅',
    'my-playlists': '歌单',
    'favorites': '我的收藏',
    'radio': '电台',
    'lx-toplist': 'LX 排行榜',
    'lx-recommend': 'LX 热门歌单'
};

// 每页显示数量
const ITEMS_PER_PAGE = 20;

// 导出配置
window.API_BASE = API_BASE;
window.pageTitles = pageTitles;
window.ITEMS_PER_PAGE = ITEMS_PER_PAGE;
