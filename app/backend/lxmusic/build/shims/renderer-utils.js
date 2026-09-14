// 落雪 @renderer/utils 与 renderer/utils/index 的工具函数替代实现（去掉 window/document 依赖）
import crypto from 'crypto';
import he from 'he';

/** 解码 HTML 实体（原实现用 window.DOMParser） */
export const decodeName = (str = '') => {
  if (str == null) return '';
  try { return he.decode(String(str)); } catch { return String(str); }
};

const numFix = (n) => (n < 10 ? `0${n}` : `${n}`);

export const formatPlayTime = (time) => {
  const m = Math.trunc((time || 0) / 60);
  const s = Math.trunc((time || 0) % 60);
  return m === 0 && s === 0 ? '--/--' : numFix(m) + ':' + numFix(s);
};

export const formatPlayTime2 = (time) => {
  const m = Math.trunc((time || 0) / 60);
  const s = Math.trunc((time || 0) % 60);
  return numFix(m) + ':' + numFix(s);
};

export const sizeFormate = (size) => {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const number = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, Math.floor(number))).toFixed(2)} ${units[number]}`;
};

const toDateObj = (date) => {
  if (typeof date === 'string') {
    if (/^\d+$/.test(date)) date = parseInt(date, 10);
    else {
      const d = new Date(date.replace(/-/g, '/'));
      return isNaN(d.getTime()) ? '' : d;
    }
  }
  if (typeof date === 'number') {
    if (date < 1e12) date *= 1000;
    return new Date(date);
  }
  if (date instanceof Date) return date;
  return '';
};

export const dateFormat = (_date, format = 'Y-M-D h:m:s') => {
  const date = toDateObj(_date);
  if (!date) return '';
  return format
    .replace('Y', date.getFullYear().toString())
    .replace('M', numFix(date.getMonth() + 1))
    .replace('D', numFix(date.getDate()))
    .replace('h', numFix(date.getHours()))
    .replace('m', numFix(date.getMinutes()))
    .replace('s', numFix(date.getSeconds()));
};

export const dateFormat2 = (time) => {
  const differ = Math.trunc((Date.now() - time) / 1000);
  if (differ < 60) return `${differ}秒前`;
  if (differ < 3600) return `${Math.trunc(differ / 60)}分钟前`;
  if (differ < 86400) return `${Math.trunc(differ / 3600)}小时前`;
  return dateFormat(time);
};

export const formatPlayCount = (num) => {
  if (num > 100000000) return `${Math.trunc(num / 10000000) / 10}亿`;
  if (num > 10000) return `${Math.trunc(num / 1000) / 10}万`;
  return String(num);
};

export const toMD5 = (str) => crypto.createHash('md5').update(str).digest('hex');

export const isUrl = (path) => /https?:\/\//.test(path);

export const deduplicationList = (list = []) => {
  const ids = new Set();
  return list.filter((s) => {
    if (ids.has(s.id)) return false;
    ids.add(s.id);
    return true;
  });
};

// 简繁转换：后端不启用，原样返回
export const langS2T = async (str) => str;

export const getFontSizeWithScreen = () => 16;
