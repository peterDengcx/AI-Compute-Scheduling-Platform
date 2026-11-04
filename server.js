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
const MAX_ADVANCE = 24 * 60 * 60 * 1000;
const MAX_NOTE = 60;
const CARD_CHOICES = [1, 2, 4, 8];

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

// 推理节点全部由用户录入，序号从 0 开始
function createMachine(index, { ip, password, model }) {
  return {
    id: `node-${index}`,
    index,
    name: `推理节点 ${index}`,
    ip,
    password,
    model,
    gpus: Array.from({ length: GPU_PER_MACHINE }, (_, i) => ({ id: i, bookings: [] })),
  };
}

function buildFreshState() {
  return { machines: [], queue: [] };
}

function isValidState(parsed) {
  return (
    parsed &&
    Array.isArray(parsed.machines) &&
    Array.isArray(parsed.queue) &&
    parsed.machines.every(
      (machine) => Array.isArray(machine.gpus) && machine.gpus.every((gpu) => Array.isArray(gpu.bookings))
    )
  );
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (isValidState(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[warn] 数据文件读取失败，使用空数据：', err.message);
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

function findMachine(machineId) {
  return state.machines.find((machine) => machine.id === machineId);
}

function gpuFreeBetween(gpu, startAt, endAt) {
  return !gpu.bookings.some((booking) => booking.startAt < endAt && startAt < booking.endAt);
}

// 在单台节点内挑选 count 张在目标时段内可用的卡，优先连续卡号
function pickGpus(machine, startAt, endAt, count) {
  const free = machine.gpus.filter((gpu) => gpuFreeBetween(gpu, startAt, endAt)).map((gpu) => gpu.id);
  if (free.length < count) return null;
  for (let start = 0; start + count <= machine.gpus.length; start += 1) {
    const run = machine.gpus.slice(start, start + count).map((gpu) => gpu.id);
    if (run.every((id) => free.includes(id))) return run;
  }
  return free.slice(0, count);
}

function createBookings(user, machine, gpuIds, { startAt, endAt, note }) {
  const groupId = crypto.randomUUID();
  for (const gpuId of gpuIds) {
    const gpu = machine.gpus.find((item) => item.id === gpuId);
    gpu.bookings.push({
      id: crypto.randomUUID(),
      groupId,
      user,
      note,
      count: gpuIds.length,
      startAt,
      endAt,
    });
    gpu.bookings.sort((a, b) => a.startAt - b.startAt);
  }
  return groupId;
}

// 按顺序尝试分配，成功返回 { machine, gpuIds, groupId }
function acquire(user, machineId, startAt, endAt, count, note) {
  const pool = machineId === 'any' ? state.machines : [findMachine(machineId)];
  for (const machine of pool) {
    if (!machine) continue;
    const gpuIds = pickGpus(machine, startAt, endAt, count);
    if (!gpuIds) continue;
    const groupId = createBookings(user, machine, gpuIds, { startAt, endAt, note });
    return { machine, gpuIds, groupId };
  }
  return null;
}

function sweepExpired() {
  const now = Date.now();
  let changed = false;
  for (const machine of state.machines) {
    for (const gpu of machine.gpus) {
      const kept = gpu.bookings.filter((booking) => booking.endAt > now);
      if (kept.length !== gpu.bookings.length) {
        gpu.bookings = kept;
        changed = true;
      }
    }
  }
  return changed;
}

// 按队列顺序，把当前空出来的卡自动分给等待中的用户
function dispatchQueue() {
  let changed = false;
  let index = 0;
  while (index < state.queue.length) {
    const entry = state.queue[index];
    const now = Date.now();
    const target = entry.machineId === 'any' ? null : state.machines.find((m) => m.id === entry.machineId);
    // 目标节点已被删除时清掉该排队项，避免永久堵塞队列
    if (entry.machineId !== 'any' && !target) {
      state.queue.splice(index, 1);
      changed = true;
      continue;
    }
    const result = acquire(entry.user, entry.machineId, now, now + entry.durationMs, entry.gpuCount, entry.note);
    if (!result) {
      index += 1;
      continue;
    }
    state.queue.splice(index, 1);
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

function requireCount(body) {
  const count = Number(body.count == null || body.count === '' ? 1 : body.count);
  if (!CARD_CHOICES.includes(count)) throw new HttpError(400, '卡数只能选择 1 / 2 / 4 / 8 张');
  return count;
}

function requireStart(body) {
  const now = Date.now();
  if (body.startAt == null || body.startAt === '') return now;
  const startAt = Number(body.startAt);
  if (!Number.isFinite(startAt)) throw new HttpError(400, '开始时间不合法');
  if (startAt < now - 60 * 1000) throw new HttpError(400, '开始时间不能早于当前时间');
  if (startAt > now + MAX_ADVANCE) throw new HttpError(400, '最多只能提前 24 小时预约');
  return Math.max(startAt, now);
}

function normalizeNote(note) {
  return String(note || '').trim().slice(0, MAX_NOTE);
}

function parseMachineId(body) {
  const machineId = body.machineId === 'any' ? 'any' : String(body.machineId || '');
  if (machineId !== 'any' && !findMachine(machineId)) throw new HttpError(404, '推理节点不存在');
  return machineId;
}

/* --------------------------------- 业务接口 -------------------------------- */

function occupy(body) {
  const user = requireUser(body);
  const machineId = parseMachineId(body);
  const durationMs = requireDuration(body);
  const startAt = requireStart(body);
  const endAt = startAt + durationMs;
  const note = normalizeNote(body.note);

  let requested = null;
  if (Array.isArray(body.gpuIndexes)) {
    requested = body.gpuIndexes.map((value) => Number(value));
    if (!requested.length) throw new HttpError(400, '请至少选择一张卡');
    if (requested.some((id) => !Number.isInteger(id))) throw new HttpError(400, '卡号不合法');
    if (new Set(requested).size !== requested.length) throw new HttpError(400, '选择的卡有重复');
    if (machineId === 'any') throw new HttpError(400, '指定卡号时请选择具体的推理节点');
  }
  const count = requested ? requested.length : requireCount(body);

  refresh();

  if (requested) {
    const machine = findMachine(machineId);
    const busy = requested.filter((id) => {
      const gpu = machine.gpus.find((item) => item.id === id);
      return !gpu || !gpuFreeBetween(gpu, startAt, endAt);
    });
    if (busy.length) {
      throw new HttpError(409, `卡 ${busy.join('、')} 在该时段不可用，请重新选择`);
    }
    const groupId = createBookings(user, machine, requested, { startAt, endAt, note });
    save();
    return {
      ok: true,
      machineId: machine.id,
      machineName: machine.name,
      gpuIndexes: requested,
      groupId,
      startAt,
      endAt,
    };
  }

  const result = acquire(user, machineId, startAt, endAt, count, note);
  if (!result) {
    const future = startAt > Date.now() + 5000;
    throw new HttpError(
      409,
      future ? `该时段没有 ${count} 张可用卡，请调整开始时间或卡数` : `当前没有 ${count} 张可用卡，可以加入排队等候`
    );
  }
  save();
  return {
    ok: true,
    machineId: result.machine.id,
    machineName: result.machine.name,
    gpuIndexes: result.gpuIds,
    groupId: result.groupId,
    startAt,
    endAt,
  };
}

function enqueue(body) {
  const user = requireUser(body);
  const machineId = parseMachineId(body);
  const count = requireCount(body);
  const durationMs = requireDuration(body);
  const note = normalizeNote(body.note);

  refresh();

  if (state.queue.some((entry) => entry.user === user)) {
    const queued = state.queue.find((entry) => entry.user === user);
    const queuedMachine = state.machines.find((machine) => machine.id === queued.machineId);
    const where = queued.machineId === 'any' ? '任一节点' : queuedMachine ? queuedMachine.name : queued.machineId;
    throw new HttpError(409, `你已在「${where}」的排队中，请先在队列里取消`);
  }

  // 当前能否直接满足，能则不进队列
  const now = Date.now();
  const direct = acquire(user, machineId, now, now + durationMs, count, note);
  if (direct) {
    save();
    return { ok: true, booked: true, machineId: direct.machine.id, machineName: direct.machine.name, gpuIndexes: direct.gpuIds };
  }

  state.queue.push({
    id: crypto.randomUUID(),
    user,
    machineId,
    gpuCount: count,
    durationMs,
    note,
    createdAt: now,
  });
  save();
  return { ok: true, booked: false, position: state.queue.length };
}

function release(body) {
  const user = requireUser(body);
  const machineId = parseMachineId(body);
  const gpuIndex = Number(body.gpuIndex);
  if (machineId === 'any' || !Number.isInteger(gpuIndex)) throw new HttpError(400, '请指定要释放的卡');

  refresh();

  const machine = findMachine(machineId);
  const gpu = machine.gpus.find((item) => item.id === gpuIndex);
  if (!gpu) throw new HttpError(404, '卡不存在');
  if (!gpu.bookings.length) throw new HttpError(409, '这张卡当前已是空闲状态');

  const now = Date.now();
  const target =
    gpu.bookings.find((booking) => booking.startAt <= now && booking.endAt > now) || gpu.bookings[0];
  if (target.user !== user) throw new HttpError(403, '只能释放自己占用的卡');

  let released = 0;
  if (target.groupId) {
    for (const item of machine.gpus) {
      const before = item.bookings.length;
      item.bookings = item.bookings.filter((booking) => booking.groupId !== target.groupId);
      released += before - item.bookings.length;
    }
  } else {
    gpu.bookings = gpu.bookings.filter((booking) => booking.id !== target.id);
    released = 1;
  }

  refresh();
  save();
  return { ok: true, released, future: target.startAt > now };
}

function cancelQueue(body) {
  const user = requireUser(body);
  const id = String(body.id || '');
  const index = state.queue.findIndex((entry) => entry.id === id);
  if (index === -1) throw new HttpError(404, '排队记录不存在');
  if (state.queue[index].user !== user) throw new HttpError(403, '只能取消自己的排队');
  state.queue.splice(index, 1);
  save();
  return { ok: true };
}

function addMachine(body) {
  const ip = String(body.ip || '').trim();
  const password = String(body.password || '').trim();
  const model = String(body.model || '').trim();

  if (!ip) throw new HttpError(400, '请填写节点 IP');
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(ip)) {
    throw new HttpError(400, 'IP 格式不正确，例如 192.168.1.20');
  }
  if (ip.length > 64) throw new HttpError(400, 'IP 长度不能超过 64 个字符');
  if (!password) throw new HttpError(400, '请填写节点登录密码');
  if (password.length > 64) throw new HttpError(400, '密码不能超过 64 个字符');
  if (!model) throw new HttpError(400, '请填写机型');
  if (model.length > 40) throw new HttpError(400, '机型不能超过 40 个字符');
  if (state.machines.some((machine) => machine.ip === ip)) {
    throw new HttpError(409, '该 IP 已存在，请勿重复添加');
  }

  let index = 0;
  while (state.machines.some((machine) => machine.index === index)) index += 1;

  const machine = createMachine(index, { ip, password, model });
  state.machines.push(machine);
  state.machines.sort((a, b) => a.index - b.index);
  save();
  return { ok: true, machine: publicMachine(machine) };
}

/* --------------------------------- HTTP ---------------------------------- */

function publicMachine(machine) {
  return {
    id: machine.id,
    index: machine.index,
    name: machine.name,
    ip: machine.ip,
    model: machine.model,
    gpus: machine.gpus,
  };
}

function publicState() {
  return {
    serverTime: Date.now(),
    gpuPerMachine: GPU_PER_MACHINE,
    maxAdvance: MAX_ADVANCE,
    cardChoices: CARD_CHOICES,
    machines: state.machines.map(publicMachine),
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
    case '/api/machines':
      return sendJson(res, 200, addMachine(body));
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
