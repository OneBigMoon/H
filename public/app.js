const loginArea = document.querySelector('#loginArea');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#loginForm');
const loginMsg = document.querySelector('#loginMsg');
const hint = document.querySelector('#hint');
const tbody = document.querySelector('#tbody');
const userInfo = document.querySelector('#userInfo');
const refreshBtn = document.querySelector('#refreshBtn');
const logoutBtn = document.querySelector('#logoutBtn');
const exportBtn = document.querySelector('#exportBtn');
const searchInput = document.querySelector('#searchInput');
const sortBy = document.querySelector('#sortBy');
const sortOrder = document.querySelector('#sortOrder');
const filterType = document.querySelector('#filterType');

let currentUser = null;
let allUsers = [];
let cachedOrders = [];

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
  cachedOrders = orders;
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
            <div class="action-buttons">
              <button data-detail="${order.id}" class="btn-small">详情</button>
              <input class="commentInput" data-id="${order.id}" placeholder="备注" />
              <button data-update="${order.id}" ${canEdit ? '' : 'disabled'} class="btn-small">提交更新</button>
              ${currentUser.role === 'admin' ? `
                <button data-edit="${order.id}" class="btn-small">编辑</button>
                <button data-delete="${order.id}" class="btn-small btn-danger">删除</button>
              ` : ''}
            </div>
          </td>
        </tr>`;
    })
    .join('');
}

async function loadOrders() {
  if (!currentUser) return;
  const sortByVal = sortBy.value;
  const sortOrderVal = sortOrder.value;
  const filterVal = filterType.value;

  const params = new URLSearchParams({
    sortBy: sortByVal,
    sortOrder: sortOrderVal,
    filter: filterVal
  });

  const payload = await request(`/api/orders?${params}`);
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
sortBy.addEventListener('change', loadOrders);
sortOrder.addEventListener('change', loadOrders);
filterType.addEventListener('change', loadOrders);

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

exportBtn.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/orders/export', {
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '导出失败');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ODCASA_订单_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    hint.textContent = '导出成功';
  } catch (err) {
    hint.textContent = err.message;
  }
});

// ===== 订单管理 =====

const addOrderBtn = document.querySelector('#addOrderBtn');
const orderFormModal = document.querySelector('#orderFormModal');
const orderFormTitle = document.querySelector('#orderFormTitle');
const orderForm = document.querySelector('#orderForm');
const orderDetailModal = document.querySelector('#orderDetailModal');
const orderDetailBody = document.querySelector('#orderDetailBody');

function openModal(modalId) {
  document.querySelector(`#${modalId}`).classList.remove('hidden');
}

function closeModal(modalId) {
  document.querySelector(`#${modalId}`).classList.add('hidden');
}

// 关闭模态框按钮
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    closeModal(btn.dataset.close);
  });
});

// 点击模态框外部关闭
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });
});

// 新建订单
addOrderBtn.addEventListener('click', () => {
  orderFormTitle.textContent = '新建订单';
  orderForm.reset();
  document.querySelector('#orderId').value = '';
  openModal('orderFormModal');
});

// 订单表单提交
orderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.querySelector('#orderId').value;
  const data = {
    serial: document.querySelector('#formSerial').value.trim(),
    customer: document.querySelector('#formCustomer').value.trim(),
    product: document.querySelector('#formProduct').value.trim(),
    spec: document.querySelector('#formSpec').value.trim(),
    orderDate: document.querySelector('#formOrderDate').value,
    dueDate: document.querySelector('#formDueDate').value,
    quantity: document.querySelector('#formQuantity').value.trim(),
    cycleDays: document.querySelector('#formCycleDays').value.trim(),
    note: document.querySelector('#formNote').value.trim()
  };

  try {
    if (id) {
      await request(`/api/orders/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      hint.textContent = '订单已更新';
    } else {
      await request('/api/orders', { method: 'POST', body: JSON.stringify(data) });
      hint.textContent = '订单已创建';
    }
    closeModal('orderFormModal');
    await loadOrders();
  } catch (err) {
    hint.textContent = err.message;
  }
});

// 编辑订单
tbody.addEventListener('click', async (e) => {
  const id = e.target?.dataset?.edit;
  if (!id) return;

  const order = cachedOrders.find(o => o.id === Number(id));
  if (!order) return;

  orderFormTitle.textContent = '编辑订单';
  document.querySelector('#orderId').value = order.id;
  document.querySelector('#formSerial').value = order.serial;
  document.querySelector('#formCustomer').value = order.customer;
  document.querySelector('#formProduct').value = order.product;
  document.querySelector('#formSpec').value = order.spec;
  document.querySelector('#formOrderDate').value = order.orderDate;
  document.querySelector('#formDueDate').value = order.dueDate;
  document.querySelector('#formQuantity').value = order.quantity;
  document.querySelector('#formCycleDays').value = order.cycleDays;
  document.querySelector('#formNote').value = order.note;
  openModal('orderFormModal');
});

// 删除订单
tbody.addEventListener('click', async (e) => {
  const id = e.target?.dataset?.delete;
  if (!id) return;

  if (!confirm('确定要删除此订单吗？此操作不可撤销。')) return;

  try {
    await request(`/api/orders/${id}`, { method: 'DELETE' });
    hint.textContent = '订单已删除';
    await loadOrders();
  } catch (err) {
    hint.textContent = err.message;
  }
});

// 查看订单详情
tbody.addEventListener('click', async (e) => {
  const id = e.target?.dataset?.detail;
  if (!id) return;

  try {
    const payload = await request(`/api/orders/${id}`);
    const order = payload.order;
    const logs = payload.logs || [];

    let html = `
      <div class="detail-grid">
        <div><strong>订单号:</strong> ${order.serial}</div>
        <div><strong>客户:</strong> ${order.customer}</div>
        <div><strong>产品:</strong> ${order.product}</div>
        <div><strong>规格:</strong> ${order.spec}</div>
        <div><strong>下单日期:</strong> ${order.orderDate}</div>
        <div><strong>交期:</strong> ${order.dueDate}</div>
        <div><strong>数量:</strong> ${order.quantity}</div>
        <div><strong>周期天数:</strong> ${order.cycleDays}</div>
        <div><strong>整体状态:</strong> ${order.overall}</div>
        <div><strong>备注:</strong> ${order.note || '-'}</div>
      </div>
      <h3 style="margin-top: 1rem;">操作日志</h3>
    `;

    if (logs.length === 0) {
      html += '<p>暂无操作记录</p>';
    } else {
      html += '<table><thead><tr><th>时间</th><th>操作</th><th>详情</th></tr></thead><tbody>';
      logs.forEach(log => {
        html += `<tr><td>${new Date(log.at).toLocaleString('zh-CN')}</td><td>${log.action}</td><td>${log.comment || '-'}</td></tr>`;
      });
      html += '</tbody></table>';
    }

    orderDetailBody.innerHTML = html;
    openModal('orderDetailModal');
  } catch (err) {
    hint.textContent = err.message;
  }
});

// ===== 用户管理 =====

const usersBtn = document.querySelector('#usersBtn');
const usersModal = document.querySelector('#usersModal');
const usersTbody = document.querySelector('#usersTbody');
const addUserBtn = document.querySelector('#addUserBtn');
const userFormModal = document.querySelector('#userFormModal');
const userFormTitle = document.querySelector('#userFormTitle');
const userForm = document.querySelector('#userForm');

usersBtn.addEventListener('click', async () => {
  if (currentUser.role !== 'admin') {
    hint.textContent = '只有管理员可管理用户';
    return;
  }
  await loadUsers();
  openModal('usersModal');
});

async function loadUsers() {
  try {
    const payload = await request('/api/users');
    renderUsers(payload.users || []);
  } catch (err) {
    hint.textContent = err.message;
  }
}

function renderUsers(users) {
  usersTbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.username}</td>
      <td>${u.name}</td>
      <td>${u.role === 'admin' ? '管理员' : '员工'}</td>
      <td>
        <button data-edit-user="${u.id}">编辑</button>
        <button data-delete-user="${u.id}" class="btn-danger">删除</button>
      </td>
    </tr>
  `).join('');
}

addUserBtn.addEventListener('click', () => {
  userFormTitle.textContent = '新建用户';
  userForm.reset();
  document.querySelector('#userId').value = '';
  openModal('userFormModal');
});

userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.querySelector('#userId').value;
  const data = {
    username: document.querySelector('#formUsername').value.trim(),
    name: document.querySelector('#formName').value.trim(),
    role: document.querySelector('#formRole').value,
    password: document.querySelector('#formPassword').value
  };

  try {
    if (id) {
      await request(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      hint.textContent = '用户已更新';
    } else {
      await request('/api/users', { method: 'POST', body: JSON.stringify(data) });
      hint.textContent = '用户已创建';
    }
    closeModal('userFormModal');
    await loadUsers();
  } catch (err) {
    hint.textContent = err.message;
  }
});

usersTbody.addEventListener('click', async (e) => {
  const editId = e.target?.dataset?.editUser;
  const deleteId = e.target?.dataset?.deleteUser;

  if (editId) {
    try {
      const payload = await request('/api/users');
      const user = payload.users.find(u => u.id === editId);
      if (user) {
        userFormTitle.textContent = '编辑用户';
        document.querySelector('#userId').value = user.id;
        document.querySelector('#formUsername').value = user.username;
        document.querySelector('#formUsername').disabled = true;
        document.querySelector('#formName').value = user.name;
        document.querySelector('#formRole').value = user.role;
        document.querySelector('#formPassword').value = '';
        openModal('userFormModal');
      }
    } catch (err) {
      hint.textContent = err.message;
    }
  }

  if (deleteId) {
    if (!confirm('确定要删除此用户吗？')) return;
    try {
      await request(`/api/users/${deleteId}`, { method: 'DELETE' });
      hint.textContent = '用户已删除';
      await loadUsers();
    } catch (err) {
      hint.textContent = err.message;
    }
  }
});

// ===== 日志查看 =====

const logsBtn = document.querySelector('#logsBtn');
const logsModal = document.querySelector('#logsModal');
const logsTbody = document.querySelector('#logsTbody');
const logsPagination = document.querySelector('#logsPagination');

logsBtn.addEventListener('click', async () => {
  if (currentUser.role !== 'admin') {
    hint.textContent = '只有管理员可查看日志';
    return;
  }
  await loadLogs(1);
  openModal('logsModal');
});

async function loadLogs(page = 1) {
  try {
    const payload = await request(`/api/logs?page=${page}&limit=20`);
    renderLogs(payload.logs || []);
    renderLogsPagination(payload.pagination || {});
  } catch (err) {
    hint.textContent = err.message;
  }
}

function renderLogs(logs) {
  logsTbody.innerHTML = logs.map(log => `
    <tr>
      <td>${new Date(log.at).toLocaleString('zh-CN')}</td>
      <td>${allUsers.find(u => u.id === log.userId)?.name || log.userId}</td>
      <td>${log.orderId || '-'}</td>
      <td>${log.action}</td>
      <td>${log.comment || '-'}</td>
    </tr>
  `).join('');
}

function renderLogsPagination(pagination) {
  if (!pagination || pagination.totalPages <= 1) {
    logsPagination.innerHTML = '';
    return;
  }

  let html = '';
  for (let i = 1; i <= pagination.totalPages; i++) {
    html += `<button data-log-page="${i}" ${i === pagination.page ? 'disabled' : ''}>${i}</button>`;
  }
  logsPagination.innerHTML = html;
}

logsPagination.addEventListener('click', (e) => {
  const page = e.target?.dataset?.logPage;
  if (page) {
    loadLogs(Number(page));
  }
});

bootstrap();
