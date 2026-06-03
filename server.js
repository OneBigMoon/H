import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import ExcelJS from 'exceljs';
import morgan from 'morgan';
import bcrypt from 'bcrypt';
import logger, { httpLogStream } from './src/logger.js';
import config from './src/config.js';
import { setupSwagger } from './src/swagger.js';
import {
  helmetMiddleware,
  corsMiddleware,
  globalRateLimit,
  loginRateLimit,
  requestLogger,
  sanitizeInput
} from './src/security.js';
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
  createErrorHandler,
  setupUncaughtHandlers
} from './src/errors.js';

// 设置未捕获异常处理
setupUncaughtHandlers(logger);

const ROOT = process.cwd();
const STAGE_CONFIG = {
  material: ['客供配件', '配件'],
  drawing: ['排单', '图纸'],
  fabric: ['面料'],
  frame: ['木架'],
  padding: ['贴棉']
};

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const eq = item.indexOf('=');
      if (eq < 0) return acc;
      acc[item.slice(0, eq)] = decodeURIComponent(item.slice(eq + 1));
      return acc;
    }, {});
}

function normalizeCell(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (Array.isArray(value.richText)) return value.richText.map((x) => x.text || '').join('').trim();
    if (value.result !== undefined && value.result !== null) return String(value.result).trim();
  }
  return String(value);
}

function excelToDate(serial) {
  if (!serial || typeof serial !== 'number') return '';
  const origin = new Date(Date.UTC(1899, 11, 30));
  origin.setUTCDate(origin.getUTCDate() + serial);
  return origin.toISOString().slice(0, 10);
}

async function hashPassword(password) {
  return bcrypt.hash(password, config.security.bcryptRounds);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function computeOverall(stages) {
  const values = Object.values(stages);
  if (values.every((v) => ['已完成', '完成'].includes(v))) return '已完成';
  if (values.every((v) => ['未开始', '/', ''].includes(v))) return '未开始';
  return '进行中';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeStateToFile(statePath, state) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function defaultState() {
  return {
    users: [
      { id: 'admin', username: 'admin', name: '管理员', role: 'admin', passwordHash: await hashPassword('admin123') },
      { id: 'li', username: 'li', name: '李工', role: 'employee', passwordHash: await hashPassword('li123') },
      { id: 'zhang', username: 'zhang', name: '张工', role: 'employee', passwordHash: await hashPassword('zhang123') },
      { id: 'chen', username: 'chen', name: '陈工', role: 'employee', passwordHash: await hashPassword('chen123') }
    ],
    orders: [],
    logs: [],
    nextOrderId: 1,
    nextLogId: 1
  };
}

function getStageByHeader(rowValues, headers, keys) {
  const idx = headers.findIndex((h) => keys.some((k) => String(h || '').includes(k)));
  if (idx < 0) return '未开始';
  return rowValues[idx] || '未开始';
}

async function parseOrdersFromXlsx(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) {
    return [];
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const sheet = wb.worksheets[0];
  const headerRow = sheet.getRow(3).values.slice(1).map((v) => normalizeCell(v).replace(/\n/g, '').trim());
  const employeeIds = ['li', 'zhang', 'chen'];

  const orders = [];
  let orderId = 1;
  let assignCursor = 0;

  for (let r = 5; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const serial = normalizeCell(row.getCell(1).value);
    if (!serial) continue;

    const rowValues = row.values.slice(1).map(normalizeCell);
    const stages = {
      material: getStageByHeader(rowValues, headerRow, STAGE_CONFIG.material),
      drawing: getStageByHeader(rowValues, headerRow, STAGE_CONFIG.drawing),
      fabric: getStageByHeader(rowValues, headerRow, STAGE_CONFIG.fabric),
      frame: getStageByHeader(rowValues, headerRow, STAGE_CONFIG.frame),
      padding: getStageByHeader(rowValues, headerRow, STAGE_CONFIG.padding)
    };

    const order = {
      id: orderId++,
      serial,
      customer: rowValues[1] || '',
      orderDate: excelToDate(Number(rowValues[2])) || rowValues[2] || '',
      dueDate: excelToDate(Number(rowValues[3])) || rowValues[3] || '',
      product: rowValues[4] || '',
      spec: rowValues[5] || '',
      quantity: rowValues[11] || '',
      cycleDays: rowValues[12] || '',
      overdue: rowValues[13] || '',
      note: rowValues[6] || '',
      stages,
      assignedTo: employeeIds[assignCursor % employeeIds.length],
      overall: '未开始',
      createdAt: new Date().toISOString()
    };
    order.overall = computeOverall(order.stages);
    orders.push(order);
    assignCursor += 1;
  }

  return orders;
}

async function loadState(statePath, xlsxPath) {
  if (!fs.existsSync(statePath)) {
    const fresh = await defaultState();
    fresh.orders = await parseOrdersFromXlsx(xlsxPath);
    fresh.nextOrderId = fresh.orders.length + 1;
    writeStateToFile(statePath, fresh);
    logger.info('初始化状态文件', { path: statePath, orders: fresh.orders.length });
    return fresh;
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : await defaultState();

  if (!Array.isArray(parsed.orders) || parsed.orders.length === 0) {
    const withOrders = await defaultState();
    withOrders.orders = await parseOrdersFromXlsx(xlsxPath);
    withOrders.nextOrderId = withOrders.orders.length + 1;
    withOrders.logs = parsed.logs || [];
    withOrders.nextLogId = parsed.nextLogId || 1;
    writeStateToFile(statePath, withOrders);
    logger.info('从 Excel 导入订单', { orders: withOrders.orders.length });
    return withOrders;
  }

  logger.info('加载现有状态', { orders: parsed.orders.length, users: parsed.users?.length });
  return parsed;
}

async function createApp({ dataPath = config.database.path, xlsxPath = config.excel.defaultPath } = {}) {
  const app = express();

  // 安全中间件
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(globalRateLimit);

  // 请求解析
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 请求日志
  app.use(morgan('combined', { stream: httpLogStream }));
  app.use(requestLogger(logger));

  // 输入消毒
  app.use(sanitizeInput);

  // 静态文件
  app.use(express.static(path.join(ROOT, 'public')));

  // Swagger API 文档
  setupSwagger(app);

  logger.info('正在加载状态...');
  let state = await loadState(dataPath, xlsxPath);
  const sessions = new Map();

  const resolveUser = (req, user) => {
    req.currentUser = user;
    return req;
  };

  const auth = (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.sid;
    if (!sid) {
      logger.warn('未登录访问', { url: req.url, ip: req.ip });
      return next(new AuthenticationError());
    }

    const session = sessions.get(sid);
    if (!session || session.expires < Date.now()) {
      sessions.delete(sid);
      logger.warn('会话过期', { sid: sid.substring(0, 8) + '...', ip: req.ip });
      return next(new AuthenticationError('会话已过期'));
    }

    const user = state.users.find((u) => u.id === session.userId);
    if (!user) {
      logger.warn('用户不存在', { userId: session.userId });
      return next(new AuthenticationError('用户不存在'));
    }

    return resolveUser(req, user), next();
  };

  // 健康检查 API
  /**
   * @swagger
   * /health:
   *   get:
   *     summary: 健康检查
   *     description: 检查服务器是否正常运行
   *     tags: [System]
   *     security: []
   *     responses:
   *       200:
   *         description: 服务器正常
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 ok:
   *                   type: boolean
   *                 version:
   *                   type: string
   *                 uptime:
   *                   type: number
   */
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  // 登录接口 - 使用限速
  /**
   * @swagger
   * /api/login:
   *   post:
   *     summary: 用户登录
   *     description: 使用用户名和密码登录系统
   *     tags: [Auth]
   *     security: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - username
   *               - password
   *             properties:
   *               username:
   *                 type: string
   *                 description: 用户名
   *               password:
   *                 type: string
   *                 description: 密码
   *     responses:
   *       200:
   *         description: 登录成功
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 user:
   *                   $ref: '#/components/schemas/User'
   *       401:
   *         description: 账号或密码错误
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  app.post('/api/login', loginRateLimit, async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        throw new ValidationError('用户名和密码为必填项');
      }

      const user = state.users.find((u) => u.username === username);
      if (!user || !user.passwordHash) {
        logger.warn('登录失败 - 用户不存在', { username, ip: req.ip });
        throw new AuthenticationError('账号或密码错误');
      }

      const isValid = await verifyPassword(password, user.passwordHash);
      if (!isValid) {
        logger.warn('登录失败 - 密码错误', { username, ip: req.ip });
        throw new AuthenticationError('账号或密码错误');
      }

      const sid = crypto.randomUUID();
      sessions.set(sid, { userId: user.id, expires: Date.now() + config.session.ttlMs });

      logger.info('用户登录成功', { username, role: user.role, ip: req.ip });

      res
        .setHeader('Set-Cookie', `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; Max-Age=${Math.floor(config.session.ttlMs / 1000)}; SameSite=Strict`)
        .json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/logout', auth, (req, res) => {
    const sid = parseCookies(req.headers.cookie).sid;
    sessions.delete(sid);
    logger.info('用户登出', { userId: req.currentUser.id });
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict');
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => {
    const user = req.currentUser;
    res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  });

  /**
   * @swagger
   * /api/orders:
   *   get:
   *     summary: 获取订单列表
   *     description: 获取当前用户可访问的订单列表，支持排序和筛选
   *     tags: [Orders]
   *     parameters:
   *       - in: query
   *         name: sortBy
   *         schema:
   *           type: string
   *           enum: [id, dueDate, orderDate, createdAt]
   *         description: 排序字段
   *       - in: query
   *         name: sortOrder
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *         description: 排序方式
   *       - in: query
   *         name: filter
   *         schema:
   *           type: string
   *           enum: [all, overdue, upcoming]
   *         description: 筛选条件
   *     responses:
   *       200:
   *         description: 成功
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 orders:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Order'
   *                 users:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/User'
   *       401:
   *         description: 未登录
   */
  app.get('/api/orders', auth, (req, res) => {
    const user = req.currentUser;
    let orders = state.orders
      .filter((o) => user.role === 'admin' || o.assignedTo === user.id)
      .map((o) => ({
        ...o,
        canEdit: user.role === 'admin' || o.assignedTo === user.id
      }));

    // 排序
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

    orders.sort((a, b) => {
      let valueA = a[sortBy] || '';
      let valueB = b[sortBy] || '';

      // 日期字段特殊处理
      if (['orderDate', 'dueDate', 'createdAt'].includes(sortBy)) {
        valueA = valueA ? new Date(valueA).getTime() : 0;
        valueB = valueB ? new Date(valueB).getTime() : 0;
      }

      if (valueA < valueB) return -1 * sortOrder;
      if (valueA > valueB) return 1 * sortOrder;
      return 0;
    });

    // 筛选
    const filter = req.query.filter || 'all';
    if (filter === 'overdue') {
      const today = new Date().toISOString().slice(0, 10);
      orders = orders.filter((o) => o.dueDate && o.dueDate < today && o.overall !== '已完成');
    } else if (filter === 'upcoming') {
      const today = new Date();
      const threeDaysLater = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const todayStr = today.toISOString().slice(0, 10);
      orders = orders.filter((o) => o.dueDate && o.dueDate >= todayStr && o.dueDate <= threeDaysLater && o.overall !== '已完成');
    }

    res.json({ orders, users: state.users, currentUser: user });
  });

  // ===== 导出功能 =====

  // 导出订单为 Excel（管理员）
  app.get('/api/orders/export', auth, async (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可导出数据' });

    const orders = state.orders.filter((o) => user.role === 'admin' || o.assignedTo === user.id);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('订单列表');

    // 设置表头
    ws.columns = [
      { header: '订单号', key: 'serial', width: 15 },
      { header: '客户', key: 'customer', width: 20 },
      { header: '产品', key: 'product', width: 20 },
      { header: '规格', key: 'spec', width: 15 },
      { header: '下单日期', key: 'orderDate', width: 12 },
      { header: '交期', key: 'dueDate', width: 12 },
      { header: '数量', key: 'quantity', width: 10 },
      { header: '周期天数', key: 'cycleDays', width: 10 },
      { header: '负责人', key: 'assignedTo', width: 10 },
      { header: '整体状态', key: 'overall', width: 10 },
      { header: '备注', key: 'note', width: 30 }
    ];

    // 添加数据行
    orders.forEach((order) => {
      const assigneeName = state.users.find((u) => u.id === order.assignedTo)?.name || '未分配';
      ws.addRow({
        serial: order.serial,
        customer: order.customer,
        product: order.product,
        spec: order.spec,
        orderDate: order.orderDate,
        dueDate: order.dueDate,
        quantity: order.quantity,
        cycleDays: order.cycleDays,
        assignedTo: assigneeName,
        overall: order.overall,
        note: order.note
      });
    });

    // 设置响应头
    const filename = `ODCASA_订单_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    // 写入响应
    await wb.xlsx.write(res);
    res.end();
  });

  app.get('/api/orders/:id', auth, (req, res) => {
    const user = req.currentUser;
    const order = state.orders.find((o) => o.id === Number(req.params.id));
    if (!order) return res.status(404).json({ error: '工单不存在' });
    if (user.role !== 'admin' && order.assignedTo !== user.id) return res.status(403).json({ error: '无查看权限' });

    const logs = state.logs.filter((log) => log.orderId === order.id);
    res.json({ order, logs, canEdit: user.role === 'admin' || order.assignedTo === user.id });
  });

  // ===== 用户管理 API =====

  // 获取用户列表（管理员）
  app.get('/api/users', auth, (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可查看用户列表' });

    const users = state.users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role
    }));
    res.json({ users });
  });

  // 创建新用户（管理员）
  app.post('/api/users', auth, async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (user.role !== 'admin') throw new AuthorizationError('只有管理员可创建用户');

      const { username, name, role = 'employee', password } = req.body || {};
      if (!username || !name || !password) {
        throw new ValidationError('用户名、姓名、密码为必填项');
      }

      if (password.length < 6) {
        throw new ValidationError('密码长度至少6位');
      }

      // 检查用户名是否已存在
      const exists = state.users.find((u) => u.username === username);
      if (exists) {
        throw new ConflictError('用户名已存在');
      }

      const newUser = {
        id: username,
        username,
        name,
        role,
        passwordHash: await hashPassword(password)
      };

      state.users.push(newUser);

      // 记录日志
      state.logs.push({
        id: state.nextLogId++,
        orderId: null,
        userId: user.id,
        action: 'create_user',
        stage: null,
        before: null,
        after: null,
        comment: `创建用户: ${username} (${name})`,
        at: new Date().toISOString()
      });

      writeStateToFile(dataPath, state);
      logger.info('创建用户', { username, role, createdBy: user.id });

      res.status(201).json({
        user: {
          id: newUser.id,
          username: newUser.username,
          name: newUser.name,
          role: newUser.role
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // 编辑用户信息（管理员）
  app.put('/api/users/:id', auth, async (req, res, next) => {
    try {
      const user = req.currentUser;
      if (user.role !== 'admin') throw new AuthorizationError('只有管理员可编辑用户');

      const target = state.users.find((u) => u.id === req.params.id);
      if (!target) throw new NotFoundError('用户不存在');

      const { name, role, password } = req.body || {};
      const changes = [];

      if (name !== undefined && name !== target.name) {
        changes.push(`姓名: ${target.name} -> ${name}`);
        target.name = name;
      }
      if (role !== undefined && role !== target.role) {
        changes.push(`角色: ${target.role} -> ${role}`);
        target.role = role;
      }
      if (password) {
        if (password.length < 6) {
          throw new ValidationError('密码长度至少6位');
        }
        target.passwordHash = await hashPassword(password);
        changes.push('密码已更新');
      }

      if (changes.length > 0) {
        state.logs.push({
          id: state.nextLogId++,
          orderId: null,
          userId: user.id,
          action: 'update_user',
          stage: null,
          before: null,
          after: null,
          comment: `更新用户 ${target.username}: ${changes.join('; ')}`,
          at: new Date().toISOString()
        });

        writeStateToFile(dataPath, state);
        logger.info('更新用户', { username: target.username, changes, updatedBy: user.id });
      }

      res.json({
        user: {
          id: target.id,
          username: target.username,
          name: target.name,
          role: target.role
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // 删除用户（管理员）
  app.delete('/api/users/:id', auth, (req, res, next) => {
    try {
      const user = req.currentUser;
      if (user.role !== 'admin') throw new AuthorizationError('只有管理员可删除用户');

      const targetIndex = state.users.findIndex((u) => u.id === req.params.id);
      if (targetIndex < 0) throw new NotFoundError('用户不存在');

      const target = state.users[targetIndex];

      // 不能删除自己
      if (target.id === user.id) {
        throw new ValidationError('不能删除当前登录的用户');
      }

      // 不能删除最后一个管理员
      const adminCount = state.users.filter((u) => u.role === 'admin').length;
      if (target.role === 'admin' && adminCount <= 1) {
        throw new ValidationError('不能删除最后一个管理员');
      }

      state.users.splice(targetIndex, 1);

      // 记录日志
      state.logs.push({
        id: state.nextLogId++,
        orderId: null,
        userId: user.id,
        action: 'delete_user',
        stage: null,
        before: null,
        after: null,
        comment: `删除用户: ${target.username}`,
        at: new Date().toISOString()
      });

      writeStateToFile(dataPath, state);
      logger.info('删除用户', { username: target.username, deletedBy: user.id });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ===== 日志查看 API =====

  // 获取所有日志（管理员，支持分页）
  app.get('/api/logs', auth, (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可查看日志' });

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const orderId = req.query.orderId ? Number(req.query.orderId) : null;

    let logs = [...state.logs].sort((a, b) => b.id - a.id);

    // 可选过滤：按订单ID
    if (orderId) {
      logs = logs.filter((log) => log.orderId === orderId);
    }

    const total = logs.length;
    const startIndex = (page - 1) * limit;
    const paginatedLogs = logs.slice(startIndex, startIndex + limit);

    res.json({
      logs: paginatedLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  });

  // 订单相关 API（现有）

  // 创建新订单（管理员）
  app.post('/api/orders', auth, (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可创建订单' });

    const { serial, customer, orderDate, dueDate, product, spec, quantity, cycleDays, note = '' } = req.body || {};
    if (!serial || !customer || !product) {
      return res.status(400).json({ error: '订单号、客户、产品为必填项' });
    }

    const order = {
      id: state.nextOrderId++,
      serial,
      customer,
      orderDate: orderDate || '',
      dueDate: dueDate || '',
      product,
      spec: spec || '',
      quantity: quantity || '',
      cycleDays: cycleDays || '',
      overdue: '',
      note,
      stages: {
        material: '未开始',
        drawing: '未开始',
        fabric: '未开始',
        frame: '未开始',
        padding: '未开始'
      },
      assignedTo: '',
      overall: '未开始',
      createdAt: new Date().toISOString()
    };

    state.orders.push(order);

    // 记录日志
    state.logs.push({
      id: state.nextLogId++,
      orderId: order.id,
      userId: user.id,
      action: 'create_order',
      stage: null,
      before: null,
      after: null,
      comment: `创建订单: ${serial}`,
      at: new Date().toISOString()
    });

    writeStateToFile(dataPath, state);
    res.status(201).json({ order });
  });

  // 编辑订单基础信息（管理员）
  app.put('/api/orders/:id', auth, (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可编辑订单' });

    const order = state.orders.find((o) => o.id === Number(req.params.id));
    if (!order) return res.status(404).json({ error: '工单不存在' });

    const { serial, customer, orderDate, dueDate, product, spec, quantity, cycleDays, note } = req.body || {};
    const changes = [];

    if (serial !== undefined && serial !== order.serial) {
      changes.push(`订单号: ${order.serial} -> ${serial}`);
      order.serial = serial;
    }
    if (customer !== undefined && customer !== order.customer) {
      changes.push(`客户: ${order.customer} -> ${customer}`);
      order.customer = customer;
    }
    if (orderDate !== undefined && orderDate !== order.orderDate) {
      changes.push(`下单日期: ${order.orderDate} -> ${orderDate}`);
      order.orderDate = orderDate;
    }
    if (dueDate !== undefined && dueDate !== order.dueDate) {
      changes.push(`交期: ${order.dueDate} -> ${dueDate}`);
      order.dueDate = dueDate;
    }
    if (product !== undefined && product !== order.product) {
      changes.push(`产品: ${order.product} -> ${product}`);
      order.product = product;
    }
    if (spec !== undefined && spec !== order.spec) {
      changes.push(`规格: ${order.spec} -> ${spec}`);
      order.spec = spec;
    }
    if (quantity !== undefined && quantity !== order.quantity) {
      changes.push(`数量: ${order.quantity} -> ${quantity}`);
      order.quantity = quantity;
    }
    if (cycleDays !== undefined && cycleDays !== order.cycleDays) {
      changes.push(`周期天数: ${order.cycleDays} -> ${cycleDays}`);
      order.cycleDays = cycleDays;
    }
    if (note !== undefined && note !== order.note) {
      changes.push(`备注已更新`);
      order.note = note;
    }

    if (changes.length > 0) {
      state.logs.push({
        id: state.nextLogId++,
        orderId: order.id,
        userId: user.id,
        action: 'update_order',
        stage: null,
        before: null,
        after: null,
        comment: changes.join('; '),
        at: new Date().toISOString()
      });

      writeStateToFile(dataPath, state);
    }

    res.json({ order });
  });

  // 删除订单（管理员）
  app.delete('/api/orders/:id', auth, (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可删除订单' });

    const orderIndex = state.orders.findIndex((o) => o.id === Number(req.params.id));
    if (orderIndex < 0) return res.status(404).json({ error: '工单不存在' });

    const order = state.orders[orderIndex];
    state.orders.splice(orderIndex, 1);

    // 记录日志
    state.logs.push({
      id: state.nextLogId++,
      orderId: order.id,
      userId: user.id,
      action: 'delete_order',
      stage: null,
      before: null,
      after: null,
      comment: `删除订单: ${order.serial}`,
      at: new Date().toISOString()
    });

    writeStateToFile(dataPath, state);
    res.json({ ok: true });
  });

  // 更新订单阶段状态（现有）
  app.patch('/api/orders/:id', auth, (req, res) => {
    const user = req.currentUser;
    const order = state.orders.find((o) => o.id === Number(req.params.id));
    if (!order) return res.status(404).json({ error: '工单不存在' });
    if (user.role !== 'admin' && order.assignedTo !== user.id) return res.status(403).json({ error: '无编辑权限' });

    const { stage, status, comment = '' } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(order.stages, stage)) {
      return res.status(400).json({ error: '无效阶段' });
    }

    const before = order.stages[stage];
    const nextStatus = status || before;
    order.stages[stage] = nextStatus;
    order.overall = computeOverall(order.stages);

    state.logs.push({
      id: state.nextLogId++,
      orderId: order.id,
      userId: user.id,
      action: 'update_stage',
      stage,
      before,
      after: nextStatus,
      comment,
      at: new Date().toISOString()
    });

    writeStateToFile(dataPath, state);
    res.json({ order });
  });

  app.post('/api/orders/:id/assign', auth, (req, res, next) => {
    try {
      const user = req.currentUser;
      if (user.role !== 'admin') throw new AuthorizationError('只有管理员可分配');

      const order = state.orders.find((o) => o.id === Number(req.params.id));
      if (!order) throw new NotFoundError('工单不存在');

      const { assignee } = req.body || {};
      const exist = state.users.find((u) => u.id === assignee && u.role === 'employee');
      if (!exist) throw new ValidationError('无效员工');

      order.assignedTo = assignee;
      writeStateToFile(dataPath, state);
      logger.info('分配订单', { orderId: order.id, assignee, assignedBy: user.id });

      res.json({ order });
    } catch (err) {
      next(err);
    }
  });

  // 健康检查 API
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: config.server.env,
      orders: state.orders.length,
      users: state.users.length,
      logs: state.logs.length
    });
  });

  // 错误处理中间件（必须放在最后）
  app.use(createErrorHandler(logger));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  const port = config.server.port;
  const host = config.server.host;

  app.listen(port, host, () => {
    logger.info(`🚀 工单系统已启动`, {
      url: `http://${host}:${port}`,
      environment: config.server.env,
      logLevel: config.logging.level
    });
  });
}

export { createApp };
