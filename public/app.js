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
const CARD_OPTIONS = [1, 2, 4, 8];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ADVANCE = DAY;

const els = {
  stats: document.getElementById('stats'),
  machines: document.getElementById('machines'),
  queueList: document.getElementById('queueList'),
  queueCount: document.getElementById('queueCount'),
  addNode: document.getElementById('addNode'),
  userName: document.getElementById('userName'),
  userAvatar: document.getElementById('userAvatar'),
  switchUser: document.getElementById('switchUser'),
  modalRoot: document.getElementById('modalRoot'),
  toast: document.getElementById('toast'),
};

let state = { machines: [], queue: [], gpuPerMachine: 8, cardChoices: CARD_OPTIONS };
let clockOffset = 0;
let me = localStorage.getItem('gpu.user') || '';
let selectedDuration = 2 * HOUR;
let escHandler = null;
let toastTimer = null;
let polling = false;
let lastSignature = '';

const now = () => Date.now() + clockOffset;

/* --------------------------------- 初始化 --------------------------------- */

(async function init() {
  els.switchUser.addEventListener('click', () => askUser());
  els.addNode.addEventListener('click', () => openAddNode());
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
    applyState(await fetchJson('/state'));
  } catch (err) {
    toast('无法连接服务，请确认服务已启动', 'error');
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    applyState(await fetchJson('/state'));
  } catch (err) {
    /* 网络抖动时保留上一份数据 */
  } finally {
    polling = false;
  }
}

// 数据没有变化时不做任何 DOM 重绘，避免界面周期性闪烁
function applyState(data) {
  clockOffset = data.serverTime - Date.now();
  state = data;
  const signature = JSON.stringify([data.machines, data.queue]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  render();
}

/* ---------------------------------- 渲染 ---------------------------------- */

function gpuStatus(gpu, time) {
  const current = gpu.bookings.find((booking) => booking.startAt <= time && booking.endAt > time) || null;
  const upcoming =
    gpu.bookings
      .filter((booking) => booking.startAt > time)
      .sort((a, b) => a.startAt - b.startAt)[0] || null;
  return { current, upcoming };
}

function freeGpuCount(machine, startAt, endAt) {
  return machine.gpus.filter(
    (gpu) => !gpu.bookings.some((booking) => booking.startAt < endAt && startAt < booking.endAt)
  ).length;
}

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
  const time = now();
  let total = 0;
  let used = 0;
  let reserved = 0;
  for (const machine of state.machines) {
    for (const gpu of machine.gpus) {
      total += 1;
      const { current, upcoming } = gpuStatus(gpu, time);
      if (current) used += 1;
      if (upcoming) reserved += 1;
    }
  }
  const free = total - used;

  els.stats.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">总算力卡</div>
      <div class="stat-value">${total}<small>张</small></div>
      <div class="stat-hint">${state.machines.length} 个推理节点 × ${state.gpuPerMachine || 8} 卡</div>
    </div>
    <div class="stat-card busy">
      <div class="stat-label">占用中</div>
      <div class="stat-value">${used}<small>张</small></div>
      <div class="stat-hint">整体占用率 ${total ? Math.round((used / total) * 100) : 0}%</div>
    </div>
    <div class="stat-card free">
      <div class="stat-label">空闲可用</div>
      <div class="stat-value">${free}<small>张</small></div>
      <div class="stat-hint">支持一次申请 1 / 2 / 4 / 8 张</div>
    </div>
    <div class="stat-card reserved">
      <div class="stat-label">已预约</div>
      <div class="stat-value">${reserved}<small>张</small></div>
      <div class="stat-hint">最多可提前 24 小时预约</div>
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
    els.machines.innerHTML = `
      <div class="empty-state">
        <strong>还没有推理节点</strong>
        <span>点击「新增节点」，录入 IP、密码与机型即可接入，节点编号从 0 开始自动生成。</span>
        <button type="button" class="primary-btn" data-action="add-node">新增节点</button>
      </div>
    `;
    return;
  }

  els.machines.innerHTML = state.machines
    .map((machine) => {
      const time = now();
      let used = 0;
      let reserved = 0;
      for (const gpu of machine.gpus) {
        const status = gpuStatus(gpu, time);
        if (status.current) used += 1;
        else if (status.upcoming) reserved += 1;
      }
      const free = machine.gpus.length - used - reserved;
      const badgeClass = used === 0 ? 'free' : used === machine.gpus.length ? 'full' : 'busy';
      return `
        <article class="machine-card">
          <header class="machine-head">
            <div class="machine-title">
              <h3>${escapeHtml(machine.name)}</h3>
              <p>${escapeHtml(machine.model)} · ${escapeHtml(machine.ip)}</p>
            </div>
            <span class="machine-badge ${badgeClass}">${used} / ${machine.gpus.length} 使用中</span>
          </header>
          <div class="gpu-grid">${machine.gpus.map((gpu) => renderSlot(machine, gpu)).join('')}</div>
          <footer class="machine-foot">
            <span>${free} 卡空闲${reserved ? ` · ${reserved} 卡已预约` : ''} · 到期自动释放</span>
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
  const { current, upcoming } = gpuStatus(gpu, now());

  if (current) {
    const total = Math.max(1, current.endAt - current.startAt);
    const percent = Math.min(100, Math.max(0, ((now() - current.startAt) / total) * 100));
    const mine = current.user === me;
    const groupTag = current.count > 1 ? `<span class="group-tag">×${current.count}</span>` : '';
    const title = `${current.user}${current.note ? '｜' + current.note : ''}｜至 ${fmtClock(current.endAt)}`;
    return `
      <button type="button" class="gpu-slot busy" data-action="detail" data-machine="${machine.id}" data-gpu="${gpu.id}" title="${escapeHtml(title)}">
        <div class="slot-top"><span class="slot-name">卡 ${gpu.id}${groupTag}</span><span class="dot"></span></div>
        <div class="slot-main">${escapeHtml(current.user)}${mine ? '<span class="me-tag">我</span>' : ''}</div>
        <div class="slot-sub timer" data-start="${current.startAt}" data-end="${current.endAt}">剩余 ${fmtRemain(current.endAt - now())}</div>
        <div class="slot-bar"><i style="width:${percent.toFixed(1)}%"></i></div>
      </button>
    `;
  }

  if (upcoming) {
    const mine = upcoming.user === me;
    const title = `${upcoming.user}${upcoming.note ? '｜' + upcoming.note : ''}｜${fmtClock(upcoming.startAt)} 开始`;
    return `
      <button type="button" class="gpu-slot reserved" data-action="detail" data-machine="${machine.id}" data-gpu="${gpu.id}" title="${escapeHtml(title)}">
        <div class="slot-top"><span class="slot-name">卡 ${gpu.id}</span><span class="dot"></span></div>
        <div class="slot-main">已预约</div>
        <div class="slot-sub reserve-wait" data-reserve-start="${upcoming.startAt}">${fmtWait(upcoming.startAt - now())}后开始</div>
        <div class="slot-sub">${escapeHtml(upcoming.user)}${mine ? '<span class="me-tag">我</span>' : ''} · ${fmtClock(upcoming.startAt)}</div>
      </button>
    `;
  }

  return `
    <button type="button" class="gpu-slot free" data-action="book" data-machine="${machine.id}" data-gpu="${gpu.id}">
      <div class="slot-top"><span class="slot-name">卡 ${gpu.id}</span><span class="dot"></span></div>
      <div class="slot-main">空闲</div>
      <div class="slot-sub">点击申请</div>
    </button>
  `;
}

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);

  if (!state.queue.length) {
    els.queueList.innerHTML = `
      <div class="queue-empty">
        当前无人排队
        <span>目标节点被占满时可加入队列等候<br>空闲卡释出后按顺序自动分配</span>
      </div>
    `;
    return;
  }

  els.queueList.innerHTML = state.queue
    .map((entry, index) => {
      const mine = entry.user === me;
      const target =
        entry.machineId === 'any'
          ? `任一节点 · ${entry.gpuCount || 1} 卡`
          : `${machineLabel(entry.machineId)} · ${entry.gpuCount || 1} 卡`;
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

  document.querySelectorAll('.reserve-wait[data-reserve-start]').forEach((el) => {
    const start = Number(el.dataset.reserveStart);
    el.textContent = start > current ? `${fmtWait(start - current)}后开始` : '即将开始';
  });

  document.querySelectorAll('.queue-wait[data-since]').forEach((el) => {
    el.textContent = fmtWait(current - Number(el.dataset.since));
  });
}

/* ---------------------------------- 交互 ---------------------------------- */

function onMachineClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  if (trigger.dataset.action === 'add-node') {
    openAddNode();
    return;
  }
  const machineId = trigger.dataset.machine;
  const gpuIndex = trigger.dataset.gpu != null ? Number(trigger.dataset.gpu) : null;

  if (trigger.dataset.action === 'book') {
    openBooking(machineId, 'occupy', gpuIndex);
  } else if (trigger.dataset.action === 'detail') {
    openCardDetail(machineId, gpuIndex);
  } else if (trigger.dataset.action === 'book-any') {
    const machine = findMachine(machineId);
    if (!machine) return;
    const time = now();
    const hasFree = machine.gpus.some((gpu) => !gpuStatus(gpu, time).current && !gpuStatus(gpu, time).upcoming);
    openBooking(machineId, hasFree ? 'occupy' : 'queue');
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

/* ------------------------------- 申请 / 预约 ------------------------------- */

function openBooking(machineId, mode, presetGpu) {
  if (!me) {
    askUser(() => openBooking(machineId, mode, presetGpu));
    return;
  }
  const machine = findMachine(machineId);
  if (!machine) return;

  const isQueue = mode === 'queue';
  let count = 1;
  let duration = selectedDuration;
  let startMode = 'now';
  let startAt = null;

  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>${isQueue ? '排队等候' : '申请算力卡'}</h3>
          <p>${escapeHtml(machine.name)} · ${escapeHtml(machine.model)} · 共 ${machine.gpus.length} 卡${
            presetGpu != null ? ` · 卡 ${presetGpu}` : ''
          }</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <div class="field">
        <label>申请卡数</label>
        <div class="chips chips-4">
          ${CARD_OPTIONS.map(
            (value) => `<button type="button" class="chip ${value === 1 ? 'active' : ''}" data-count="${value}">${value} 张</button>`
          ).join('')}
        </div>
        <div class="count-hint" id="countHint"></div>
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
      ${
        isQueue
          ? ''
          : `<div class="field">
              <label>开始时间</label>
              <div class="seg" id="startSeg">
                <button type="button" class="seg-btn active" data-start-mode="now">立即开始</button>
                <button type="button" class="seg-btn" data-start-mode="later">预约开始</button>
              </div>
              <div class="custom-row" id="startRow" hidden>
                <input type="datetime-local" id="startAt">
              </div>
              <div class="count-hint">最多可提前 24 小时预约，预约时段与已有占用冲突时无法提交</div>
            </div>`
      }
      <div class="field">
        <label>用途（可选）</label>
        <input type="text" id="bookingNote" maxlength="60" placeholder="例如：LLM 推理压测 · exp-12">
      </div>
      <div class="modal-note">
        ${isQueue
          ? '当前节点没有满足条件的空闲卡，加入队列后系统会在卡片释出时按顺序自动分配。'
          : '占用到期后系统会自动释放该卡；预约占用会在开始时间生效，也可以在卡片详情中提前释放。'}
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>取消</button>
        <button type="button" class="primary-btn" id="confirmBooking">${isQueue ? '加入排队' : '确认申请'}</button>
      </div>
    `,
    {
      onMount(modal) {
        const countChips = Array.from(modal.querySelectorAll('[data-count]'));
        const chips = Array.from(modal.querySelectorAll('[data-ms]'));
        const customInput = modal.querySelector('#customMinutes');
        const countHint = modal.querySelector('#countHint');
        const startRow = modal.querySelector('#startRow');
        const startInput = modal.querySelector('#startAt');
        const startSeg = modal.querySelector('#startSeg');

        if (startInput) {
          startInput.min = toLocalInput(now());
          startInput.max = toLocalInput(now() + MAX_ADVANCE);
        }

        const syncChips = () => {
          chips.forEach((chip) => chip.classList.toggle('active', Number(chip.dataset.ms) === duration));
        };

        const windowRange = () => {
          const start = startMode === 'now' ? now() : startAt || now();
          return { start, end: start + duration };
        };

        const refreshHint = () => {
          const { start, end } = windowRange();
          const available = freeGpuCount(machine, start, end);
          const label = startMode === 'now' ? '当前时段' : `${fmtClock(start)} 起`;
          countHint.textContent =
            available >= count
              ? `${label} 可用 ${available} 张卡，已选 ${count} 张`
              : `${label} 仅有 ${available} 张可用卡，不足 ${count} 张`;
          countHint.classList.toggle('warn', available < count);
        };

        countChips.forEach((chip) => {
          chip.addEventListener('click', () => {
            count = Number(chip.dataset.count);
            countChips.forEach((item) => item.classList.toggle('active', item === chip));
            refreshHint();
          });
        });

        chips.forEach((chip) => {
          chip.addEventListener('click', () => {
            duration = Number(chip.dataset.ms);
            customInput.value = '';
            syncChips();
            refreshHint();
          });
        });

        customInput.addEventListener('input', () => {
          const minutes = Number(customInput.value);
          duration = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : 0;
          chips.forEach((chip) => chip.classList.remove('active'));
          refreshHint();
        });

        if (startSeg) {
          startSeg.querySelectorAll('[data-start-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
              startMode = btn.dataset.startMode;
              startSeg.querySelectorAll('[data-start-mode]').forEach((item) => item.classList.toggle('active', item === btn));
              startRow.hidden = startMode === 'now';
              if (startMode === 'later' && !startInput.value) {
                startInput.value = toLocalInput(now() + HOUR);
              }
              startAt = startInput.value ? new Date(startInput.value).getTime() : null;
              refreshHint();
            });
          });
          startInput.addEventListener('change', () => {
            startAt = startInput.value ? new Date(startInput.value).getTime() : null;
            refreshHint();
          });
        }

        syncChips();
        refreshHint();

        const confirmBtn = modal.querySelector('#confirmBooking');
        confirmBtn.addEventListener('click', async () => {
          if (duration < 5 * 60 * 1000 || duration > 7 * DAY) {
            toast('占用时长需在 5 分钟到 7 天之间', 'error');
            return;
          }
          let payloadStart = null;
          if (!isQueue && startMode === 'later') {
            if (!startAt || !Number.isFinite(startAt)) {
              toast('请选择预约开始时间', 'error');
              return;
            }
            const limit = now() + MAX_ADVANCE;
            if (startAt < now() - 60000 || startAt > limit) {
              toast('最多只能提前 24 小时预约', 'error');
              return;
            }
            payloadStart = startAt;
          }

          confirmBtn.disabled = true;
          confirmBtn.textContent = '提交中…';
          try {
            const payload = {
              user: me,
              machineId,
              count,
              durationMs: duration,
              note: modal.querySelector('#bookingNote').value.trim(),
            };
            if (payloadStart) payload.startAt = payloadStart;
            const result = await fetchJson(isQueue ? '/queue' : '/occupy', payload);
            selectedDuration = duration;
            closeModal();
            if (isQueue && result.booked) {
              toast(`当前有可用卡，已直接分配：${result.machineName} · 卡 ${result.gpuIndexes.join('、')}`);
            } else if (isQueue) {
              toast(`已加入排队，当前第 ${result.position} 位`);
            } else if (payloadStart) {
              toast(`已预约 ${result.machineName} · 卡 ${result.gpuIndexes.join('、')}，${fmtClock(result.startAt)} 开始`);
            } else {
              toast(`已占用 ${result.machineName} · 卡 ${result.gpuIndexes.join('、')}，到期自动释放`);
            }
            poll();
          } catch (err) {
            toast(err.message, 'error');
            confirmBtn.disabled = false;
            confirmBtn.textContent = isQueue ? '加入排队' : '确认申请';
          }
        });
      },
    }
  );
}

/* --------------------------------- 卡片详情 -------------------------------- */

function openCardDetail(machineId, gpuIndex) {
  const machine = findMachine(machineId);
  const gpu = machine && machine.gpus.find((item) => item.id === gpuIndex);
  if (!machine || !gpu) return;
  if (!gpu.bookings.length) {
    openBooking(machineId, 'occupy', gpuIndex);
    return;
  }

  const time = now();
  const { current, upcoming } = gpuStatus(gpu, time);
  const highlight = current || upcoming;
  const mine = gpu.bookings.some((booking) => booking.user === me);
  const schedule = [...gpu.bookings].sort((a, b) => a.startAt - b.startAt);

  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(machine.name)} · 卡 ${gpu.id}</h3>
          <p>${escapeHtml(machine.model)} · ${escapeHtml(machine.ip)}</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <div class="booking-owner">
        <span class="avatar">${escapeHtml(highlight.user.slice(0, 1))}</span>
        <div>
          <strong>${escapeHtml(highlight.user)}${highlight.user === me ? '<span class="me-tag">我</span>' : ''}${
            highlight.count > 1 ? `<span class="group-tag">×${highlight.count}</span>` : ''
          }</strong>
          <small>${escapeHtml(highlight.note || '未填写用途')}</small>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-cell"><span>${current ? '开始时间' : '预约开始'}</span><strong>${fmtClock(highlight.startAt)}</strong></div>
        <div class="detail-cell"><span>自动释放</span><strong>${fmtClock(highlight.endAt)}</strong></div>
        <div class="detail-cell"><span>占用时长</span><strong>${fmtDuration(highlight.endAt - highlight.startAt)}</strong></div>
        <div class="detail-cell"><span>${current ? '剩余时间' : '还有'}</span><strong>${
          current
            ? `<span class="timer" data-start="${highlight.startAt}" data-end="${highlight.endAt}">剩余 ${fmtRemain(highlight.endAt - time)}</span>`
            : fmtWait(highlight.startAt - time)
        }</strong></div>
      </div>
      <div class="schedule">
        <div class="schedule-title">该卡排期</div>
        ${schedule
          .map(
            (booking) => `
          <div class="schedule-item ${booking.startAt <= time && booking.endAt > time ? 'now' : ''}">
            <span class="schedule-time">${fmtClock(booking.startAt)} → ${fmtClock(booking.endAt)}</span>
            <span class="schedule-user">${escapeHtml(booking.user)}${booking.user === me ? '（我）' : ''}</span>
            <span class="schedule-note">${booking.count > 1 ? `同组 ${booking.count} 卡` : '单卡'}</span>
          </div>`
          )
          .join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>关闭</button>
        ${
          mine
            ? '<button type="button" class="danger-btn" id="releaseBtn">释放我的占用</button>'
            : '<button type="button" class="primary-btn" id="queueBtn">排队等候</button>'
        }
      </div>
    `,
    {
      onMount(modal) {
        const releaseBtn = modal.querySelector('#releaseBtn');
        if (releaseBtn) releaseBtn.addEventListener('click', () => openReleaseConfirm(machine, gpu, highlight));

        const queueBtn = modal.querySelector('#queueBtn');
        if (queueBtn) queueBtn.addEventListener('click', () => openBooking(machineId, 'queue'));
      },
    }
  );
}

function openReleaseConfirm(machine, gpu, booking) {
  const scope = booking.count > 1 ? `整组 ${booking.count} 张卡` : `卡 ${gpu.id}`;
  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>确认释放？</h3>
          <p>${escapeHtml(machine.name)} · ${scope}</p>
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
            const result = await fetchJson('/release', { user: me, machineId: machine.id, gpuIndex: gpu.id });
            closeModal();
            toast(result.released > 1 ? `已释放 ${result.released} 张卡` : `已释放 ${machine.name} · 卡 ${gpu.id}`);
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

/* --------------------------------- 新增节点 -------------------------------- */

function openAddNode() {
  if (!me) {
    askUser(() => openAddNode());
    return;
  }
  const nextIndex = nextNodeIndex();

  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>新增推理节点</h3>
          <p>节点编号自动分配：推理节点 ${nextIndex} · 每节点 ${state.gpuPerMachine || 8} 卡</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <div class="field">
        <label>节点 IP</label>
        <input type="text" id="nodeIp" maxlength="64" placeholder="例如：192.168.1.20">
      </div>
      <div class="field">
        <label>登录密码</label>
        <input type="password" id="nodePassword" maxlength="64" placeholder="节点登录密码">
      </div>
      <div class="field">
        <label>机型</label>
        <input type="text" id="nodeModel" maxlength="40" placeholder="例如：Ascend 910B / NVIDIA A100">
      </div>
      <div class="modal-note">密码仅保存在服务端，不会通过接口返回给前端。</div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>取消</button>
        <button type="button" class="primary-btn" id="confirmNode">确认新增</button>
      </div>
    `,
    {
      onMount(modal) {
        const ipInput = modal.querySelector('#nodeIp');
        const pwdInput = modal.querySelector('#nodePassword');
        const modelInput = modal.querySelector('#nodeModel');
        ipInput.focus();

        const confirmBtn = modal.querySelector('#confirmNode');
        confirmBtn.addEventListener('click', async () => {
          const ip = ipInput.value.trim();
          const password = pwdInput.value.trim();
          const model = modelInput.value.trim();
          if (!ip) {
            toast('请填写节点 IP', 'error');
            ipInput.focus();
            return;
          }
          if (!password) {
            toast('请填写节点登录密码', 'error');
            pwdInput.focus();
            return;
          }
          if (!model) {
            toast('请填写机型', 'error');
            modelInput.focus();
            return;
          }
          confirmBtn.disabled = true;
          confirmBtn.textContent = '提交中…';
          try {
            const result = await fetchJson('/machines', { ip, password, model });
            closeModal();
            toast(`已新增 ${result.machine.name}（${result.machine.ip}）`);
            poll();
          } catch (err) {
            toast(err.message, 'error');
            confirmBtn.disabled = false;
            confirmBtn.textContent = '确认新增';
          }
        });
      },
    }
  );
}

function nextNodeIndex() {
  const used = new Set(state.machines.map((machine) => machine.index));
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
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

function toLocalInput(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`;
}
