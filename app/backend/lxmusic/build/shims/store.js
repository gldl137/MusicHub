// 落雪 @renderer/store 的最小替身。
// 一期（榜单/歌单浏览）用不到自定义源的播放解析，这里提供空实现让模块可加载；
// 二期接入落雪自定义源时，再让 userApi.apis 指向真实运行时。
export const apiSource = { value: '' };

export const userApi = { apis: {} };

export const proxy = { enable: false, host: '', port: '', envProxy: null };

export const qualityList = ['128k', '320k', 'flac', 'flac24bit'];

export default { apiSource, userApi, proxy, qualityList };
