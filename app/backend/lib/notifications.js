'use strict';

const axios = require('axios');
const logger = require('../core/logger');
const { getSetting } = require('../database');
const { loadNotificationConfig } = require('./config');
const wecomApp = require('../wecom-app');

// ==================== 企业微信通知模块 ====================

/**
 * 发送企业微信机器人消息
 * @param {Object} options - 消息选项
 * @param {string} options.msgtype - 消息类型: text, markdown, news
 * @param {string} [options.content] - 文本/Markdown内容 (text/markdown类型必填)
 * @param {Array} [options.articles] - 图文消息数组 (news类型必填)
 * @param {string} [options.template_card] - 模板卡片 (template_card类型必填)
 * @param {string} [url] - 可选的Webhook地址，不传则使用配置中的地址
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendWecomNotification(options, url = null) {
  try {
    // 检查通知是否启用
    const notificationEnabled = await getSetting('notification_enabled', false);
    if (!notificationEnabled) {
      return { success: false, error: 'Notification is disabled' };
    }

    // 获取Webhook地址
    // 兼容性处理：Webhook 地址正常存于 settings.wecom_url，但部分前端/旧数据会把它误存到
    // config.notification.url（该字段本义是通知卡片跳转链接）。为保证无论填哪个字段通知都能发出，
    // 按 显式传入的 url > settings.wecom_url > config.notification.url 顺序解析。
    const notificationConfig = loadNotificationConfig();
    const webhookUrl = url || (await getSetting('wecom_url', '')) || (notificationConfig && notificationConfig.url) || '';
    if (!webhookUrl) {
      return { success: false, error: 'Webhook URL not configured' };
    }

    // 构建消息体
    const message = {
      msgtype: options.msgtype || 'text',
    };

    switch (options.msgtype) {
      case 'markdown':
        message.markdown = { content: options.content };
        break;
      case 'news':
        // 官方格式: { "news": { "articles": [{ "title": "...", "description": "...", "url": "...", "picurl": "..." }] } }
        message.news = { articles: options.articles };
        break;
      case 'template_card':
        // 模板卡片消息
        message.template_card = options.template_card;
        break;
      case 'text':
      default:
        message.text = {
          content: options.content,
          mentioned_list: options.mentioned_list || [],
          mentioned_mobile_list: options.mentioned_mobile_list || []
        };
        break;
    }

    // 打印发送的消息体（调试用）
    if (options.msgtype === 'news') {
      logger.info('NOTIFY', 'system', 'Sending news notification', {
        articleCount: message.news.articles.length,
        firstArticle: message.news.articles[0]
      });
    }

    // 安全校验：Webhook 地址仅允许 http/https，拒绝 file:// 等危险协议
    try {
      const wh = new URL(webhookUrl);
      if (wh.protocol !== 'http:' && wh.protocol !== 'https:') {
        return { success: false, error: 'Invalid webhook URL scheme' };
      }
    } catch {
      return { success: false, error: 'Invalid webhook URL' };
    }

    // 发送请求
    const response = await axios.post(webhookUrl, message, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (response.data && response.data.errcode === 0) {
      logger.info('NOTIFY', 'system', 'Wecom notification sent successfully');
      return { success: true };
    } else {
      const errorMsg = response.data?.errmsg || 'Unknown error';
      logger.error('NOTIFY', 'system', 'Wecom notification failed', { error: errorMsg });
      return { success: false, error: errorMsg };
    }
  } catch (error) {
    logger.error('NOTIFY', 'system', 'Failed to send wecom notification', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * 将消息广播到企业微信自建应用（独立于群机器人开关：仅当应用 enabled 时发送）。
 * 应用未启用或配置不完整时静默忽略，不影响群机器人通知。
 * @param {Object} message - { msgtype:'text'|'markdown'|'news', content?/articles? }
 */
async function broadcastToWecomApp(message) {
  if (!wecomApp || typeof wecomApp.sendAppMessage !== 'function') return;
  try {
    // 转换为企业微信应用消息结构（text/markdown/news 的包裹字段不同）
    let appMessage;
    switch (message.msgtype) {
      case 'text':
        appMessage = { msgtype: 'text', text: { content: message.content } };
        break;
      case 'markdown':
        appMessage = { msgtype: 'markdown', markdown: { content: message.content } };
        break;
      case 'news':
        appMessage = { msgtype: 'news', news: { articles: message.articles } };
        break;
      default:
        appMessage = message;
    }
    await wecomApp.sendAppMessage(appMessage);
  } catch (e) {
    logger.warn('NOTIFY', 'system', 'WeCom app broadcast skipped', { error: e.message });
  }
}

async function sendTextNotification(content, url = null) {
  const botResult = await sendWecomNotification({ msgtype: 'text', content }, url);
  // 广播到企业微信应用（独立开关）
  await broadcastToWecomApp({ msgtype: 'text', content });
  return botResult;
}

async function sendMarkdownNotification(content, url = null) {
  const botResult = await sendWecomNotification({ msgtype: 'markdown', content }, url);
  // 广播到企业微信应用（独立开关）
  await broadcastToWecomApp({ msgtype: 'markdown', content });
  return botResult;
}

async function sendNewsNotification(articles, url = null) {
  const botResult = await sendWecomNotification({ msgtype: 'news', articles }, url);
  // 广播到企业微信应用（独立开关）
  await broadcastToWecomApp({ msgtype: 'news', articles });
  return botResult;
}

async function sendTemplateCardNotification(template_card, url = null) {
  return sendWecomNotification({ msgtype: 'template_card', template_card }, url);
}

module.exports = {
  sendWecomNotification,
  broadcastToWecomApp,
  sendTextNotification,
  sendMarkdownNotification,
  sendNewsNotification,
  sendTemplateCardNotification
};
