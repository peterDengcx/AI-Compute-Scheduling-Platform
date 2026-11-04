'use strict';

const API_BASE = '/api';
const DURATION_OPTIONS = [
  { label: '30 分钟', ms: 30 * 60 * 1000 },
  { label: '1 小时', ms: 60 * 60 * 1000 },
  { label: '2 小时', ms: 2 * 60 * 60 * 1000 },
  { label: '4 小时', ms: 4 * 60 * 60 * 1000 },
  { label: '8 小时', ms: 8 * 60 * 60 * 1000 },
  { label: '12 小时', ms: 12 * 60 * 60 * 1000 },
  { label: '24 小时', ms: 24 * 60 * 60 * 1000 },
];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const els = {
  stats: document.getElementById('stats'),
  machines: document.getElementById('machines'),
  queueList: document.getElementById('queueList'),
  queueCount: document.getElementById('queueCount'),
  userName: document.getElementById('userName'),
  userAvatar: document.getElementById('userAvatar'),
  switchUser: document.getElementById('switchUser'),
  modalRoot: document.getElementById('modalRoot'),
  toast: document.getElementById('toast'),
};

let state = { machines: [], queue: [], gpuPerMachine: 8 };
let clockOffset = 0;
let me = localStorage.getItem('gpu.user') || '';
let selectedDuration = 2 * HOUR;
let escHandler = null;
let toastTimer = null;
let polling = false;

const now = () => Date.now() + clockOffset;

/* --------------------------------- 初始化 --------------------------------- */

(async function init() {
  els.switchUser.addEventListener('click', () => askUser());
  els.machines.addEventListener('click', onMachineClick);
  els.queueList.addEventListener('click', onQueueClick);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });

  await loadState();
  if (!me) askUser();
  setInterval(poll, 2500);
  setInterval(tick, 1000);
})();

async function loadState() {
  try {
    const data = await fetchJson('/state');
    clockOffset = data.serverTime - Date.now();
    state = data;
    render();
  } catch (err) {
    toast('无法连接服务，请确认服务已启动', 'error');
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const data = await fetchJson('/state');
    clockOffset = data.serverTime - Date.now();
    state = data;
    render();
  } catch (err) {
    /* 网络抖动时保留上一份数据 */
  } finally {
    polling = false;
  }
}

/* ---------------------------------- 渲染 ---------------------------------- */

function render() {
  renderUser();
  renderStats();
  renderMachines();
  renderQueue();
  tick();
}

function renderUser() {
  els.userName.textContent = me || '未登录';
  els.userAvatar.textContent = me ? me.slice(0, 1) : '–';
}

function renderStats() {
  const total = state.machines.reduce((sum, machine) => sum + machine.gpus.length, 0);
  const used = state.machines.reduce(
    (sum, machine) => sum + machine.gpus.filter((gpu) => gpu.booking).length,
    0
  );
  const free = total - used;
  const rate = total ? Math.round((used / total) * 100) : 0;

  els.stats.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">总算力卡</div>
      <div class="stat-value">${total}<small>张</small></div>
      <div class="stat-hint">${state.machines.length} 台机器 × ${state.gpuPerMachine || 8} 卡</div>
    </div>
    <div class="stat-card busy">
      <div class="stat-label">占用中</div>
      <div class="stat-value">${used}<small>张</small></div>
      <div class="stat-hint">整体占用率 ${rate}%</div>
    </div>
    <div class="stat-card free">
      <div class="stat-label">空闲可用</div>
      <div class="stat-value">${free}<small>张</small></div>
      <div class="stat-hint">点击卡片即可直接占用</div>
    </div>
    <div class="stat-card queue">
      <div class="stat-label">排队中</div>
      <div class="stat-value">${state.queue.length}<small>人</small></div>
      <div class="stat-hint">空闲卡释出后自动分配</div>
    </div>
  `;
}

function renderMachines() {
  if (!state.machines.length) {
    els.machines.innerHTML = '<div class="queue-empty">暂无机器数据</div>';
    return;
  }

  els.machines.innerHTML = state.machines
    .map((machine) => {
      const used = machine.gpus.filter((gpu) => gpu.booking).length;
      const free = machine.gpus.length - used;
      const badgeClass = used === 0 ? 'free' : used === machine.gpus.length ? 'full' : 'busy';
      return `
        <article class="machine-card">
          <header class="machine-head">
            <div class="machine-title">
              <h3>${escapeHtml(machine.name)}</h3>
              <p>${escapeHtml(machine.model)} · ${escapeHtml(machine.spec)}</p>
            </div>
            <span class="machine-badge ${badgeClass}">${used} / ${machine.gpus.length} 使用中</span>
          </header>
          <div class="gpu-grid">${machine.gpus.map((gpu) => renderSlot(machine, gpu)).join('')}</div>
          <footer class="machine-foot">
            <span>${free} 卡空闲 · 到期自动释放</span>
            <button type="button" class="mini-btn" data-action="book-any" data-machine="${machine.id}">
              ${free > 0 ? '申请空闲卡' : '排队等候'}
            </button>
          </footer>
        </article>
      `;
    })
    .join('');
}

function renderSlot(machine, gpu) {
  const booking = gpu.booking;
  if (!booking) {
    return `
      <button type="button" class="gpu-slot free" data-action="book" data-machine="${machine.id}" data-gpu="${gpu.id}">
        <div class="slot-top"><span class="slot-name">卡 ${gpu.id}</span><span class="dot"></span></div>
        <div class="slot-main">空闲</div>
        <div class="slot-sub">点击申请</div>
      </button>
    `;
  }

  const total = Math.max(1, booking.endAt - booking.startAt);
  const percent = Math.min(100, Math.max(0, ((now() - booking.startAt) / total) * 100));
  const mine = booking.user === me;
  const title = `${booking.user}${booking.note ? '｜' + booking.note : ''}｜至 ${fmtClock(booking.endAt)}`;

  return `
    <button type="button" class="gpu-slot busy" data-action="detail" data-machine="${machine.id}" data-gpu="${gpu.id}" title="${escapeHtml(title)}">
      <div class="slot-top"><span class="slot-name">卡 ${gpu.id}</span><span class="dot"></span></div>
      <div class="slot-main">${escapeHtml(booking.user)}${mine ? '<span class="me-tag">我</span>' : ''}</div>
      <div class="slot-sub timer" data-start="${booking.startAt}" data-end="${booking.endAt}">剩余 ${fmtRemain(booking.endAt - now())}</div>
      <div class="slot-bar"><i style="width:${percent.toFixed(1)}%"></i></div>
    </button>
  `;
}

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);

  if (!state.queue.length) {
    els.queueList.innerHTML = `
      <div class="queue-empty">
        当前无人排队
        <span>目标卡被占用时可加入队列等候<br>空闲卡释出后按顺序自动分配</span>
      </div>
    `;
    return;
  }

  els.queueList.innerHTML = state.queue
    .map((entry, index) => {
      const mine = entry.user === me;
      const target =
        entry.machineId === 'any'
          ? '任一机器 · 任一空闲卡'
          : `${machineLabel(entry.machineId)} · ${entry.gpuIndex == null ? '任一空闲卡' : `卡 ${entry.gpuIndex}`}`;
      return `
        <div class="queue-item ${mine ? 'mine' : ''}">
          <span class="rank">${index + 1}</span>
          <div class="queue-info">
            <div class="queue-user">${escapeHtml(entry.user)}${mine ? '<span class="me-tag">我</span>' : ''}</div>
            <div class="queue-target" title="${escapeHtml(target)}">${escapeHtml(target)}</div>
            <div class="queue-meta">${fmtDuration(entry.durationMs)} · 已等 <span class="queue-wait" data-since="${entry.createdAt}">${fmtWait(now() - entry.createdAt)}</span></div>
          </div>
          ${mine ? `<button type="button" class="link-btn" data-cancel-queue="${entry.id}">取消</button>` : ''}
        </div>
      `;
    })
    .join('');
}

function tick() {
  const current = now();

  document.querySelectorAll('.timer[data-end]').forEach((el) => {
    const end = Number(el.dataset.end);
    const start = Number(el.dataset.start);
    const remaining = end - current;
    el.textContent = remaining > 0 ? `剩余 ${fmtRemain(remaining)}` : '正在释放…';

    const host = el.closest('.gpu-slot');
    if (host) {
      host.classList.toggle('soon', remaining > 0 && remaining < 10 * 60 * 1000);
      const bar = host.querySelector('.slot-bar > i');
      if (bar && start) {
        const percent = Math.min(100, Math.max(0, ((current - start) / (end - start)) * 100));
        bar.style.width = `${percent.toFixed(1)}%`;
      }
    }
  });

  document.querySelectorAll('.queue-wait[data-since]').forEach((el) => {
    el.textContent = fmtWait(current - Number(el.dataset.since));
  });
}

/* ---------------------------------- 交互 ---------------------------------- */

function onMachineClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const machineId = trigger.dataset.machine;
  const gpuIndex = trigger.dataset.gpu != null ? Number(trigger.dataset.gpu) : null;

  if (trigger.dataset.action === 'book') {
    openBooking(machineId, gpuIndex, 'occupy');
  } else if (trigger.dataset.action === 'detail') {
    openCardDetail(machineId, gpuIndex);
  } else if (trigger.dataset.action === 'book-any') {
    const machine = findMachine(machineId);
    const freeGpu = machine && machine.gpus.find((gpu) => !gpu.booking);
    if (freeGpu) openBooking(machineId, freeGpu.id, 'occupy');
    else openBooking(machineId, null, 'queue');
  }
}

async function onQueueClick(event) {
  const btn = event.target.closest('[data-cancel-queue]');
  if (!btn) return;
  if (!me) {
    askUser(() => cancelQueue(btn.dataset.cancelQueue));
    return;
  }
  await cancelQueue(btn.dataset.cancelQueue);
}

async function cancelQueue(id) {
  try {
    await fetchJson('/queue/cancel', { user: me, id });
    toast('已取消排队');
    await poll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function askUser(onSaved) {
  const dismissible = Boolean(me);
  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>填写使用人</h3>
          <p>用于申请、排队与释放算力卡的身份标识</p>
        </div>
        ${dismissible ? '<button type="button" class="icon-btn" data-close>×</button>' : ''}
      </div>
      <div class="field">
        <label>姓名 / 工号</label>
        <input type="text" id="userInput" maxlength="20" placeholder="例如：李哲" value="${escapeHtml(me)}">
      </div>
      <div class="modal-actions">
        ${dismissible ? '<button type="button" class="ghost-btn" data-close>取消</button>' : ''}
        <button type="button" class="primary-btn" id="saveUser">进入调度台</button>
      </div>
    `,
    {
      dismissible,
      onMount(modal) {
        const input = modal.querySelector('#userInput');
        input.focus();
        const submit = () => {
          const name = input.value.trim();
          if (!name) {
            toast('请输入姓名或工号', 'error');
            input.focus();
            return;
          }
          me = name;
          localStorage.setItem('gpu.user', name);
          closeModal();
          render();
          toast(`当前使用人：${name}`);
          if (onSaved) {
            const callback = onSaved;
            onSaved = null;
            callback();
          }
        };
        modal.querySelector('#saveUser').addEventListener('click', submit);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') submit();
        });
      },
    }
  );
}

function openBooking(machineId, gpuIndex, mode) {
  if (!me) {
    askUser(() => openBooking(machineId, gpuIndex, mode));
    return;
  }
  const machine = findMachine(machineId);
  if (!machine) return;

  const isQueue = mode === 'queue';
  const target = gpuIndex == null ? `${machine.name} · 任一空闲卡` : `${machine.name} · 卡 ${gpuIndex}`;
  let duration = selectedDuration;

  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>${isQueue ? '排队等候' : '申请占用'}</h3>
          <p>${escapeHtml(target)}</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <div class="field">
        <label>占用时长</label>
        <div class="chips">
          ${DURATION_OPTIONS.map((option) => `<button type="button" class="chip" data-ms="${option.ms}">${option.label}</button>`).join('')}
        </div>
        <div class="custom-row">
          <input type="number" id="customMinutes" min="5" max="10080" placeholder="自定义分钟">
          <span>分钟（5 分钟 ~ 7 天）</span>
        </div>
      </div>
      <div class="field">
        <label>用途（可选）</label>
        <input type="text" id="bookingNote" maxlength="60" placeholder="例如：LLM 微调 · exp-12">
      </div>
      <div class="modal-note">
        占用到期后系统会自动释放该卡${isQueue ? '；有空闲卡释出时按排队顺序自动分配' : ''}，也可以在卡片详情中提前释放。
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>取消</button>
        <button type="button" class="primary-btn" id="confirmBooking">${isQueue ? '加入排队' : '确认占用'}</button>
      </div>
    `,
    {
      onMount(modal) {
        const chips = Array.from(modal.querySelectorAll('.chip'));
        const customInput = modal.querySelector('#customMinutes');
        const syncChips = () => {
          chips.forEach((chip) => chip.classList.toggle('active', Number(chip.dataset.ms) === duration));
        };

        chips.forEach((chip) => {
          chip.addEventListener('click', () => {
            duration = Number(chip.dataset.ms);
            customInput.value = '';
            syncChips();
          });
        });

        customInput.addEventListener('input', () => {
          const minutes = Number(customInput.value);
          duration = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : 0;
          chips.forEach((chip) => chip.classList.remove('active'));
        });

        syncChips();

        const confirmBtn = modal.querySelector('#confirmBooking');
        confirmBtn.addEventListener('click', async () => {
          if (duration < 5 * 60 * 1000 || duration > 7 * DAY) {
            toast('占用时长需在 5 分钟到 7 天之间', 'error');
            return;
          }
          confirmBtn.disabled = true;
          confirmBtn.textContent = '提交中…';
          try {
            const payload = {
              user: me,
              machineId,
              gpuIndex,
              durationMs: duration,
              note: modal.querySelector('#bookingNote').value.trim(),
            };
            const result = await fetchJson(isQueue ? '/queue' : '/occupy', payload);
            selectedDuration = duration;
            closeModal();
            if (isQueue && result.booked) {
              toast(`当前有空闲卡，已直接分配：${machine.name} · 卡 ${result.gpuIndex}`);
            } else if (isQueue) {
              toast(`已加入排队，当前第 ${result.position} 位`);
            } else {
              toast(`已占用 ${machine.name} · 卡 ${gpuIndex}，到期自动释放`);
            }
            poll();
          } catch (err) {
            toast(err.message, 'error');
            confirmBtn.disabled = false;
            confirmBtn.textContent = isQueue ? '加入排队' : '确认占用';
          }
        });
      },
    }
  );
}

function openCardDetail(machineId, gpuIndex) {
  const machine = findMachine(machineId);
  const gpu = machine && machine.gpus.find((item) => item.id === gpuIndex);
  if (!machine || !gpu) return;

  const booking = gpu.booking;
  if (!booking) {
    openBooking(machineId, gpuIndex, 'occupy');
    return;
  }

  const mine = booking.user === me;
  const total = Math.max(1, booking.endAt - booking.startAt);
  const percent = Math.min(100, Math.max(0, ((now() - booking.startAt) / total) * 100));

  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(machine.name)} · 卡 ${gpu.id}</h3>
          <p>${escapeHtml(machine.model)} · ${escapeHtml(machine.spec)}</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <div class="booking-owner">
        <span class="avatar">${escapeHtml(booking.user.slice(0, 1))}</span>
        <div>
          <strong>${escapeHtml(booking.user)}${mine ? '<span class="me-tag">我</span>' : ''}</strong>
          <small>${escapeHtml(booking.note || '未填写用途')}</small>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-cell"><span>开始时间</span><strong>${fmtClock(booking.startAt)}</strong></div>
        <div class="detail-cell"><span>自动释放</span><strong>${fmtClock(booking.endAt)}</strong></div>
        <div class="detail-cell"><span>占用时长</span><strong>${fmtDuration(total)}</strong></div>
        <div class="detail-cell"><span>剩余时间</span><strong class="timer" data-start="${booking.startAt}" data-end="${booking.endAt}">剩余 ${fmtRemain(booking.endAt - now())}</strong></div>
      </div>
      <div class="detail-progress"><i style="width:${percent.toFixed(1)}%"></i></div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>关闭</button>
        ${
          mine
            ? '<button type="button" class="danger-btn" id="releaseBtn">提前释放</button>'
            : '<button type="button" class="primary-btn" id="queueBtn">排队等候此卡</button>'
        }
      </div>
    `,
    {
      onMount(modal) {
        const releaseBtn = modal.querySelector('#releaseBtn');
        if (releaseBtn) releaseBtn.addEventListener('click', () => openReleaseConfirm(machine, gpu));

        const queueBtn = modal.querySelector('#queueBtn');
        if (queueBtn) queueBtn.addEventListener('click', () => openBooking(machineId, gpuIndex, 'queue'));
      },
    }
  );
}

function openReleaseConfirm(machine, gpu) {
  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>提前释放该卡？</h3>
          <p>${escapeHtml(machine.name)} · 卡 ${gpu.id}</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <p class="confirm-text">释放后该卡立即回到空闲池，排队中的用户会按顺序自动获得，此操作不可撤销。</p>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>取消</button>
        <button type="button" class="danger-btn" id="confirmRelease">确认释放</button>
      </div>
    `,
    {
      onMount(modal) {
        const btn = modal.querySelector('#confirmRelease');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await fetchJson('/release', { user: me, machineId: machine.id, gpuIndex: gpu.id });
            closeModal();
            toast(`已释放 ${machine.name} · 卡 ${gpu.id}`);
            poll();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        });
      },
    }
  );
}

/* ---------------------------------- 弹窗 ---------------------------------- */

function openModal(html, options = {}) {
  const { dismissible = true, onMount } = options;
  closeModal();

  els.modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = els.modalRoot.firstElementChild;

  if (dismissible) {
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeModal();
    });
    els.modalRoot.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', closeModal);
    });
    escHandler = (event) => {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', escHandler);
  }

  if (onMount) onMount(els.modalRoot.querySelector('.modal'));
}

function closeModal() {
  els.modalRoot.innerHTML = '';
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

function toast(message, type = 'success') {
  els.toast.textContent = message;
  els.toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, 2800);
}

/* --------------------------------- 工具函数 -------------------------------- */

async function fetchJson(pathname, body) {
  const response = await fetch(API_BASE + pathname, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    /* 忽略非 JSON 响应 */
  }
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function findMachine(machineId) {
  return state.machines.find((machine) => machine.id === machineId);
}

function machineLabel(machineId) {
  const machine = findMachine(machineId);
  return machine ? machine.name : machineId;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function fmtRemain(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} 天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function fmtClock(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtDuration(ms) {
  if (ms >= DAY && ms % DAY === 0) return `${ms / DAY} 天`;
  if (ms >= HOUR) {
    const hours = ms / HOUR;
    return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`;
  }
  return `${Math.round(ms / 60000)} 分钟`;
}

function fmtWait(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
