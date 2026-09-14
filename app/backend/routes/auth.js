'use strict';

const logger = require('../core/logger');
const frontendLogger = require('../core/frontend-logger');
const {
  getUserByUsername, getUserById, getUserPermissions, getAllUsers,
  createUser, updateUser, updateUserPassword, deleteUser, resetDatabase, bcrypt,
  updateUserPermissions
} = require('../database');
const { generateToken, authMiddleware, adminMiddleware, createReqId, SESSION_COOKIE, SESSION_MAX_AGE } = require('../lib/middleware');
const { ok, serverError } = require('../lib/respond');
const plaintextCache = require('../rest/plaintext-cache');

/**
 * 注册用户认证 / 用户管理路由
 * @param {import('express').Express} app
 */
function registerAuthRoutes(app) {
  // ==================== 用户认证 API ====================
  // 用户登录
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const reqId = createReqId();

    if (!username || !password) {
      return res.json({ success: false, error: '用户名和密码不能为空' });
    }

    try {
      const user = await getUserByUsername(username);
      if (!user) {
        logger.warn('AUTH', reqId, 'Login failed: user not found', { username });
        frontendLogger.warn('AUTH', 'Login failed', { username, reason: '用户不存在' });
        return res.json({ success: false, error: '用户名或密码错误' });
      }

      if (!user.is_active) {
        logger.warn('AUTH', reqId, 'Login failed: user inactive', { username });
        frontendLogger.warn('AUTH', 'Login failed', { username, reason: '账户已禁用' });
        return res.json({ success: false, error: '账户已禁用' });
      }

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        logger.warn('AUTH', reqId, 'Login failed: invalid password', { username });
        frontendLogger.warn('AUTH', 'Login failed', { username, reason: '密码错误' });
        return res.json({ success: false, error: '用户名或密码错误' });
      }

      // 播种明文缓存：供 OpenSubsonic 的 t+s token 鉴权使用
      plaintextCache.set(username, password);

      const token = generateToken(user);
      const permissions = await getUserPermissions(user.id);

      // 下发 HttpOnly 会话 Cookie，供同源的 <audio>/<img>/hls.js 等无法携带
      // Authorization 头的媒体/代理请求自动鉴权。HTTPS 部署时建议设置环境变量
      // COOKIE_SECURE=true 开启 Secure 标记。
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: SESSION_MAX_AGE,
        path: '/'
      });

      logger.info('AUTH', reqId, 'Login successful', { username, role: user.role });
      frontendLogger.info('AUTH', 'User logged in', { username, role: user.role });
      res.json({
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            remark: user.remark
          },
          permissions
        }
      });
    } catch (err) {
      logger.error('AUTH', reqId, 'Login error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 重置所有设置和数据库（清空业务表并重建默认管理员）
  app.post('/api/reset', authMiddleware, adminMiddleware, async (req, res) => {
    const reqId = createReqId();
    try {
      await resetDatabase();
      logger.warn('SYSTEM', reqId, 'Database and settings reset to defaults', { by: req.user?.username || 'unknown' });
      frontendLogger.warn('SYSTEM', '数据库和设置已重置', { by: req.user?.username || 'unknown' });
      res.json({ success: true, message: '已重置所有设置和数据库' });
    } catch (err) {
      logger.error('SYSTEM', reqId, 'Reset failed', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 登出：清除 HttpOnly 会话 Cookie（前端同时清理 localStorage 中的 token）
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      path: '/'
    });
    res.json({ success: true });
  });

  // 获取当前用户信息
  // 同时补发会话 Cookie：已登录但尚无 Cookie 的存量会话（如本次升级前登录的客户端），
  // 在启动校验身份时自动获得 Cookie，无需重新输入密码即可继续播放。
  app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
      const user = await getUserById(req.user.userId);
      const permissions = await getUserPermissions(req.user.userId);

      const authHeader = req.headers.authorization;
      const cookieToken = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : (req.cookies && req.cookies[SESSION_COOKIE]);
      if (cookieToken) {
        res.cookie(SESSION_COOKIE, cookieToken, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.COOKIE_SECURE === 'true',
          maxAge: SESSION_MAX_AGE,
          path: '/'
        });
      }

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            remark: user.remark
          },
          permissions
        }
      });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 修改密码（无需原密码）
  app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    const { newPassword } = req.body;
    const reqId = createReqId();

    if (!newPassword) {
      return res.json({ success: false, error: '新密码不能为空' });
    }

    if (newPassword.length < 4) {
      return res.json({ success: false, error: '新密码长度至少4位' });
    }

    try {
      const user = await getUserById(req.user.userId);
      const newHash = await bcrypt.hash(newPassword, 10);
      await updateUserPassword(req.user.userId, newHash);
      plaintextCache.set(user.username, newPassword);

      logger.info('AUTH', reqId, 'Password changed', { username: user.username });
      res.json({ success: true, message: '密码修改成功' });
    } catch (err) {
      logger.error('AUTH', reqId, 'Change password error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // ==================== 用户管理 API（需要管理员权限）====================
  // 获取所有用户
  app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const all = await getAllUsers();
      // 分页：?limit=&offset=；不传 limit 时返回全量（向后兼容前端旧调用）
      const limit = parseInt(req.query.limit);
      const offset = parseInt(req.query.offset) || 0;
      const page = (Number.isFinite(limit) && limit > 0) ? all.slice(offset, offset + limit) : all;
      ok(res, page, { total: all.length });
    } catch (err) {
      serverError(res, err.message);
    }
  });

  // 创建用户
  app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
    const { username, password, role, remark } = req.body;
    const reqId = createReqId();

    if (!username || !password) {
      return res.json({ success: false, error: '用户名和密码不能为空' });
    }

    if (username.length < 3) {
      return res.json({ success: false, error: '用户名长度至少3位' });
    }

    if (password.length < 4) {
      return res.json({ success: false, error: '密码长度至少4位' });
    }

    try {
      const existingUser = await getUserByUsername(username);
      if (existingUser) {
        return res.json({ success: false, error: '用户名已存在' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const result = await createUser({ username, role: role || 'user', remark }, passwordHash);
      plaintextCache.set(username, password);

      logger.info('USER', reqId, 'User created', { username, role: role || 'user', by: req.user.username });
      frontendLogger.info('USER', 'User created', { username, role: role || 'user', by: req.user.username });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('USER', reqId, 'Create user error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 更新用户信息
  app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const { role, remark, is_active, username } = req.body;
    const reqId = createReqId();

    try {
      // 不能修改自己的角色
      if (parseInt(id) === req.user.userId && role !== undefined) {
        return res.json({ success: false, error: '不能修改自己的角色' });
      }

      // 不能禁用自己
      if (parseInt(id) === req.user.userId && is_active === false) {
        return res.json({ success: false, error: '不能禁用自己' });
      }

      // 用户名唯一性校验
      if (username !== undefined && username !== null && username !== '') {
        const existing = await getUserByUsername(username);
        if (existing && existing.id !== parseInt(id)) {
          return res.json({ success: false, error: '用户名已存在' });
        }
      }

      const result = await updateUser(parseInt(id), { role, remark, is_active, username });

      logger.info('USER', reqId, 'User updated', { userId: id, by: req.user.username });
      frontendLogger.info('USER', 'User updated', { userId: id, by: req.user.username, changes: { role, remark, is_active, username } });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('USER', reqId, 'Update user error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 修改用户密码（管理员）
  app.post('/api/users/:id/change-password', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const reqId = createReqId();

    if (!password || password.length < 4) {
      return res.json({ success: false, error: '密码长度至少4位' });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const result = await updateUserPassword(parseInt(id), passwordHash);
      try {
        const target = await getUserById(parseInt(id));
        if (target) plaintextCache.set(target.username, password);
      } catch { /* ignore */ }

      logger.info('USER', reqId, 'User password changed', { userId: id, by: req.user.username });
      frontendLogger.info('USER', 'Password changed', { userId: id, by: req.user.username });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('USER', reqId, 'Change user password error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 删除用户
  app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const reqId = createReqId();

    try {
      // 不能删除自己
      if (parseInt(id) === req.user.userId) {
        return res.json({ success: false, error: '不能删除自己' });
      }

      // 不能删除唯一的管理员账号（避免把自己锁在管理后台外）；
      // 存在多个管理员时允许删除多余的那个（例如改名后残留的 admin 账号）
      const user = await getUserById(parseInt(id));
      if (user && user.role === 'admin') {
        const all = await getAllUsers();
        const adminCount = (all || []).filter((u) => u.role === 'admin').length;
        if (adminCount <= 1) {
          return res.json({ success: false, error: '不能删除唯一的管理员账号' });
        }
      }

      const result = await deleteUser(parseInt(id));

      logger.info('USER', reqId, 'User deleted', { userId: id, by: req.user.username });
      frontendLogger.info('USER', 'User deleted', { userId: id, username: user?.username, by: req.user.username });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('USER', reqId, 'Delete user error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });

  // 获取用户权限
  app.get('/api/users/:id/permissions', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
      const permissions = await getUserPermissions(parseInt(id));
      res.json({ success: true, data: permissions });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // 更新用户权限
  app.put('/api/users/:id/permissions', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const permissions = req.body;
    const reqId = createReqId();

    try {
      const result = await updateUserPermissions(parseInt(id), permissions);

      logger.info('USER', reqId, 'User permissions updated', { userId: id, by: req.user.username });
      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('USER', reqId, 'Update permissions error', { error: logger.formatError(err) });
      res.json({ success: false, error: err.message });
    }
  });
}

module.exports = registerAuthRoutes;
