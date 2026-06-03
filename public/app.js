const loginArea = document.querySelector('#loginArea');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#loginForm');
const loginMsg = document.querySelector('#loginMsg');
const hint = document.querySelector('#hint');
const tbody = document.querySelector('#tbody');
const userInfo = document.querySelector('#userInfo');
const refreshBtn = document.querySelector('#refreshBtn');
const logoutBtn = document.querySelector('#logoutBtn');
const searchInput = document.querySelector('#searchInput');

let currentUser = null;
let allUsers = [];

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function setLoggedIn(user) {
  currentUser = user;
  loginArea.classList.add('hidden');
  dashboard.classList.remove('hidden');
  userInfo.textContent = `${user.name}（${user.role === 'admin' ? '管理员' : '员工'}）`;
}

function setLoggedOut() {
  currentUser = null;
  loginArea.classList.remove('hidden');
  dashboard.classList.add('hidden');
  userInfo.textContent = '';
}

function stageOptions(selected) {
  const options = ['未开始', '进行中', '已排单', '排单中', '待确认', '已完成', '/'];
  return options.map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
}

function renderRows(orders) {
  const keyword = searchInput.value.trim().toLowerCase();
  const filtered = orders.filter((order) => {
    const k = `${order.serial} ${order.customer} ${order.product} ${order.spec}`.toLowerCase();
    return !keyword || k.includes(keyword);
  });

  tbody.innerHTML = filtered
    .map((order) => {
      const assignee = allUsers.find((u) => u.id === order.assignedTo)?.name || '未分配';
      const canEdit = order.canEdit;

      const rows = Object.entries(order.stages)
        .map(
          ([stage, status]) => `
            <label class="small">
              ${stage}
              <select class="stageSelect" data-id="${order.id}" data-stage="${stage}" ${canEdit ? '' : 'disabled'}>
                ${stageOptions(status)}
              </select>
            </label>
          `
        )
        .join('');

      const assignSelect =
        currentUser.role === 'admin'
          ? `<label class="small">分配给
              <select class="assignSelect" data-id="${order.id}">
                ${allUsers
                  .filter((u) => u.role === 'employee')
                  .map((u) => `<option value="${u.id}" ${u.id === order.assignedTo ? 'selected' : ''}>${u.name}</option>`)
                  .join('')}
              </select>
            </label>`
          : `<span class="small">${assignee}</span>`;

      return `
        <tr class="row">
          <td>${order.serial}</td>
          <td>${order.customer}</td>
          <td>${order.product}<br><span class="small">${order.spec}</span></td>
          <td>${order.orderDate}</td>
          <td>${order.dueDate}</td>
          <td>${assignSelect}</td>
          <td>${rows}</td>
          <td>${order.overall}</td>
          <td>
            <input class="commentInput" data-id="${order.id}" placeholder="备注" />
            <button data-update="${order.id}" ${canEdit ? '' : 'disabled'}>提交更新</button>
          </td>
        </tr>`;
    })
    .join('');
}

async function loadOrders() {
  if (!currentUser) return;
  const payload = await request('/api/orders');
  allUsers = payload.users || [];
  renderRows(payload.orders || []);
}

async function bootstrap() {
  try {
    const payload = await request('/api/me');
    currentUser = payload.user;
    setLoggedIn(currentUser);
    await loadOrders();
  } catch {
    setLoggedOut();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginMsg.textContent = '';
  const username = document.querySelector('#username').value.trim();
  const password = document.querySelector('#password').value;
  try {
    const payload = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    setLoggedIn(payload.user);
    await loadOrders();
  } catch (e) {
    loginMsg.textContent = e.message;
  }
});

refreshBtn.addEventListener('click', loadOrders);
searchInput.addEventListener('input', loadOrders);

tbody.addEventListener('click', async (e) => {
  const id = e.target?.dataset?.update;
  if (!id) return;

  const comment = tbody.querySelector(`.commentInput[data-id="${id}"]`)?.value || '';
  const selectors = tbody.querySelectorAll(`.stageSelect[data-id="${id}"]`);
  if (!selectors.length) return;

  for (const sel of selectors) {
    const stage = sel.dataset.stage;
    const status = sel.value;
    try {
      await request(`/api/orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage, status, comment })
      });
      hint.textContent = '已更新';
    } catch (err) {
      hint.textContent = err.message;
      return;
    }
  }

  await loadOrders();
});

tbody.addEventListener('change', async (e) => {
  if (!e.target.classList.contains('assignSelect') || currentUser.role !== 'admin') return;
  const id = Number(e.target.dataset.id);
  const assignee = e.target.value;
  try {
    await request(`/api/orders/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ assignee })
    });
    hint.textContent = '分配完成';
    await loadOrders();
  } catch (err) {
    hint.textContent = err.message;
  }
});

logoutBtn.addEventListener('click', async () => {
  await request('/api/logout', { method: 'POST' }).catch(() => {});
  setLoggedOut();
});

bootstrap();
