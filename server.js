import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import ExcelJS from 'exceljs';

const ROOT = process.cwd();
const DEFAULT_DATA_PATH = path.join(ROOT, 'data', 'state.json');
const DEFAULT_XLSX_PATH = path.join(ROOT, '11月 ODCASA订单-追踪进度表.xlsx');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

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

function hashPassword(password, username) {
  return crypto.pbkdf2Sync(password, `salt-${username}`, 1000, 32, 'sha256').toString('hex');
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

function defaultState() {
  return {
    users: [
      { id: 'admin', username: 'admin', name: '管理员', role: 'admin', passwordHash: hashPassword('admin123', 'admin') },
      { id: 'li', username: 'li', name: '李工', role: 'employee', passwordHash: hashPassword('li123', 'li') },
      { id: 'zhang', username: 'zhang', name: '张工', role: 'employee', passwordHash: hashPassword('zhang123', 'zhang') },
      { id: 'chen', username: 'chen', name: '陈工', role: 'employee', passwordHash: hashPassword('chen123', 'chen') }
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
    const fresh = defaultState();
    fresh.orders = await parseOrdersFromXlsx(xlsxPath);
    fresh.nextOrderId = fresh.orders.length + 1;
    writeStateToFile(statePath, fresh);
    return fresh;
  }

  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : defaultState();

  if (!Array.isArray(parsed.orders) || parsed.orders.length === 0) {
    const withOrders = defaultState();
    withOrders.orders = await parseOrdersFromXlsx(xlsxPath);
    withOrders.nextOrderId = withOrders.orders.length + 1;
    withOrders.logs = parsed.logs || [];
    withOrders.nextLogId = parsed.nextLogId || 1;
    writeStateToFile(statePath, withOrders);
    return withOrders;
  }

  return parsed;
}

async function createApp({ dataPath = DEFAULT_DATA_PATH, xlsxPath = DEFAULT_XLSX_PATH } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));

  let state = await loadState(dataPath, xlsxPath);
  const sessions = new Map();

  const resolveUser = (req, user) => {
    req.currentUser = user;
    return req;
  };

  const auth = (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.sid;
    if (!sid) return res.status(401).json({ error: '未登录' });

    const session = sessions.get(sid);
    if (!session || session.expires < Date.now()) {
      sessions.delete(sid);
      return res.status(401).json({ error: '会话已过期' });
    }

    const user = state.users.find((u) => u.id === session.userId);
    if (!user) return res.status(401).json({ error: '用户不存在' });

    return resolveUser(req, user), next();
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = state.users.find((u) => u.username === username);
    if (!user || !user.passwordHash || user.passwordHash !== hashPassword(password, username)) {
      return res.status(401).json({ error: '账号或密码错误' });
    }

    const sid = crypto.randomUUID();
    sessions.set(sid, { userId: user.id, expires: Date.now() + SESSION_TTL_MS });
    res
      .setHeader('Set-Cookie', `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
      .json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  });

  app.post('/api/logout', auth, (req, res) => {
    const sid = parseCookies(req.headers.cookie).sid;
    sessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => {
    const user = req.currentUser;
    res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  });

  app.get('/api/orders', auth, (req, res) => {
    const user = req.currentUser;
    const orders = state.orders
      .filter((o) => user.role === 'admin' || o.assignedTo === user.id)
      .map((o) => ({
        ...o,
        canEdit: user.role === 'admin' || o.assignedTo === user.id
      }));

    res.json({ orders, users: state.users, currentUser: user });
  });

  app.get('/api/orders/:id', auth, (req, res) => {
    const user = req.currentUser;
    const order = state.orders.find((o) => o.id === Number(req.params.id));
    if (!order) return res.status(404).json({ error: '工单不存在' });
    if (user.role !== 'admin' && order.assignedTo !== user.id) return res.status(403).json({ error: '无查看权限' });

    const logs = state.logs.filter((log) => log.orderId === order.id);
    res.json({ order, logs, canEdit: user.role === 'admin' || order.assignedTo === user.id });
  });

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

  app.post('/api/orders/:id/assign', auth, (req, res) => {
    const user = req.currentUser;
    if (user.role !== 'admin') return res.status(403).json({ error: '只有管理员可分配' });

    const order = state.orders.find((o) => o.id === Number(req.params.id));
    if (!order) return res.status(404).json({ error: '工单不存在' });

    const { assignee } = req.body || {};
    const exist = state.users.find((u) => u.id === assignee && u.role === 'employee');
    if (!exist) return res.status(400).json({ error: '无效员工' });

    order.assignedTo = assignee;
    writeStateToFile(dataPath, state);
    res.json({ order });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`工单系统已启动: http://localhost:${port}`);
  });
}

export { createApp };
