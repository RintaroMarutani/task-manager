// ========================================
// IndexedDB
// ========================================
const DB_NAME = 'taskmanager';
const DB_VERSION = 2;
let idb = null;

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbOpen() {
  return new Promise((resolve, reject) => {
    if (idb) return resolve(idb);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('tasks')) {
        const s = d.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
        s.createIndex('source', 'source', { unique: false });
        s.createIndex('source_id', 'source_id', { unique: false });
      }
      if (!d.objectStoreNames.contains('connections')) {
        d.createObjectStore('connections', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { idb = e.target.result; resolve(idb); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- Tasks CRUD ----
async function dbGetAllTasks(filters = {}) {
  await dbOpen();
  const all = await idbReq(idb.transaction('tasks').objectStore('tasks').getAll());
  let tasks = all;
  if (filters.source) tasks = tasks.filter(t => t.source === filters.source);
  if (filters.completed !== undefined) tasks = tasks.filter(t => !!t.completed === filters.completed);
  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
  return tasks;
}

async function dbGetTask(id) {
  await dbOpen();
  return idbReq(idb.transaction('tasks').objectStore('tasks').get(id));
}

async function dbCreateTask(data) {
  await dbOpen();
  const now = localNow();
  const task = {
    title: data.title || '',
    description: data.description || '',
    completed: data.completed ? 1 : 0,
    due_date: data.due_date || null,
    source: data.source || 'local',
    source_id: data.source_id || null,
    source_url: data.source_url || null,
    connection_id: data.connection_id || null,
    created_at: now,
    updated_at: now,
  };
  const id = await idbReq(idb.transaction('tasks', 'readwrite').objectStore('tasks').add(task));
  return { ...task, id };
}

async function dbUpdateTask(id, fields) {
  await dbOpen();
  const task = await idbReq(idb.transaction('tasks').objectStore('tasks').get(id));
  if (!task) return null;
  const allowed = ['title', 'description', 'completed', 'due_date', 'source_url'];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      task[key] = key === 'completed' ? (fields[key] ? 1 : 0) : fields[key];
    }
  }
  task.updated_at = localNow();
  await idbReq(idb.transaction('tasks', 'readwrite').objectStore('tasks').put(task));
  return task;
}

async function dbDeleteTask(id) {
  await dbOpen();
  const task = await idbReq(idb.transaction('tasks').objectStore('tasks').get(id));
  if (task) await idbReq(idb.transaction('tasks', 'readwrite').objectStore('tasks').delete(id));
  return task;
}

// ---- Connections CRUD ----
async function dbGetAllConnections() {
  await dbOpen();
  return idbReq(idb.transaction('connections').objectStore('connections').getAll());
}

async function dbGetConnection(id) {
  await dbOpen();
  return idbReq(idb.transaction('connections').objectStore('connections').get(id));
}

async function dbCreateConnection(data) {
  await dbOpen();
  const conn = {
    type: data.type,
    name: data.name,
    config: data.config,
    enabled: 1,
    last_synced_at: null,
    created_at: localNow(),
  };
  const id = await idbReq(idb.transaction('connections', 'readwrite').objectStore('connections').add(conn));
  return { ...conn, id };
}

async function dbUpdateConnection(id, fields) {
  await dbOpen();
  const conn = await idbReq(idb.transaction('connections').objectStore('connections').get(id));
  if (!conn) return null;
  for (const [k, v] of Object.entries(fields)) conn[k] = v;
  await idbReq(idb.transaction('connections', 'readwrite').objectStore('connections').put(conn));
  return conn;
}

async function dbDeleteConnection(id) {
  await dbOpen();
  const conn = await idbReq(idb.transaction('connections').objectStore('connections').get(id));
  if (conn) await idbReq(idb.transaction('connections', 'readwrite').objectStore('connections').delete(id));
  return conn;
}

// ========================================
// Notion API Client (Browser-side)
// ========================================
const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

function getCorsProxy() {
  return localStorage.getItem('cors_proxy') || '';
}

async function notionFetch(token, path, options = {}) {
  const proxy = getCorsProxy();
  const targetUrl = NOTION_BASE + path;
  const url = proxy ? proxy + encodeURIComponent(targetUrl) : targetUrl;
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VER,
  };
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.message || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function notionTestConnection(token, dbId) {
  const data = await notionFetch(token, '/databases/' + dbId);
  return {
    title: data.title.map(t => t.plain_text).join('') || 'Untitled',
    properties: Object.keys(data.properties),
  };
}

function notionPageTitle(page) {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map(t => t.plain_text).join('') || 'Untitled';
    }
  }
  return 'Untitled';
}

async function notionCollectTodos(token, blockId, pageTitle, pageUrl) {
  const todos = [];
  let cursor;
  do {
    let path = '/blocks/' + blockId + '/children?page_size=100';
    if (cursor) path += '&start_cursor=' + cursor;
    const data = await notionFetch(token, path);
    for (const block of data.results) {
      if (block.type === 'to_do') {
        const text = block.to_do.rich_text.map(t => t.plain_text).join('');
        if (text) {
          todos.push({
            source_id: block.id,
            title: text,
            completed: block.to_do.checked,
            description: pageTitle,
            source_url: pageUrl + '#' + block.id.replace(/-/g, ''),
          });
        }
      }
      if (block.has_children) {
        const nested = await notionCollectTodos(token, block.id, pageTitle, pageUrl);
        todos.push(...nested);
      }
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return todos;
}

async function notionFetchTodos(token, databaseId) {
  const allTodos = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(token, '/databases/' + databaseId + '/query', {
      method: 'POST', body,
    });
    for (const page of data.results) {
      const todos = await notionCollectTodos(token, page.id, notionPageTitle(page), page.url);
      allTodos.push(...todos);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return allTodos;
}

async function notionUpdateTodoChecked(token, blockId, checked) {
  await notionFetch(token, '/blocks/' + blockId, {
    method: 'PATCH', body: { to_do: { checked } },
  });
}

async function notionUpdateTodoText(token, blockId, text) {
  await notionFetch(token, '/blocks/' + blockId, {
    method: 'PATCH',
    body: { to_do: { rich_text: [{ type: 'text', text: { content: text } }] } },
  });
}

// ========================================
// Sync
// ========================================
async function syncConnection(conn) {
  const { token, database_id } = conn.config;

  // Push local → Notion
  const localTasks = await dbGetAllTasks({ source: 'notion' });
  for (const task of localTasks) {
    if (task.source_id && task.connection_id === conn.id) {
      try { await notionUpdateTodoChecked(token, task.source_id, !!task.completed); } catch (_) {}
    }
  }

  // Pull Notion → local
  const remoteTodos = await notionFetchTodos(token, database_id);
  const localBySourceId = new Map();
  for (const t of localTasks) {
    if (t.source_id) localBySourceId.set(t.source_id, t);
  }

  const remoteIds = new Set();
  for (const todo of remoteTodos) {
    remoteIds.add(todo.source_id);
    const existing = localBySourceId.get(todo.source_id);
    if (existing) {
      await dbUpdateTask(existing.id, {
        title: todo.title,
        description: todo.description,
        completed: todo.completed,
        source_url: todo.source_url,
      });
    } else {
      await dbCreateTask({
        ...todo,
        source: 'notion',
        connection_id: conn.id,
      });
    }
  }

  // Remove deleted todos
  for (const local of localTasks) {
    if (local.source_id && local.connection_id === conn.id && !remoteIds.has(local.source_id)) {
      await dbDeleteTask(local.id);
    }
  }

  await dbUpdateConnection(conn.id, { last_synced_at: localNow() });
  return { synced: remoteTodos.length };
}

async function syncAllConnections() {
  const connections = await dbGetAllConnections();
  for (const conn of connections) {
    if (!conn.enabled || conn.type !== 'notion') continue;
    try {
      const r = await syncConnection(conn);
      console.log('[Sync]', conn.name + ':', r.synced, 'todos');
    } catch (err) {
      console.error('[Sync]', conn.name, 'failed:', err.message);
    }
  }
}

// Push a single task change to Notion immediately
async function pushTaskToNotion(task, updates) {
  if (task.source !== 'notion' || !task.source_id) return;
  const connections = await dbGetAllConnections();
  const conn = connections.find(c => c.id === task.connection_id && c.enabled);
  if (!conn) return;
  const { token } = conn.config;
  try {
    if (updates.completed !== undefined) {
      await notionUpdateTodoChecked(token, task.source_id, !!updates.completed);
    }
    if (updates.title !== undefined && updates.title !== task.title) {
      await notionUpdateTodoText(token, task.source_id, updates.title);
    }
  } catch (err) {
    console.error('[Notion push]', err.message);
  }
}

// ========================================
// State & DOM
// ========================================
let allTasks = [];
let currentTab = 'all';
let currentSource = '';
let lastTaskIds = new Set();
let connectionMap = {};

const taskForm = document.getElementById('task-form');
const taskTitle = document.getElementById('task-title');
const taskDesc = document.getElementById('task-desc');
const taskDue = document.getElementById('task-due');
const taskList = document.getElementById('task-list');
const emptyMsg = document.getElementById('empty-message');
const btnToggle = document.getElementById('btn-toggle-details');
const formDetails = document.getElementById('form-details');

const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const editId = document.getElementById('edit-id');
const editTitle = document.getElementById('edit-title');
const editDesc = document.getElementById('edit-desc');
const editDue = document.getElementById('edit-due');
const btnCancel = document.getElementById('btn-cancel');

const tabBar = document.getElementById('tab-bar');
const tabIndicator = document.getElementById('tab-indicator');
const sourceChips = document.getElementById('source-chips');

const badgeAll = document.getElementById('badge-all');
const badgeActive = document.getElementById('badge-active');
const badgeDone = document.getElementById('badge-done');

// ========================================
// Toggle form details
// ========================================
btnToggle.addEventListener('click', () => {
  formDetails.classList.toggle('show');
  btnToggle.classList.toggle('open', formDetails.classList.contains('show'));
});

// ========================================
// Tab switching
// ========================================
tabBar.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const value = tab.dataset.tab;
  if (value === currentTab) return;
  currentTab = value;
  tabBar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  updateTabIndicator();
  renderFilteredTasks();
});

function updateTabIndicator() {
  const tabs = tabBar.querySelectorAll('.tab');
  const idx = [...tabs].findIndex(t => t.classList.contains('active'));
  tabIndicator.style.left = (idx / tabs.length * 100) + '%';
  tabIndicator.style.width = (100 / tabs.length) + '%';
}

// ========================================
// Source chip switching
// ========================================
sourceChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const value = chip.dataset.source;
  if (value === currentSource) return;
  currentSource = value;
  sourceChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  renderFilteredTasks();
});

// ========================================
// Load & render tasks
// ========================================
async function loadConnectionMap() {
  try {
    const connections = await dbGetAllConnections();
    connectionMap = {};
    for (const c of connections) connectionMap[c.id] = c.name;
  } catch (_) {}
}

async function loadTasks() {
  try {
    allTasks = await dbGetAllTasks();
    updateBadges();
    renderFilteredTasks();
  } catch (err) {
    console.error('Failed to load tasks:', err);
  }
}

function updateBadges() {
  const src = currentSource ? allTasks.filter(t => t.source === currentSource) : allTasks;
  badgeAll.textContent = src.length;
  badgeActive.textContent = src.filter(t => !t.completed).length;
  badgeDone.textContent = src.filter(t => t.completed).length;
}

function getFilteredTasks() {
  let tasks = allTasks;
  if (currentSource) tasks = tasks.filter(t => t.source === currentSource);
  if (currentTab === 'active') tasks = tasks.filter(t => !t.completed);
  else if (currentTab === 'done') tasks = tasks.filter(t => t.completed);
  return tasks;
}

function renderFilteredTasks(animateNewIds = null) {
  updateBadges();
  const tasks = getFilteredTasks();
  taskList.innerHTML = '';

  if (tasks.length === 0) { emptyMsg.classList.remove('hidden'); return; }
  emptyMsg.classList.add('hidden');

  for (const task of tasks) {
    const li = document.createElement('li');
    const container = document.createElement('div');
    container.className = 'swipe-container';
    if (animateNewIds && animateNewIds.has(task.id)) container.classList.add('slide-in');

    const bgLeft = document.createElement('div');
    bgLeft.className = 'swipe-bg swipe-bg-left';
    bgLeft.textContent = '削除';
    const bgRight = document.createElement('div');
    bgRight.className = 'swipe-bg swipe-bg-right';
    bgRight.textContent = task.completed ? '戻す' : '完了';

    const item = document.createElement('div');
    item.className = 'task-item' + (task.completed ? ' completed' : '');
    item.dataset.id = task.id;
    const dueDateStr = task.due_date ? formatJPDate(task.due_date) : '';

    item.innerHTML = `
      <div class="checkbox-wrap">
        <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}>
      </div>
      <div class="task-content">
        <div class="task-title">${escapeHtml(task.title)}</div>
        ${renderDescription(task)}
        <div class="task-meta">
          <span class="source-badge ${task.source}">${sourceLabel(task.source)}</span>
          ${dueDateStr ? `<span class="due-date">${dueDateStr}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        <button class="btn-edit" title="編集"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button>
        <button class="btn-delete" title="削除"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
      </div>
    `;

    item.querySelector('.checkbox-wrap').addEventListener('click', (e) => {
      e.preventDefault(); toggleComplete(task, item);
    });
    item.querySelector('.task-content').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const desc = item.querySelector('.task-desc');
      if (desc) desc.classList.toggle('expanded');
    });
    item.querySelector('.btn-edit').addEventListener('click', () => openEdit(task));
    item.querySelector('.btn-delete').addEventListener('click', () => animateDelete(task.id, container, item));
    setupSwipe(item, container, task);

    container.appendChild(bgLeft);
    container.appendChild(bgRight);
    container.appendChild(item);
    li.appendChild(container);
    taskList.appendChild(li);
  }
  lastTaskIds = new Set(tasks.map(t => t.id));
}

// ========================================
// Date formatting
// ========================================
const JP_DAYS = ['日', '月', '火', '水', '木', '金', '土'];
function formatJPDate(dateStr) {
  const p = dateStr.split('-');
  if (p.length !== 3) return dateStr;
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  if (isNaN(d)) return dateStr;
  return `${+p[1]}/${+p[2]}(${JP_DAYS[d.getDay()]})`;
}

// ========================================
// Swipe handling
// ========================================
const SWIPE_THRESHOLD = 80;
function setupSwipe(item, container, task) {
  let startX = 0, startY = 0, currentX = 0, isSwiping = false, isScrolling = false;
  item.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    currentX = 0; isSwiping = false; isScrolling = false;
  }, { passive: true });
  item.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!isSwiping && !isScrolling) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { isScrolling = true; return; }
      if (Math.abs(dx) > 10) { isSwiping = true; item.classList.add('swiping'); }
    }
    if (isScrolling || !isSwiping) return;
    e.preventDefault();
    currentX = dx;
    item.style.transform = `translateX(${Math.sign(dx) * Math.min(Math.abs(dx), 200)}px)`;
    container.querySelector('.swipe-bg-left').style.opacity = dx < -20 ? Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD) : 0;
    container.querySelector('.swipe-bg-right').style.opacity = dx > 20 ? Math.min(1, dx / SWIPE_THRESHOLD) : 0;
  }, { passive: false });
  item.addEventListener('touchend', () => {
    if (!isSwiping) return;
    item.classList.remove('swiping');
    if (currentX < -SWIPE_THRESHOLD) { animateDelete(task.id, container, item); return; }
    if (currentX > SWIPE_THRESHOLD) { item.style.transform = ''; container.querySelector('.swipe-bg-right').style.opacity = 0; toggleComplete(task, item); return; }
    item.style.transform = '';
    container.querySelector('.swipe-bg-left').style.opacity = 0;
    container.querySelector('.swipe-bg-right').style.opacity = 0;
  }, { passive: true });
}

// ========================================
// Task actions
// ========================================
async function toggleComplete(task, itemEl) {
  const newVal = !task.completed;
  await dbUpdateTask(task.id, { completed: newVal });
  if (!task.completed) itemEl.classList.add('flash-complete');
  pushTaskToNotion(task, { completed: newVal });
  setTimeout(() => loadTasks(), 350);
}

function animateDelete(id, container, item) {
  item.classList.add('slide-out-left');
  item.addEventListener('animationend', () => {
    container.classList.add('collapsing');
    container.addEventListener('animationend', () => doDelete(id), { once: true });
  }, { once: true });
}

async function doDelete(id) {
  await dbDeleteTask(id);
  loadTasks();
}

// ========================================
// Add task
// ========================================
taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = taskTitle.value.trim();
  if (!title) return;
  const body = { title };
  if (taskDesc.value.trim()) body.description = taskDesc.value.trim();
  if (taskDue.value) body.due_date = taskDue.value;

  const prevIds = new Set(allTasks.map(t => t.id));
  await dbCreateTask(body);
  taskTitle.value = ''; taskDesc.value = ''; taskDue.value = '';
  formDetails.classList.remove('show'); btnToggle.classList.remove('open');

  allTasks = await dbGetAllTasks();
  const newIds = new Set();
  for (const t of allTasks) { if (!prevIds.has(t.id)) newIds.add(t.id); }
  renderFilteredTasks(newIds);
});

// ========================================
// Edit modal
// ========================================
function openEdit(task) {
  editId.value = task.id;
  editTitle.value = task.title;
  editDue.value = task.due_date || '';
  editModal.classList.remove('hidden');
  if (task.source === 'notion') {
    editDesc.value = '';
    editDesc.placeholder = 'Notionのページ「' + (task.description || '') + '」と連携中';
    editDesc.disabled = true;
  } else {
    editDesc.value = task.description || '';
    editDesc.placeholder = '';
    editDesc.disabled = false;
  }
}

btnCancel.addEventListener('click', () => editModal.classList.add('hidden'));
editModal.addEventListener('click', (e) => { if (e.target === editModal) editModal.classList.add('hidden'); });

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = Number(editId.value);
  const existing = await dbGetTask(id);
  const body = {
    title: editTitle.value.trim(),
    description: editDesc.disabled ? undefined : editDesc.value.trim(),
    due_date: editDue.value || null,
  };
  if (!body.title) return;
  await dbUpdateTask(id, body);
  if (existing) pushTaskToNotion(existing, body);
  editModal.classList.add('hidden');
  loadTasks();
});

// ========================================
// Utility
// ========================================
const SOURCE_LABELS = { local: 'ローカル', google: 'Google', notion: 'Notion' };
function sourceLabel(src) { return SOURCE_LABELS[src] || src; }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderDescription(task) {
  if (task.source === 'notion') {
    const connName = (task.connection_id && connectionMap[task.connection_id]) || '';
    const parts = [];
    if (connName) parts.push('<span class="task-detail-source">' + escapeHtml(connName) + '</span>');
    if (task.description && task.source_url) {
      parts.push('<a href="' + escapeHtml(task.source_url) + '" target="_blank" rel="noopener" class="notion-link"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="link-icon"><path d="M5 1H2.5A1.5 1.5 0 001 2.5v7A1.5 1.5 0 002.5 11h7A1.5 1.5 0 0011 9.5V7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M7 1h4v4M4.5 7.5L11 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + escapeHtml(task.description) + '</a>');
    } else if (task.description) {
      parts.push('<span>' + escapeHtml(task.description) + '</span>');
    }
    if (parts.length === 0) return '';
    return '<div class="task-desc">' + parts.join('') + '</div>';
  }
  if (!task.description) return '';
  return '<div class="task-desc">' + escapeHtml(task.description) + '</div>';
}

// ========================================
// Settings / Connections
// ========================================
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettings = document.getElementById('btn-close-settings');
const notionConnections = document.getElementById('notion-connections');
const btnAddNotion = document.getElementById('btn-add-notion');
const notionForm = document.getElementById('notion-form');
const notionName = document.getElementById('notion-name');
const notionToken = document.getElementById('notion-token');
const notionDbId = document.getElementById('notion-db-id');
const notionTestResult = document.getElementById('notion-test-result');
const btnNotionCancel = document.getElementById('btn-notion-cancel');
const btnNotionTest = document.getElementById('btn-notion-test');
const btnNotionSave = document.getElementById('btn-notion-save');
const corsProxyInput = document.getElementById('cors-proxy-input');
const btnSaveProxy = document.getElementById('btn-save-proxy');
const proxySaveResult = document.getElementById('proxy-save-result');

let connectionsTested = false;

btnSettings.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
  corsProxyInput.value = getCorsProxy();
  loadSettingsConnections();
});
btnCloseSettings.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

function closeSettings() {
  settingsModal.classList.add('hidden');
  resetNotionForm();
}

// CORS Proxy save
btnSaveProxy.addEventListener('click', () => {
  localStorage.setItem('cors_proxy', corsProxyInput.value.trim());
  proxySaveResult.textContent = '保存しました';
  proxySaveResult.className = 'success';
  setTimeout(() => { proxySaveResult.textContent = ''; proxySaveResult.className = ''; }, 2000);
});

async function loadSettingsConnections() {
  try {
    const connections = await dbGetAllConnections();
    renderNotionConnections(connections.filter(c => c.type === 'notion'));
  } catch (err) {
    console.error('Failed to load connections:', err);
  }
}

function maskToken(t) {
  if (!t || t.length < 12) return '***';
  return t.slice(0, 8) + '...' + t.slice(-4);
}

function renderNotionConnections(connections) {
  notionConnections.innerHTML = '';
  for (const conn of connections) {
    const card = document.createElement('div');
    card.className = 'connection-card';
    const lastSynced = conn.last_synced_at || '未同期';
    card.innerHTML = `
      <div class="connection-card-header">
        <div class="connection-card-name"><span>${escapeHtml(conn.name)}</span></div>
        <div class="connection-card-actions">
          <button class="btn-sync" title="同期">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.75 7a5.25 5.25 0 019.03-3.64M12.25 7a5.25 5.25 0 01-9.03 3.64" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.78 1.17v2.19h-2.19M3.22 12.83v-2.19h2.19" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            同期
          </button>
          <button class="btn-conn-delete" title="削除">削除</button>
        </div>
      </div>
      <div class="connection-card-meta">最終同期: ${escapeHtml(lastSynced)}</div>
    `;

    card.querySelector('.btn-sync').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('syncing'); btn.textContent = '同期中...';
      try {
        const r = await syncConnection(conn);
        btn.textContent = r.synced + '件 完了!';
        loadTasks(); loadConnectionMap();
        setTimeout(() => loadSettingsConnections(), 1500);
      } catch (err) {
        btn.textContent = 'エラー';
        console.error(err);
        setTimeout(() => loadSettingsConnections(), 2000);
      }
      btn.classList.remove('syncing');
    });

    card.querySelector('.btn-conn-delete').addEventListener('click', async () => {
      if (!confirm('「' + conn.name + '」の接続を削除しますか？\n関連するタスクも削除されます。')) return;
      const tasks = await dbGetAllTasks({ source: 'notion' });
      for (const t of tasks) {
        if (t.connection_id === conn.id) await dbDeleteTask(t.id);
      }
      await dbDeleteConnection(conn.id);
      loadSettingsConnections();
      loadConnectionMap();
      loadTasks();
    });

    notionConnections.appendChild(card);
  }
}

// Add form
btnAddNotion.addEventListener('click', () => {
  notionForm.classList.remove('hidden');
  btnAddNotion.classList.add('hidden');
  notionName.focus();
});
btnNotionCancel.addEventListener('click', resetNotionForm);

function resetNotionForm() {
  notionForm.classList.add('hidden');
  btnAddNotion.classList.remove('hidden');
  notionName.value = ''; notionToken.value = ''; notionDbId.value = '';
  notionTestResult.textContent = ''; notionTestResult.className = '';
  btnNotionSave.disabled = true; connectionsTested = false;
}

btnNotionTest.addEventListener('click', async () => {
  const token = notionToken.value.trim();
  const dbId = notionDbId.value.trim();
  if (!token || !dbId) {
    notionTestResult.textContent = 'TokenとDatabase IDを入力してください';
    notionTestResult.className = 'error'; return;
  }
  if (!getCorsProxy()) {
    notionTestResult.textContent = 'CORSプロキシURLを先に設定してください（設定画面下部）';
    notionTestResult.className = 'error'; return;
  }
  notionTestResult.textContent = 'テスト中...'; notionTestResult.className = '';
  try {
    const result = await notionTestConnection(token, dbId);
    notionTestResult.textContent = '接続成功! DB: ' + result.title + ' (' + result.properties.length + ' properties)';
    notionTestResult.className = 'success';
    btnNotionSave.disabled = false; connectionsTested = true;
  } catch (err) {
    notionTestResult.textContent = '接続失敗: ' + err.message;
    notionTestResult.className = 'error';
    btnNotionSave.disabled = true; connectionsTested = false;
  }
});

btnNotionSave.addEventListener('click', async () => {
  if (!connectionsTested) return;
  const name = notionName.value.trim() || 'Notion DB';
  const token = notionToken.value.trim();
  const dbId = notionDbId.value.trim();
  await dbCreateConnection({
    type: 'notion', name,
    config: { token, database_id: dbId },
  });
  resetNotionForm();
  loadSettingsConnections();
  loadConnectionMap();
});

// ========================================
// Service Worker
// ========================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW failed:', err));
}

// ========================================
// Init
// ========================================
(async () => {
  await dbOpen();
  await loadConnectionMap();
  await loadTasks();
  updateTabIndicator();

  // Auto sync on load
  syncAllConnections().then(() => {
    loadConnectionMap();
    loadTasks();
  }).catch(() => {});

  // Auto sync every 5 minutes
  setInterval(() => {
    syncAllConnections().then(() => loadTasks()).catch(() => {});
  }, 5 * 60 * 1000);
})();
