'use strict';

const API_BASE = '/api';
const DURATION_OPTIONS = [
  { label: '30 min', ms: 30 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '2 hour', ms: 2 * 60 * 60 * 1000 },
  { label: '4 hour', ms: 4 * 60 * 60 * 1000 },
  { label: '8 hour', ms: 8 * 60 * 60 * 1000 },
  { label: '12 hour', ms: 12 * 60 * 60 * 1000 },
  { label: '24 hour', ms: 24 * 60 * 60 * 1000 },
  { label: '48 hour', ms: 48 * 60 * 60 * 1000 },
];
const CARD_OPTIONS = [1, 2, 4, 8];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_MAX_ADVANCE = 2 * DAY;
const MIN_DURATION = 5 * 60 * 1000;
const MAX_DURATION = 2 * DAY;

const els = {
  stats: document.getElementById('stats'),
  machines: document.getElementById('machines'),
  addNode: document.getElementById('addNode'),
  userName: document.getElementById('userName'),
  userAvatar: document.getElementById('userAvatar'),
  switchUser: document.getElementById('switchUser'),
  modalRoot: document.getElementById('modalRoot'),
  toast: document.getElementById('toast'),
};

let state = { machines: [], gpuPerMachine: 8, cardChoices: CARD_OPTIONS, maxAdvance: DEFAULT_MAX_ADVANCE };
let clockOffset = 0;
let me = localStorage.getItem('gpu.user') || '';
// 释放凭证：groupId → token，只保存在申请时的这个浏览器里
let ownedTokens = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('gpu.tokens') || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    return {};
  }
})();
const BASE_TITLE = document.title;
let selectedDuration = 2 * HOUR;
let escHandler = null;
let toastTimer = null;
let polling = false;
let lastSignature = '';
const REMIND_BEFORE = 10 * 60 * 1000;
const reminded = new Set();
let titleTimer = null;
// 节点卡片内嵌申请面板的草稿状态
let draft = null;

const now = () => Date.now() + clockOffset;
const maxAdvance = () => state.maxAdvance || DEFAULT_MAX_ADVANCE;

// 时间轴以「今天 0:00」为左边界，跨过 24:00 自动切到新的一天
function todayStart() {
  const date = new Date(now());
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/* ------------------------------- 释放凭证 ------------------------------- */

function rememberOwner(id, token) {
  if (!id || !token) return;
  ownedTokens[id] = token;
  try {
    localStorage.setItem('gpu.tokens', JSON.stringify(ownedTokens));
  } catch (err) {
    /* 存储不可用时仅当前会话有效 */
  }
}

function ownerTokenOf(id) {
  return (id && ownedTokens[id]) || '';
}

// 带凭证的记录只认凭证；早期没有凭证的记录退回按姓名判断
function isMine(record) {
  if (!record) return false;
  if (ownerTokenOf(record.groupId || record.id)) return true;
  return !record.claimed && record.user === me;
}

/* --------------------------------- 初始化 --------------------------------- */

(async function init() {
  els.addNode.addEventListener('click', () => openAddNode());
  els.machines.addEventListener('click', onMachineClick);
  els.modalRoot.addEventListener('click', onPanelClick);
  els.modalRoot.addEventListener('input', onPanelInput);
  els.modalRoot.addEventListener('change', onPanelChange);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      stopTitleBlink();
      poll();
    }
  });
  window.addEventListener('focus', stopTitleBlink);

  await loadState();
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
  // 把「今天」也算进签名，0 点一到就重绘时间轴，无需等数据变化
  const signature = JSON.stringify([data.machines, todayStart()]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  render();
  // 数据变化时只刷新弹层内容，不重建页面其余部分
  if (draft) refreshApplyModal();
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

function isGpuFreeIn(gpu, startAt, endAt) {
  return !gpu.bookings.some((booking) => booking.startAt < endAt && startAt < booking.endAt);
}

function draftWindow() {
  const start = draft.startMode === 'later' && draft.startAt ? draft.startAt : now();
  return { start, end: start + (draft.durationMs || 0) };
}

function render() {
  renderUser();
  renderStats();
  renderMachines();
  tick();
}

function renderUser() {
  if (!els.userName) return;
  els.userName.textContent = me || '未登录';
  els.userAvatar.textContent = me ? me.slice(0, 1) : '–';
}

function renderStats() {
  const time = now();
  let total = 0;
  let used = 0;
  let todaySegments = 0;
  let todayCards = 0;
  for (const machine of state.machines) {
    for (const gpu of machine.gpus) {
      total += 1;
      if (gpuStatus(gpu, time).current) used += 1;
    }
    const summary = todaySummary(machine);
    todaySegments += summary.groups;
    todayCards += summary.cards;
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
      <div class="stat-hint">未预约的空档支持直接占用</div>
    </div>
    <div class="stat-card reserved">
      <div class="stat-label">今日预约</div>
      <div class="stat-value">${todaySegments}<small>段</small></div>
      <div class="stat-hint">共 ${todayCards} 卡次 · 可提前 48 小时预约</div>
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
        <article class="machine-row" data-machine-id="${machine.id}">
          <div class="machine-side">
            <header class="machine-head">
              <div class="machine-title">
                <h3>${escapeHtml(machine.name)}</h3>
                <p>${escapeHtml(machine.model)} · ${escapeHtml(machine.ip)}</p>
              </div>
              <span class="machine-badge ${badgeClass}">${used} / ${machine.gpus.length} 使用中</span>
            </header>
            <div class="gpu-grid">${machine.gpus.map((gpu) => renderSlot(machine, gpu)).join('')}</div>
            <footer class="machine-foot">
              <span>${free} 卡空闲${reserved ? ` · ${reserved} 卡已预约` : ''} · 到点自动释放</span>
              <button type="button" class="mini-btn" data-action="book-any" data-machine="${machine.id}">
                预约 / 占用
              </button>
            </footer>
          </div>
          ${renderTimeline(machine)}
        </article>
      `;
    })
    .join('');
}

/* ------------------------------ 当天预约时间轴 ------------------------------ */

function fmtHM(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 同一个人固定同一色相，方便一眼看出「谁占了多久」；色相取自一组彼此拉开距离的值
const PERSON_HUES = [196, 22, 268, 142, 332, 48, 218, 96, 306, 12, 176, 240];
const hueAssign = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('gpu.hues') || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    return {};
  }
})();

// 新出现的人优先拿还没被占用的色相，避免两个人撞色
function personHue(name) {
  const key = String(name);
  const known = hueAssign[key];
  if (Number.isInteger(known)) return PERSON_HUES[known % PERSON_HUES.length];
  const used = new Set(Object.values(hueAssign).map((index) => index % PERSON_HUES.length));
  let slot = PERSON_HUES.findIndex((_, index) => !used.has(index));
  if (slot === -1) slot = Object.keys(hueAssign).length % PERSON_HUES.length;
  hueAssign[key] = slot;
  try {
    localStorage.setItem('gpu.hues', JSON.stringify(hueAssign));
  } catch (err) {
    /* 存储不可用时仅当前会话有效 */
  }
  return PERSON_HUES[slot];
}

// 当天时间窗内的预约统计：几组（段）、几张卡次
function todaySummary(machine) {
  const dayStart = todayStart();
  const dayEnd = dayStart + DAY;
  const groups = new Set();
  let cards = 0;
  for (const gpu of machine.gpus) {
    for (const booking of gpu.bookings) {
      if (booking.endAt <= dayStart || booking.startAt >= dayEnd) continue;
      groups.add(booking.groupId || booking.id);
      cards += 1;
    }
  }
  return { groups: groups.size, cards };
}

// 逐卡展开当天预约：一张卡一行，方便直接看出“哪张卡、从几点到几点”
function gpuLanes(machine) {
  const dayStart = todayStart();
  const dayEnd = dayStart + DAY;
  let total = 0;
  const lanes = machine.gpus.map((gpu) => {
    const items = gpu.bookings
      .filter((booking) => booking.endAt > dayStart && booking.startAt < dayEnd)
      .sort((a, b) => a.startAt - b.startAt)
      .map((booking) => {
        total += 1;
        return {
          id: booking.groupId || booking.id,
          user: booking.user,
          note: booking.note || '',
          claimed: Boolean(booking.claimed),
          count: booking.count || 1,
          startAt: booking.startAt,
          endAt: booking.endAt,
        };
      });
    return { gpuId: gpu.id, items };
  });
  return { dayStart, dayEnd, lanes, total };
}

function renderTimeline(machine) {
  const { dayStart, dayEnd, lanes, total } = gpuLanes(machine);
  const time = now();
  const nowLeft = Math.min(100, Math.max(0, ((time - dayStart) / DAY) * 100));
  const date = new Date(dayStart);
  const dateLabel = `${date.getMonth() + 1}月${pad(date.getDate())}日 ${WEEKDAYS[date.getDay()]}`;

  const ruler = Array.from({ length: 9 }, (_, i) => i * 3)
    .map((hour) => {
      const align = hour === 0 ? 'start' : hour === 24 ? 'end' : 'mid';
      return `<span class="tl-tick ${align}" style="left:${(hour / 24) * 100}%">${pad(hour)}:00</span>`;
    })
    .join('');

  const rowLabels = lanes
    .map((lane) => `<span class="tl-gpu-label">卡 ${lane.gpuId}</span>`)
    .join('');

  const rows = lanes
    .map((lane) => {
      const bars = lane.items
        .map((seg) => {
          const clipStart = Math.max(seg.startAt, dayStart);
          const clipEnd = Math.min(seg.endAt, dayEnd);
          const left = ((clipStart - dayStart) / DAY) * 100;
          const width = Math.max(0.6, ((clipEnd - clipStart) / DAY) * 100);
          const running = seg.startAt <= time && seg.endAt > time;
          const past = seg.endAt <= time;
          const mine = isMine({ groupId: seg.id, claimed: seg.claimed, user: seg.user });
          const range = `${seg.startAt < dayStart ? '…' : ''}${fmtHM(clipStart)}–${fmtHM(
            clipEnd
          )}${seg.endAt > dayEnd ? '…' : ''}`;
          // 窄条放不下文字时逐级收敛：先去掉时间，再只留色块，完整信息走 title
          const hours = (clipEnd - clipStart) / HOUR;
          const compact = hours < 4 ? ' compact' : '';
          const tiny = hours < 1 ? ' tiny' : '';
          const title = `${seg.user}${seg.note ? '｜' + seg.note : ''}｜${range}｜${
            seg.count > 1 ? `同组 ${seg.count} 卡` : '单卡'
          }`;
          return `
            <button type="button" class="tl-bar${running ? ' running' : ''}${past ? ' past' : ''}${
            mine ? ' mine' : ''
          }${compact}${tiny}" style="left:${left.toFixed(3)}%;width:${width.toFixed(
            3
          )}%;--h:${personHue(seg.user)}" data-action="group" data-machine="${
            machine.id
          }" data-group="${escapeHtml(seg.id)}" title="${escapeHtml(title)}">
              <span class="tl-bar-name">${escapeHtml(seg.user)}${mine ? '<i class="me-tag">我</i>' : ''}</span>
              <span class="tl-bar-meta">×${seg.count} · ${range}</span>
            </button>`;
        })
        .join('');
      return `<div class="tl-lane">${bars}</div>`;
    })
    .join('');

  return `
    <div class="machine-tl">
      <header class="tl-head">
        <div>
          <h4>今日预约</h4>
          <p>${dateLabel} · 00:00 – 24:00 · 现在 ${fmtHM(time)}</p>
        </div>
        <span class="tl-count">${total ? `${total} 条 · 每行一张卡` : '今日空闲'}</span>
      </header>
      <div class="tl-scroll">
        <div class="tl-chart">
          <span class="tl-gutter-head"></span>
          <div class="tl-ruler">${ruler}</div>
          <div class="tl-gutter">${rowLabels}</div>
          <div class="tl-lanes">
            ${rows}
            ${total ? '' : '<div class="tl-empty">今天还没有预约，空档可直接点击左侧空闲卡占用</div>'}
            <div class="tl-now" style="left:${nowLeft.toFixed(3)}%"></div>
          </div>
        </div>
      </div>
      <footer class="tl-foot">
        <span class="tl-legend">每行一张卡，条形长度即占用时段；灰色为已过期，点击条形可查看整组详情</span>
        <span class="tl-tip">每天 24:00 自动刷新当天预约</span>
      </footer>
    </div>
  `;
}


function renderSlot(machine, gpu) {
  const { current, upcoming } = gpuStatus(gpu, now());

  if (current) {
    const total = Math.max(1, current.endAt - current.startAt);
    const percent = Math.min(100, Math.max(0, ((now() - current.startAt) / total) * 100));
    const mine = isMine(current);
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
    const mine = isMine(upcoming);
    const title = `${upcoming.user}${upcoming.note ? '｜' + upcoming.note : ''}｜${fmtClock(upcoming.startAt)} 开始`;
    return `
      <button type="button" class="gpu-slot reserved" data-action="detail" data-machine="${machine.id}" data-gpu="${gpu.id}" title="${escapeHtml(title)}">
        <div class="slot-top"><span class="slot-name">卡 ${gpu.id}</span><span class="dot"></span></div>
        <div class="slot-main">已预约</div>
        <div class="slot-sub reserve-wait" data-reserve-start="${upcoming.startAt}">${fmtWait(upcoming.startAt - now())}后开始</div>
        <div class="slot-sub">${escapeHtml(upcoming.user)}${mine ? '<span class="me-tag">我</span>' : ''}</div>
      </button>
    `;
  }

  return `
    <button type="button" class="gpu-slot free" data-action="book" data-machine="${machine.id}" data-gpu="${gpu.id}" title="点击申请这张卡">
      <div class="slot-top"><span class="slot-name">卡 ${gpu.id}</span><span class="dot"></span></div>
      <div class="slot-main">空闲</div>
    </button>
  `;
}

/* ------------------------------ 内嵌申请面板 ------------------------------ */

function renderApplyPanel(machine) {
  const { start, end } = draftWindow();
  const freeIds = new Set(
    machine.gpus.filter((gpu) => isGpuFreeIn(gpu, start, end)).map((gpu) => gpu.id)
  );
  // 时间窗变化后自动剔除已不可用的卡
  draft.gpuIds = draft.gpuIds.filter((id) => freeIds.has(id));
  const selected = new Set(draft.gpuIds);

  const tiles = machine.gpus
    .map((gpu) => {
      const conflict = gpu.bookings
        .filter((booking) => booking.startAt < end && start < booking.endAt)
        .sort((a, b) => a.startAt - b.startAt)[0];

      if (conflict) {
        const running = conflict.startAt <= start && conflict.endAt > start;
        const title = `${conflict.user}｜${fmtClock(conflict.startAt)} → ${fmtClock(conflict.endAt)}`;
        return `
          <div class="pick-card locked" title="${escapeHtml(title)}">
            <span class="pick-name">卡 ${gpu.id}</span>
            <span class="pick-main">${escapeHtml(conflict.user)}</span>
            <span class="pick-sub${running ? ' timer' : ''}" ${
              running ? `data-start="${conflict.startAt}" data-end="${conflict.endAt}" data-compact="1"` : ''
            } title="${escapeHtml(title)}">${running ? fmtRemain(conflict.endAt - now()) : `${fmtClock(conflict.startAt)} 起`}</span>
          </div>
        `;
      }

      const picked = selected.has(gpu.id);
      return `
        <button type="button" class="pick-card ${picked ? 'picked' : 'free'}" data-action="pick-gpu"
          data-machine="${machine.id}" data-gpu="${gpu.id}" aria-pressed="${picked}">
          <span class="pick-name">卡 ${gpu.id}</span>
          <span class="pick-main">${picked ? '已选择' : '空闲'}</span>
          <span class="pick-sub">${picked ? '点击取消' : '点击选择'}</span>
        </button>
      `;
    })
    .join('');

  const startLabel = draft.startMode === 'later' ? (draft.startAt ? `${fmtWhen(draft.startAt)} 起` : '待选择开始时间') : '立即开始';
  const endLabel = draft.durationMs > 0 ? `${fmtWhen(start + draft.durationMs)} 自动释放` : '未设置时长';
  const summary = draft.gpuIds.length
    ? `已选 ${draft.gpuIds.length} 张 · 卡 ${draft.gpuIds.join('、')} · ${startLabel}，${endLabel}`
    : `该时段可用 ${freeIds.size} 张卡，请在上方点选具体卡`;

  return `
    <section class="apply-panel" data-panel="${machine.id}">
      <div class="apply-head">
        <div>
          <h4>申请算力卡 <span class="apply-pill">${draft.gpuIds.length} / ${freeIds.size} 已选</span></h4>
          <div class="apply-user-row">
            <span class="apply-user-label">申请人</span>
            <input type="text" id="draftUser" maxlength="20" autocomplete="off"
              value="${escapeHtml(draft.user || '')}" placeholder="填写你的姓名，作为占用人">
          </div>
          <p>${escapeHtml(machine.name)} · 点选卡位后确认申请</p>
        </div>
        <button type="button" class="icon-btn" data-action="apply-close" aria-label="收起申请面板">×</button>
      </div>
      <div class="apply-label-row">
        <span class="apply-label">可用卡 <em>${escapeHtml(startLabel)} · ${escapeHtml(
          draft.durationMs > 0 ? fmtDuration(draft.durationMs) : '未设置时长'
        )}</em></span>
        <div class="quick-counts">
          ${CARD_OPTIONS.map(
            (value) => `
            <button type="button" class="count-chip ${draft.gpuIds.length === value ? 'active' : ''}"
              data-action="draft-count" data-count="${value}">${value} 张</button>`
          ).join('')}
        </div>
      </div>
      <div class="pick-grid">${tiles}</div>
      <div class="apply-grid">
        <div class="apply-field">
          <label>占用时长</label>
          <div class="chips chips-duration">
            ${DURATION_OPTIONS.map(
              (option) => `
              <button type="button" class="chip ${option.ms === draft.durationMs ? 'active' : ''}"
                data-action="draft-duration" data-ms="${option.ms}">${option.label}</button>`
            ).join('')}
          </div>
          <div class="custom-row">
            <input type="number" id="draftMinutes" min="5" max="2880"
              value="${escapeHtml(draft.customMinutes)}" placeholder="自定义">
            <span>min（5 ~ 2880）</span>
          </div>
        </div>
        <div class="apply-field">
          <label>开始时间</label>
          <div class="seg">
            <button type="button" class="seg-btn ${draft.startMode === 'now' ? 'active' : ''}"
              data-action="draft-start-mode" data-mode="now">立即开始</button>
            <button type="button" class="seg-btn ${draft.startMode === 'later' ? 'active' : ''}"
              data-action="draft-start-mode" data-mode="later">预约开始</button>
          </div>
          <div class="custom-row" ${draft.startMode === 'later' ? '' : 'hidden'}>
            <button type="button" class="time-trigger" data-action="open-time-picker">
              <span class="time-trigger-value">${draft.startAt ? fmtWhen(draft.startAt) : '选择开始时间'}</span>
              <span class="time-trigger-hint">滑动选择</span>
            </button>
          </div>
        </div>
      </div>
      <div class="apply-field">
        <label>用途（可选）</label>
        <input type="text" id="draftNote" maxlength="60" value="${escapeHtml(draft.note)}"
          placeholder="例如：LLM 推理压测 · exp-12">
      </div>
      <div class="apply-foot">
        <div class="apply-summary ${draft.gpuIds.length ? '' : 'warn'}">${escapeHtml(summary)}</div>
        <div class="apply-actions">
          <button type="button" class="ghost-btn small" data-action="apply-close">取消</button>
          <button type="button" class="primary-btn small" data-action="apply-submit"
            ${draft.gpuIds.length ? '' : 'disabled'}>确认申请</button>
        </div>
      </div>
    </section>
  `;
}

function openApply(machineId, presetGpu) {
  const machine = findMachine(machineId);
  if (!machine) return;

  const time = now();
  const durationMs = selectedDuration;
  let gpuIds = [];

  if (presetGpu != null) {
    const gpu = machine.gpus.find((item) => item.id === presetGpu);
    if (gpu && isGpuFreeIn(gpu, time, time + durationMs)) gpuIds = [presetGpu];
  }

  draft = {
    machineId,
    gpuIds,
    user: me,
    durationMs,
    startMode: 'now',
    startAt: time + HOUR,
    note: '',
    customMinutes: '',
  };
  openApplyModal();
}

/* 申请面板：独立二级弹层，背景高斯模糊 */
function openApplyModal() {
  const machine = findMachine(draft.machineId);
  if (!machine) return;
  closeModal();
  els.modalRoot.innerHTML = `
    <div class="modal-backdrop apply-backdrop">
      <section class="modal apply-modal" role="dialog" aria-modal="true">${renderApplyPanel(machine)}</section>
    </div>`;
  const backdrop = els.modalRoot.firstElementChild;
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeApply();
  });
  escHandler = (event) => {
    if (event.key !== 'Escape') return;
    if (els.modalRoot.querySelector('.wheel-backdrop')) {
      closeTimePicker();
      return;
    }
    closeApply();
  };
  document.addEventListener('keydown', escHandler);
}

// 只重建弹层内部，页面其余部分保持不变，避免整屏闪烁
function refreshApplyModal() {
  const modal = els.modalRoot.querySelector('.apply-modal');
  if (!modal || !draft) return;
  const machine = findMachine(draft.machineId);
  if (!machine) {
    closeApply();
    return;
  }
  const active = document.activeElement;
  const focusId = active && active.id && modal.contains(active) ? active.id : '';
  const selStart = focusId && 'selectionStart' in active ? active.selectionStart : null;
  const selEnd = focusId && 'selectionEnd' in active ? active.selectionEnd : null;
  modal.innerHTML = renderApplyPanel(machine);
  if (focusId) {
    const next = modal.querySelector(`#${focusId}`);
    if (next) {
      next.focus();
      if (selStart != null) {
        try {
          next.setSelectionRange(selStart, selEnd);
        } catch (err) {
          /* number 类型的 input 不支持 setSelectionRange，忽略 */
        }
      }
    }
  }
}

function closeApply() {
  draft = null;
  closeModal();
}

/* ---------------------- 开始时间滑轮选择（可拖动、自动吸附） ---------------------- */

const WHEEL_ITEM = 40;
const MINUTE_STEP = 5;
let pickerDates = [];

function wheelDates() {
  const first = new Date(now());
  first.setHours(0, 0, 0, 0);
  const last = new Date(now() + maxAdvance());
  last.setHours(0, 0, 0, 0);
  const list = [];
  for (let time = first.getTime(); time <= last.getTime(); time += DAY) list.push(time);
  return list;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 预约时间统一写成「11月04日 周三 16:10」，避免 11-04 这种缩写看不懂
function fmtWhen(timestamp) {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${pad(date.getDate())}日 ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function wheelDateLabel(timestamp) {
  const today = new Date(now());
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((timestamp - today.getTime()) / DAY);
  const date = new Date(timestamp);
  const text = `${date.getMonth() + 1}月${pad(date.getDate())}日`;
  if (diff === 0) return `今天 · ${text}`;
  if (diff === 1) return `明天 · ${text}`;
  if (diff === 2) return `后天 · ${text}`;
  return `${text} ${WEEKDAYS[date.getDay()]}`;
}

function renderWheelColumn(key, items, index) {
  return `
    <div class="wheel" data-wheel="${key}" data-index="${index}">
      ${items
        .map((text, i) => `<div class="wheel-item${i === index ? ' active' : ''}" data-index="${i}">${text}</div>`)
        .join('')}
    </div>`;
}

function openTimePicker() {
  if (!draft) return;
  closeTimePicker();

  pickerDates = wheelDates();
  const hours = Array.from({ length: 24 }, (_, i) => pad(i));
  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => pad(i * MINUTE_STEP));

  const base = new Date(draft.startAt && draft.startAt > now() ? draft.startAt : now());
  const dayStart = new Date(base);
  dayStart.setHours(0, 0, 0, 0);
  const dateIndex = Math.max(0, pickerDates.indexOf(dayStart.getTime()));
  const hourIndex = base.getHours();
  const minuteIndex = Math.min(minutes.length - 1, Math.round(base.getMinutes() / MINUTE_STEP));

  els.modalRoot.insertAdjacentHTML(
    'beforeend',
    `
    <div class="wheel-backdrop">
      <section class="wheel-sheet" role="dialog" aria-label="选择开始时间">
        <header class="wheel-head">
          <div>
            <h4>选择开始时间</h4>
            <p data-wheel-preview></p>
          </div>
          <button type="button" class="icon-btn" data-wheel-close aria-label="关闭">×</button>
        </header>
        <div class="wheel-labels" aria-hidden="true">
          <span>日期</span><span>小时</span><span>分钟</span>
        </div>
        <div class="wheel-body">
          <div class="wheel-band" aria-hidden="true"></div>
          <div class="wheel-cols">
            ${renderWheelColumn('date', pickerDates.map(wheelDateLabel), dateIndex)}
            ${renderWheelColumn('hour', hours, hourIndex)}
            ${renderWheelColumn('minute', minutes, minuteIndex)}
          </div>
        </div>
        <footer class="wheel-foot">
          <span class="wheel-tip">最多可提前 48 小时</span>
          <div class="wheel-actions">
            <button type="button" class="ghost-btn small" data-wheel-close>取消</button>
            <button type="button" class="primary-btn small" data-wheel-confirm>确定</button>
          </div>
        </footer>
      </section>
    </div>`
  );

  const backdrop = els.modalRoot.querySelector('.wheel-backdrop');
  const sheet = backdrop.querySelector('.wheel-sheet');
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeTimePicker();
  });
  backdrop.querySelectorAll('[data-wheel-close]').forEach((btn) => {
    btn.addEventListener('click', closeTimePicker);
  });
  backdrop.querySelector('[data-wheel-confirm]').addEventListener('click', confirmTimePicker);

  // 初始定位到当前值，直接落位不做动画
  sheet.querySelectorAll('.wheel').forEach((wheel) => {
    wheel.scrollTop = Number(wheel.dataset.index) * WHEEL_ITEM;
    bindWheel(wheel, updatePickerPreview);
  });
  updatePickerPreview();
}

function closeTimePicker() {
  const backdrop = els.modalRoot.querySelector('.wheel-backdrop');
  if (backdrop) backdrop.remove();
}

function pickerValue() {
  const sheet = els.modalRoot.querySelector('.wheel-sheet');
  if (!sheet || !pickerDates.length) return null;
  const pick = (key) => sheet.querySelector(`[data-wheel="${key}"]`);
  const dateIndex = Number(pick('date').dataset.index) || 0;
  const hour = Number(pick('hour').dataset.index) || 0;
  const minute = (Number(pick('minute').dataset.index) || 0) * MINUTE_STEP;
  const day = pickerDates[Math.max(0, Math.min(pickerDates.length - 1, dateIndex))];
  return day + hour * HOUR + minute * 60000;
}

function updatePickerPreview() {
  const preview = els.modalRoot.querySelector('[data-wheel-preview]');
  const value = pickerValue();
  if (preview) preview.textContent = value ? `${fmtWhen(value)} 开始` : '';
}

function confirmTimePicker() {
  if (!draft) return;
  const value = pickerValue();
  if (!value) return closeTimePicker();
  // 超出「当前时刻 ~ 48 小时后」时夹到边界，避免白选
  draft.startAt = Math.min(now() + maxAdvance(), Math.max(now(), value));
  closeTimePicker();
  refreshApplyModal();
}

// 滚动高亮 + 鼠标拖动跟手 + 松手吸附（触屏交给原生惯性滚动）
function bindWheel(wheel, onChange) {
  const items = Array.from(wheel.querySelectorAll('.wheel-item'));
  const currentIndex = () =>
    Math.max(0, Math.min(items.length - 1, Math.round(wheel.scrollTop / WHEEL_ITEM)));

  let frame = 0;
  const paint = () => {
    frame = 0;
    const index = currentIndex();
    items.forEach((item, i) => item.classList.toggle('active', i === index));
    if (wheel.dataset.index !== String(index)) {
      wheel.dataset.index = String(index);
      onChange();
    }
  };
  wheel.addEventListener(
    'scroll',
    () => {
      if (!frame) frame = requestAnimationFrame(paint);
    },
    { passive: true }
  );

  let dragging = false;
  let moved = false;
  let startY = 0;
  let startTop = 0;

  wheel.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    dragging = true;
    moved = false;
    startY = event.clientY;
    startTop = wheel.scrollTop;
    wheel.classList.add('dragging');
    wheel.setPointerCapture(event.pointerId);
  });

  wheel.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const offset = event.clientY - startY;
    if (Math.abs(offset) > 3) moved = true;
    wheel.scrollTop = startTop - offset;
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    wheel.classList.remove('dragging');
    try {
      wheel.releasePointerCapture(event.pointerId);
    } catch (err) {
      /* 指针已释放 */
    }
    wheel.scrollTo({ top: currentIndex() * WHEEL_ITEM, behavior: 'smooth' });
  };
  wheel.addEventListener('pointerup', endDrag);
  wheel.addEventListener('pointercancel', endDrag);

  items.forEach((item, index) => {
    item.addEventListener('click', () => {
      if (moved) return; // 拖动结束后不误触发点击
      wheel.scrollTo({ top: index * WHEEL_ITEM, behavior: 'smooth' });
    });
  });
}

function onPanelClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger || !draft) return;
  const action = trigger.dataset.action;

  if (action === 'apply-close') {
    closeApply();
    return;
  }
  if (action === 'apply-submit') {
    submitDraft();
    return;
  }
  if (action === 'pick-gpu') {
    const gpuId = Number(trigger.dataset.gpu);
    draft.gpuIds = draft.gpuIds.includes(gpuId)
      ? draft.gpuIds.filter((id) => id !== gpuId)
      : [...draft.gpuIds, gpuId].sort((a, b) => a - b);
    refreshApplyModal();
    return;
  }
  if (action === 'draft-count') {
    applyQuickCount(Number(trigger.dataset.count));
    return;
  }
  if (action === 'draft-duration') {
    draft.durationMs = Number(trigger.dataset.ms);
    draft.customMinutes = '';
    refreshApplyModal();
    return;
  }
  if (action === 'draft-start-mode') {
    draft.startMode = trigger.dataset.mode;
    // 与滑轮 5 分钟刻度对齐，避免入口时间和抽屉选中项差几分钟
    if (draft.startMode === 'later') {
      const step = MINUTE_STEP * 60 * 1000;
      const base = draft.startAt > now() ? draft.startAt : now() + HOUR;
      draft.startAt = Math.ceil(base / step) * step;
    }
    refreshApplyModal();
    return;
  }
  if (action === 'open-time-picker') {
    openTimePicker();
  }
}

function applyQuickCount(count) {
  if (!draft) return;
  const machine = findMachine(draft.machineId);
  if (!machine) return;

  const { start, end } = draftWindow();
  const freeIds = machine.gpus.filter((gpu) => isGpuFreeIn(gpu, start, end)).map((gpu) => gpu.id);
  if (!freeIds.length) {
    toast('该时段没有可用卡，请调整开始时间或卡数', 'error');
    return;
  }

  const freeSet = new Set(freeIds);
  // 保留用户已点选的卡，再向两侧补齐成连续区间
  const kept = draft.gpuIds.filter((id) => freeSet.has(id)).sort((a, b) => a - b);
  if (kept.length >= count) {
    draft.gpuIds = kept.slice(0, count);
    refreshApplyModal();
    return;
  }

  if (!kept.length) {
    const ids = machine.gpus.map((gpu) => gpu.id);
    let block = null;
    for (let i = 0; i + count <= ids.length; i += 1) {
      const slice = ids.slice(i, i + count);
      if (slice.every((id) => freeSet.has(id))) {
        block = slice;
        break;
      }
    }
    if (!block) block = freeIds.slice(0, count);
    if (block.length < count) toast(`该时段仅有 ${freeIds.length} 张可用卡`);
    draft.gpuIds = block.slice().sort((a, b) => a - b);
    refreshApplyModal();
    return;
  }

  const chosen = kept.slice();
  let left = kept[0];
  let right = kept[kept.length - 1];
  while (chosen.length < count && (freeSet.has(left - 1) || freeSet.has(right + 1))) {
    if (freeSet.has(left - 1)) {
      left -= 1;
      chosen.push(left);
    }
    if (chosen.length < count && freeSet.has(right + 1)) {
      right += 1;
      chosen.push(right);
    }
  }
  for (const id of freeIds) {
    if (chosen.length >= count) break;
    if (!chosen.includes(id)) chosen.push(id);
  }

  if (chosen.length < count) toast(`该时段仅有 ${freeIds.length} 张可用卡`);
  draft.gpuIds = chosen.sort((a, b) => a - b);
  refreshApplyModal();
}

function onPanelInput(event) {
  if (!draft) return;
  if (event.target.id === 'draftUser') {
    draft.user = event.target.value;
    return;
  }
  if (event.target.id === 'draftNote') draft.note = event.target.value;
  if (event.target.id === 'draftMinutes') draft.customMinutes = event.target.value;
}

function onPanelChange(event) {
  if (!draft) return;

  if (event.target.id === 'draftMinutes') {
    const minutes = Number(event.target.value);
    if (Number.isFinite(minutes) && minutes > 0) {
      draft.durationMs = Math.round(minutes * 60000);
      draft.customMinutes = event.target.value;
    }
    refreshApplyModal();
    return;
  }
}

async function submitDraft() {
  if (!draft) return;
  const user = String(draft.user || '').trim();
  if (!user) {
    toast('请填写申请人姓名', 'error');
    const input = els.modalRoot.querySelector('#draftUser');
    if (input) input.focus();
    return;
  }
  if (!draft.gpuIds.length) {
    toast('请至少选择一张卡', 'error');
    return;
  }
  if (!(draft.durationMs >= MIN_DURATION && draft.durationMs <= MAX_DURATION)) {
    toast('占用时长需在 5 分钟到 48 小时之间', 'error');
    return;
  }

  let startAt = null;
  if (draft.startMode === 'later') {
    if (!draft.startAt || !Number.isFinite(draft.startAt)) {
      toast('请选择预约开始时间', 'error');
      return;
    }
    if (draft.startAt < now() - 60000 || draft.startAt > now() + maxAdvance()) {
      toast('最多只能提前 48 小时预约', 'error');
      return;
    }
    startAt = draft.startAt;
  }

  const payload = {
    user,
    machineId: draft.machineId,
    gpuIndexes: draft.gpuIds.slice(),
    durationMs: draft.durationMs,
    note: draft.note.trim(),
  };
  if (startAt) payload.startAt = startAt;

  const btn = els.modalRoot.querySelector('[data-action="apply-submit"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '提交中…';
  }

  try {
    const result = await fetchJson('/occupy', payload);
    rememberOwner(result.groupId, result.ownerToken);
    askNotifyPermission();
    selectedDuration = draft.durationMs;
    me = user;
    localStorage.setItem('gpu.user', user);
    closeApply();
    toast(
      startAt
        ? `已预约 ${result.machineName} · 卡 ${result.gpuIndexes.join('、')}，${fmtClock(result.startAt)} 开始`
        : `已占用 ${result.machineName} · 卡 ${result.gpuIndexes.join('、')}，到期自动释放`
    );
    lastSignature = '';
    await loadState();
  } catch (err) {
    toast(err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '确认申请';
    }
    lastSignature = '';
    await loadState();
  }
}

function tick() {
  const current = now();

  document.querySelectorAll('.timer[data-end]').forEach((el) => {
    const end = Number(el.dataset.end);
    const start = Number(el.dataset.start);
    const remaining = end - current;
    const label = el.dataset.compact ? fmtRemain(remaining) : `剩余 ${fmtRemain(remaining)}`;
    el.textContent = remaining > 0 ? label : '正在释放…';

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

  checkReminders(current);
}

/* ------------------------------- 到期提醒 ------------------------------- */

// 只提醒自己名下的卡：剩余 10 分钟、剩余 1 分钟各一次
function checkReminders(time) {
  let pending = false;
  for (const machine of state.machines) {
    for (const gpu of machine.gpus) {
      const booking = gpu.bookings.find((item) => item.startAt <= time && item.endAt > time);
      if (!booking || !isMine(booking)) continue;
      const left = booking.endAt - time;
      const stage = left <= 60 * 1000 ? 1 : left <= REMIND_BEFORE ? 10 : 0;
      if (!stage) continue;
      pending = true;
      const key = `${booking.groupId || booking.id}:${stage}`;
      if (reminded.has(key)) continue;
      reminded.add(key);
      remindExpiring(machine, gpu, booking, stage);
    }
  }
  // 卡已释放或已到期后停止闪烁，避免标题一直闪
  if (!pending) stopTitleBlink();
}

function remindExpiring(machine, gpu, booking, stage) {
  const span = booking.count > 1 ? `同组 ${booking.count} 张卡` : `卡 ${gpu.id}`;
  const when = stage === 1 ? '不到 1 分钟' : '不到 10 分钟';
  const text = `${machine.name} · ${span} ${when}后到期，${fmtClock(booking.endAt)} 自动释放`;
  toast(text, 'warn');
  startTitleBlink(`⚠️ 算力卡 ${when}内到期`);
  sendNotification('算力卡即将到期', text);
}

function askNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (err) {
    /* 浏览器不支持时只用标题闪烁 */
  }
}

function sendNotification(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(title, { body, tag: 'gpu-expiring' });
  } catch (err) {
    /* 忽略通知失败 */
  }
}

function startTitleBlink(text) {
  if (titleTimer) return;
  let on = true;
  document.title = text;
  titleTimer = setInterval(() => {
    on = !on;
    document.title = on ? text : BASE_TITLE;
  }, 900);
}

function stopTitleBlink() {
  if (!titleTimer) return;
  clearInterval(titleTimer);
  titleTimer = null;
  document.title = BASE_TITLE;
}

/* ---------------------------------- 交互 ---------------------------------- */

function onMachineClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;

  if (action === 'add-node') {
    openAddNode();
    return;
  }

  const machineId = trigger.dataset.machine;
  const gpuIndex = trigger.dataset.gpu != null ? Number(trigger.dataset.gpu) : null;

  if (action === 'book') {
    openApply(machineId, gpuIndex);
  } else if (action === 'detail') {
    openCardDetail(machineId, gpuIndex);
  } else if (action === 'group') {
    openGroupDetail(machineId, trigger.dataset.group);
  } else if (action === 'book-any') {
    openApply(machineId, null);
  }
}

function askUser(onSaved) {
  const dismissible = Boolean(me);
  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>填写使用人</h3>
          <p>用于预约、占用与释放算力卡的身份标识</p>
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

/* --------------------------------- 卡片详情 -------------------------------- */

function openCardDetail(machineId, gpuIndex) {
  const machine = findMachine(machineId);
  const gpu = machine && machine.gpus.find((item) => item.id === gpuIndex);
  if (!machine || !gpu) return;
  if (!gpu.bookings.length) {
    openApply(machineId, gpuIndex);
    return;
  }

  const time = now();
  const { current, upcoming } = gpuStatus(gpu, time);
  const highlight = current || upcoming;
  // 只有持有释放凭证（或早期无凭证记录且姓名一致）才显示释放入口
  const mine = isMine(highlight);
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
          <strong>${escapeHtml(highlight.user)}${mine ? '<span class="me-tag">我</span>' : ''}${
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
            <span class="schedule-user">${escapeHtml(booking.user)}${isMine(booking) ? '（我）' : ''}</span>
            <span class="schedule-note">${booking.count > 1 ? `同组 ${booking.count} 卡` : '单卡'}</span>
          </div>`
          )
          .join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>关闭</button>
        ${
          mine
            ? '<button type="button" class="danger-btn" id="releaseBtn">释放这次占用</button>'
            : '<button type="button" class="primary-btn" id="reserveBtn">预约其他时段</button>'
        }
      </div>
    `,
    {
      onMount(modal) {
        const releaseBtn = modal.querySelector('#releaseBtn');
        if (releaseBtn) releaseBtn.addEventListener('click', () => openReleaseConfirm(machine, gpu, highlight));

        const reserveBtn = modal.querySelector('#reserveBtn');
        if (reserveBtn)
          reserveBtn.addEventListener('click', () => {
            closeModal();
            openApply(machineId, null);
          });
      },
    }
  );
}

// 时间轴上的条形：按整组预约查看详情，可直接释放
function openGroupDetail(machineId, groupId) {
  const machine = findMachine(machineId);
  if (!machine) return;
  // 按 groupId 在逐卡行里回收这一组占用的卡号
  const { lanes } = gpuLanes(machine);
  const gpus = [];
  let seg = null;
  for (const lane of lanes) {
    const hit = lane.items.find((item) => item.id === groupId);
    if (!hit) continue;
    gpus.push(lane.gpuId);
    if (!seg) seg = hit;
  }
  if (!seg) return;
  seg.gpus = gpus.sort((a, b) => a - b);

  const time = now();
  const running = seg.startAt <= time && seg.endAt > time;
  const mine = isMine({ groupId: seg.id, claimed: seg.claimed, user: seg.user });

  openModal(
    `
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(machine.name)} · ${seg.count} 卡预约</h3>
          <p>${fmtWhen(seg.startAt)} → ${fmtWhen(seg.endAt)}</p>
        </div>
        <button type="button" class="icon-btn" data-close>×</button>
      </div>
      <div class="booking-owner">
        <span class="avatar">${escapeHtml(seg.user.slice(0, 1))}</span>
        <div>
          <strong>${escapeHtml(seg.user)}${mine ? '<span class="me-tag">我</span>' : ''}</strong>
          <small>${escapeHtml(seg.note || '未填写用途')}</small>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-cell"><span>占用卡</span><strong>卡 ${seg.gpus.join('、')}</strong></div>
        <div class="detail-cell"><span>时长</span><strong>${fmtDuration(seg.endAt - seg.startAt)}</strong></div>
        <div class="detail-cell"><span>开始</span><strong>${fmtClock(seg.startAt)}</strong></div>
        <div class="detail-cell"><span>${running ? '剩余时间' : '还有'}</span><strong>${
          running
            ? `<span class="timer" data-start="${seg.startAt}" data-end="${seg.endAt}">剩余 ${fmtRemain(
                seg.endAt - time
              )}</span>`
            : fmtWait(seg.startAt - time)
        }</strong></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-close>关闭</button>
        ${
          mine
            ? '<button type="button" class="danger-btn" id="releaseGroupBtn">释放这组预约</button>'
            : '<button type="button" class="primary-btn" data-close>知道了</button>'
        }
      </div>
    `,
    {
      onMount(modal) {
        const btn = modal.querySelector('#releaseGroupBtn');
        if (!btn) return;
        btn.addEventListener('click', () =>
          openReleaseConfirm(machine, { id: seg.gpus[0] }, {
            groupId: seg.id,
            count: seg.count,
            gpuId: seg.gpus[0],
          })
        );
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
      <p class="confirm-text">释放后这些卡立即回到空闲池，其他人可以预约或直接占用，此操作不可撤销。</p>
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
            const result = await fetchJson('/release', {
              user: me,
              machineId: machine.id,
              gpuIndex: gpu.id,
              groupId: booking.groupId || '',
              token: ownerTokenOf(booking.groupId),
            });
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
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`;
}
