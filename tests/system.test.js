import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function getCookieResponse(base, cookie, pathName) {
  const res = await fetch(`${base}${pathName}`, {
    headers: cookie ? { cookie } : undefined
  });
  return res;
}

test('登录、权限和状态更新', async () => {
  const dbPath = path.join(os.tmpdir(), `ticket-system-test-${Date.now()}.json`);
  const app = await createApp({ dataPath: dbPath, xlsxPath: '/Users/worker/Documents/H/11月 ODCASA订单-追踪进度表.xlsx' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = async (username, password) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    return { user: data.user, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };

  const admin = await login('admin', 'admin123');
  const adminCookie = admin.cookie;

  const li = await login('li', 'li123');
  const liCookie = li.cookie;

  const liOrdersRes = await getCookieResponse(base, liCookie, '/api/orders');
  const liOrders = await liOrdersRes.json();
  assert.equal(liOrdersRes.status, 200);
  assert.ok(liOrders.orders.length > 0);
  assert.ok(liOrders.orders.every((o) => o.assignedTo === 'li'));

  const allRes = await getCookieResponse(base, adminCookie, '/api/orders');
  const allOrders = await allRes.json();
  assert.ok(allOrders.orders.length >= liOrders.orders.length);

  const target = allOrders.orders.find((o) => o.assignedTo !== 'li');
  const forbidden = await fetch(`${base}/api/orders/${target.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      cookie: liCookie
    },
    body: JSON.stringify({ stage: 'material', status: '已完成' })
  });
  assert.equal(forbidden.status, 403);

  const detail = allOrders.orders[0];
  const update = await fetch(`${base}/api/orders/${detail.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      cookie: adminCookie
    },
    body: JSON.stringify({ stage: 'material', status: '已完成', comment: '测试更新' })
  });
  assert.equal(update.status, 200);

  const logsRes = await getCookieResponse(base, adminCookie, `/api/orders/${detail.id}`);
  const logsJson = await logsRes.json();
  assert.equal(logsRes.status, 200);
  assert.ok(logsJson.logs.length >= 1);
  assert.ok(logsJson.logs.some((l) => l.action === 'update_stage' && l.after === '已完成'));

  await new Promise((resolve) => server.close(resolve));
  fs.unlinkSync(dbPath);
});
