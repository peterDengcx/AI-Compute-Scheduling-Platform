'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const GPU_PER_MACHINE = 8;
const MIN_DURATION = 5 * 60 * 1000;
const MAX_DURATION = 7 * 24 * 60 * 60 * 1000;
const MAX_NOTE = 60;

const MACHINE_DEFS = [
  { id: 'm1', name: '训练节点 A', model: 'Ascend 910B', spec: '8 × 64GB HBM · 800G IB' },
  { id: 'm2', name: '训练节点 B', model: 'Ascend 910B', spec: '8 × 64GB HBM · 800G IB' },
  { id: 'm3', name: '推理节点 C', model: 'Ascend 910B', spec: '8 × 64GB HBM · 200G RoCE' },
  { id: 'm4', name: '推理节点 D', model: 'NVIDIA A100', spec: '8 × 80GB HBM · 200G RoCE' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------------------------------- 状态 ---------------------------------- */

function buildFreshState() {
  const now = Date.now();
  const machines = MACHINE_DEFS.map((def) => ({
    ...def,
    gpus: Array.from({ length: GPU_PER_MACHINE }, (_, i) => ({ id: i, booking: null })),
  }));

  // 首次启动时写入少量演示占用，便于直接看到倒计时与排队效果
  const demos = [
    ['m1', 0, '李哲', 78, 42, 'LLM 微调 · exp-12'],
    ['m1', 1, '王雨', 25, 190, '多模态预训练'],
    ['m2', 5, '陈默', 51, 9, '推理压测 · 批次 07'],
    ['m3', 2, '周然', 120, 420, '强化学习训练'],
    ['m3', 3, '林一', 35, 105, '算子精度回归'],
  ];
  for (const [machineId, gpuIndex, user, startMinAgo, endMinAhead, note] of demos) {
    const machine = machines.find((m) => m.id === machineId);
    machine.gpus[gpuIndex].booking = {
      id: crypto.randomUUID(),
      user,
      note,
      startAt: now - startMinAgo * 60 * 1000,
      endAt: now + endMinAhead * 60 * 1000,
    };
  }

  return {
    machines,
    queue: [
      {
        id: crypto.randomUUID(),
        user: '赵敏',
        machineId: 'm1',
        gpuIndex: 0,
        durationMs: 2 * 60 * 60 * 1000,
        note: '复现论文基线',
        createdAt: now - 6 * 60 * 1000,
      },
    ],
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(parsed.machines) && Array.isArray(parsed.queue)) return parsed;
    }
  } catch (err) {
    console.warn('[warn] 数据文件读取失败，使用初始数据：', err.message);
  }
  const fresh = buildFreshState();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

let state = loadState();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/* --------------------------------- 调度逻辑 -------------------------------- */

function sweepExpired() {
  const now = Date.now();
  let changed = false;
  for (const machine of state.machines) {
    for (const gpu of machine.gpus) {
      if (gpu.booking && gpu.booking.endAt <= now) {
        gpu.booking = null;
        changed = true;
      }
    }
  }
  return changed;
}

function findMachine(machineId) {
  return state.machines.find((m) => m.id === machineId);
}

function findFreeSlot(machineId, gpuIndex) {
  const pool = machineId === 'any' ? state.machines : [findMachine(machineId)];
  for (const machine of pool) {
    if (!machine) continue;
    const gpus = gpuIndex == null ? machine.gpus : machine.gpus.filter((g) => g.id === gpuIndex);
    for (const gpu of gpus) {
      if (!gpu.booking) return { machine, gpu };
    }
  }
  return null;
}

function hasQueueFor(machineId, gpuIndex) {
  return state.queue.some(
    (q) => q.machineId === 'any' || (q.machineId === machineId && (q.gpuIndex == null || q.gpuIndex === gpuIndex))
  );
}

function makeBooking(user, durationMs, note) {
  const startAt = Date.now();
  return { id: crypto.randomUUID(), user, note, startAt, endAt: startAt + durationMs };
}

// 按队列顺序，把已经释放出来的卡自动分给等待中的用户
function dispatchQueue() {
  let changed = false;
  let i = 0;
  while (i < state.queue.length) {
    const entry = state.queue[i];
    const slot = findFreeSlot(entry.machineId, entry.gpuIndex);
    if (!slot) {
      i += 1;
      continue;
    }
    slot.gpu.booking = makeBooking(entry.user, entry.durationMs, entry.note);
    state.queue.splice(i, 1);
    changed = true;
  }
  return changed;
}

function refresh() {
  let changed = sweepExpired();
  if (dispatchQueue()) changed = true;
  if (changed) save();
}

/* ---------------------------------- 校验 ---------------------------------- */

function requireUser(body) {
  const user = String(body.user || '').trim();
  if (!user) throw new HttpError(400, '请先填写使用人姓名');
  if (user.length > 20) throw new HttpError(400, '姓名不能超过 20 个字符');
  return user;
}

function requireDuration(body) {
  const ms = Number(body.durationMs);
  if (!Number.isFinite(ms) || ms < MIN_DURATION || ms > MAX_DURATION) {
    throw new HttpError(400, '占用时长需在 5 分钟到 7 天之间');
  }
  return Math.round(ms);
}

function normalizeNote(note) {
  return String(note || '').trim().slice(0, MAX_NOTE);
}

function parseTarget(body) {
  const machineId = body.machineId === 'any' ? 'any' : String(body.machineId || '');
  let gpuIndex = body.gpuIndex == null || body.gpuIndex === '' ? null : Number(body.gpuIndex);
  if (machineId === 'any') gpuIndex = null;
  if (machineId !== 'any' && !findMachine(machineId)) throw new HttpError(404, '机器不存在');
  if (gpuIndex != null && (!Number.isInteger(gpuIndex) || !(gpuIndex >= 0 && gpuIndex < GPU_PER_MACHINE))) {
    throw new HttpError(400, '卡号不合法');
  }
  if (machineId === 'any' && gpuIndex != null) throw new HttpError(400, '目标不合法');
  return { machineId, gpuIndex };
}

/* --------------------------------- 业务接口 -------------------------------- */

function occupy(body) {
  const user = requireUser(body);
  const { machineId, gpuIndex } = parseTarget(body);
  if (machineId === 'any' || gpuIndex == null) throw new HttpError(400, '请选择具体的卡');
  const durationMs = requireDuration(body);
  const note = normalizeNote(body.note);

  refresh();

  const machine = findMachine(machineId);
  const gpu = machine.gpus.find((g) => g.id === gpuIndex);
  if (gpu.booking) throw new HttpError(409, '这张卡已经被占用，可以加入排队等候');
  if (hasQueueFor(machineId, gpuIndex)) throw new HttpError(409, '这张卡已有用户在排队，请加入排队');

  gpu.booking = makeBooking(user, durationMs, note);
  save();
  return { ok: true, booking: gpu.booking, machineId, gpuIndex };
}

function enqueue(body) {
  const user = requireUser(body);
  const { machineId, gpuIndex } = parseTarget(body);
  const durationMs = requireDuration(body);
  const note = normalizeNote(body.note);

  refresh();

  if (state.queue.some((q) => q.user === user)) {
    throw new HttpError(409, '你已在排队中，请先在队列中取消');
  }

  // 目标当前空闲且前方无人排队时，直接分配，无需排队
  const slot = findFreeSlot(machineId, gpuIndex);
  if (slot && !hasQueueFor(slot.machine.id, slot.gpu.id)) {
    slot.gpu.booking = makeBooking(user, durationMs, note);
    save();
    return { ok: true, booked: true, machineId: slot.machine.id, gpuIndex: slot.gpu.id, booking: slot.gpu.booking };
  }

  state.queue.push({
    id: crypto.randomUUID(),
    user,
    machineId,
    gpuIndex,
    durationMs,
    note,
    createdAt: Date.now(),
  });
  save();
  return { ok: true, booked: false, position: state.queue.length };
}

function release(body) {
  const user = requireUser(body);
  const { machineId, gpuIndex } = parseTarget(body);
  if (machineId === 'any' || gpuIndex == null) throw new HttpError(400, '请指定要释放的卡');

  refresh();

  const machine = findMachine(machineId);
  const gpu = machine.gpus.find((g) => g.id === gpuIndex);
  if (!gpu.booking) throw new HttpError(409, '这张卡当前已是空闲状态');
  if (gpu.booking.user !== user) throw new HttpError(403, '只能释放自己占用的卡');

  gpu.booking = null;
  refresh();
  save();
  return { ok: true };
}

function cancelQueue(body) {
  const user = requireUser(body);
  const id = String(body.id || '');
  const index = state.queue.findIndex((q) => q.id === id);
  if (index === -1) throw new HttpError(404, '排队记录不存在');
  if (state.queue[index].user !== user) throw new HttpError(403, '只能取消自己的排队');
  state.queue.splice(index, 1);
  save();
  return { ok: true };
}

/* --------------------------------- HTTP ---------------------------------- */

function publicState() {
  return {
    serverTime: Date.now(),
    gpuPerMachine: GPU_PER_MACHINE,
    machines: state.machines,
    queue: state.queue,
  };
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100 * 1024) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const value = JSON.parse(raw);
        resolve(value && typeof value === 'object' ? value : {});
      } catch (err) {
        reject(new HttpError(400, '请求格式错误'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/state') {
    refresh();
    return sendJson(res, 200, publicState());
  }
  if (req.method !== 'POST') throw new HttpError(405, '不支持的请求方法');

  const body = await readBody(req);
  switch (pathname) {
    case '/api/occupy':
      return sendJson(res, 200, occupy(body));
    case '/api/queue':
      return sendJson(res, 200, enqueue(body));
    case '/api/release':
      return sendJson(res, 200, release(body));
    case '/api/queue/cancel':
      return sendJson(res, 200, cancelQueue(body));
    default:
      throw new HttpError(404, '接口不存在');
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[error]', err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || '服务器内部错误' });
    else res.end();
  }
});

// 每秒巡检：到点自动释放，并立即把释放出的卡分配给排队用户
setInterval(() => {
  try {
    refresh();
  } catch (err) {
    console.error('[tick error]', err);
  }
}, 1000).unref();

refresh();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`算力卡调度台已启动: http://localhost:${PORT}`);
});

server.on('error', (err) => {
  console.error('服务启动失败：', err.message);
  process.exit(1);
});
