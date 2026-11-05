'use strict';

// 实机状态采集：ping 探活 → ssh 执行 npu-smi info → 解析成每张卡的状态
// 只读能力，不影响预约主流程；采集失败只体现在 live 状态上

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const PING_TIMEOUT_MS = 1500;
const TCP_TIMEOUT_MS = 1500;
const SSH_TIMEOUT_MS = 9000;
// 后台巡检间隔：每小时一次；新增节点与手动「检测」时会额外立即采集
const POLL_INTERVAL_MS = 60 * 60 * 1000;
// 演示模式的数据抖动周期，与采集间隔解耦
const DEMO_PULSE_MS = 15000;
const MAX_CONCURRENCY = 4;
const MAX_BUFFER = 4 * 1024 * 1024;
const REMOTE_COMMAND = 'LC_ALL=C npu-smi info';
// 演示模式：NPU_DEMO=1 时不连真机，直接生成 8 卡读数，方便没有昇腾节点时看效果
const DEMO = process.env.NPU_DEMO === '1';
const HEALTH_OK = new Set(['OK', 'ok']);
// npu-smi 的 Health 列可能出现的取值，用来在表头行的任意列里定位健康状态
const HEALTH_SET = new Set(['OK', 'WARNING', 'ALARM', 'CRITICAL', 'ERROR', 'UNKNOWN', 'MINOR', 'MAJOR']);

const snapshots = new Map();
let provider = () => [];
let timer = null;
let running = false;

/* --------------------------------- 进程工具 -------------------------------- */

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: SSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, ...options },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          missing: Boolean(error && error.code === 'ENOENT'),
          timedOut: Boolean(error && error.killed),
          stdout: String(stdout || ''),
          stderr: String(stderr || '') || (error && !error.killed ? String(error.message || '') : ''),
        });
      }
    );
  });
}

function hasBinary(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, name + ext))) return true;
      } catch (err) {
        /* 目录不可访问时忽略 */
      }
    }
  }
  return false;
}

/* --------------------------------- 网络探活 -------------------------------- */

function pingHost(ip) {
  if (IS_WIN) {
    return execFileAsync('ping', ['-n', '1', '-w', String(PING_TIMEOUT_MS), ip], {
      timeout: PING_TIMEOUT_MS + 1200,
    }).then((result) => {
      if (result.missing) return { ok: false, missing: true, ms: null };
      const match = result.stdout.match(/time[=<]\s*(\d+)\s*ms/i);
      return { ok: result.code === 0 && /TTL=/i.test(result.stdout), ms: match ? Number(match[1]) : null };
    });
  }
  return execFileAsync('ping', ['-c', '1', '-W', '1', ip], { timeout: PING_TIMEOUT_MS + 1200 }).then((result) => {
    if (result.missing) return { ok: false, missing: true, ms: null };
    const match = result.stdout.match(/time=([\d.]+)\s*ms/i);
    return { ok: result.code === 0, ms: match ? Math.round(Number(match[1])) : null };
  });
}

// ICMP 被禁 / 容器内没有 ping 权限时，用 22 端口连通性兜底
function tcpProbe(ip, port = 22) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = net.connect({ host: ip, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TCP_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/* ---------------------------------- SSH ---------------------------------- */

function sshBaseArgs() {
  return [
    '-o',
    'ConnectTimeout=4',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${IS_WIN ? 'NUL' : '/dev/null'}`,
    '-o',
    'LogLevel=ERROR',
  ];
}

// 免交互密码登录：写一个临时 askpass 脚本，只回显密码
function prepareAskpass(password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npu-askpass-'));
  const passFile = path.join(dir, 'pass');
  fs.writeFileSync(passFile, password, { mode: 0o600 });
  let helper;
  if (IS_WIN) {
    helper = path.join(dir, 'askpass.cmd');
    fs.writeFileSync(helper, `@type "${passFile}"\r\n`);
  } else {
    helper = path.join(dir, 'askpass.sh');
    fs.writeFileSync(helper, `#!/bin/sh\ncat '${passFile}'\n`, { mode: 0o700 });
  }
  return {
    env: {
      SSH_ASKPASS: helper,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// 依次尝试可用的登录方式，返回第一个成功的结果
async function runRemote(node) {
  const target = node.account ? `${node.account}@${node.ip}` : node.ip;
  const attempts = [];
  const password = node.password || '';

  if (password && hasBinary('plink')) {
    attempts.push(() => ({
      name: 'plink',
      command: 'plink',
      args: ['-ssh', '-batch', '-no-antispoof', '-pw', password, target, REMOTE_COMMAND],
    }));
  }
  if (password && hasBinary('sshpass')) {
    attempts.push(() => ({
      name: 'sshpass',
      command: 'sshpass',
      args: ['-p', password, 'ssh', ...sshBaseArgs(), '-o', 'BatchMode=no', target, REMOTE_COMMAND],
    }));
  }
  if (password) {
    attempts.push(() => {
      const askpass = prepareAskpass(password);
      return {
        name: 'askpass',
        command: 'ssh',
        args: [
          ...sshBaseArgs(),
          '-o',
          'BatchMode=no',
          '-o',
          'NumberOfPasswordPrompts=1',
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          target,
          REMOTE_COMMAND,
        ],
        env: askpass.env,
        cleanup: askpass.cleanup,
      };
    });
  }
  attempts.push(() => ({
    name: 'key',
    command: 'ssh',
    args: [...sshBaseArgs(), '-o', 'BatchMode=yes', target, REMOTE_COMMAND],
  }));

  const errors = [];
  for (const build of attempts) {
    const attempt = build();
    const result = await execFileAsync(attempt.command, attempt.args, {
      env: { ...process.env, ...(attempt.env || {}) },
      timeout: SSH_TIMEOUT_MS,
    });
    if (typeof attempt.cleanup === 'function') {
      try {
        attempt.cleanup();
      } catch (err) {
        /* 临时文件清理失败可忽略 */
      }
    }
    if (result.missing) {
      errors.push(`${attempt.name}: 未安装`);
      continue;
    }
    if (result.code === 0) return { ok: true, strategy: attempt.name, ...result };
    errors.push(`${attempt.name}: ${firstLine(result.stderr) || `退出码 ${result.code}`}`);
  }
  return { ok: false, errors };
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
}

function classifyFailure(errors) {
  const text = errors.join(' | ');
  if (/Permission denied|Authentication failed|no supported authentication|password/i.test(text)) {
    return {
      status: 'auth-failed',
      error: 'SSH 认证失败：请检查登录账号 / 密码，或在节点上配置免密密钥',
    };
  }
  if (/command not found|: not found|npu-smi.*不存在|不是内部或外部命令/i.test(text)) {
    return { status: 'no-npu-smi', error: '节点上未找到 npu-smi 命令' };
  }
  if (/Connection refused|No route to host|timed out|timeout|Network is unreachable/i.test(text)) {
    return { status: 'offline', error: 'SSH 连接失败：网络不可达或 22 端口未开放' };
  }
  return { status: 'ssh-failed', error: firstLine(text) || 'SSH 执行失败' };
}

/* --------------------------------- npu-smi -------------------------------- */

function toNumber(token) {
  if (token == null || /NA/i.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

// 一格里可能是「单值 + 若干 a / b」的混合形式，先把成对数字拆出来
function parseUsageCell(cell) {
  const pairs = [];
  const singles = [];
  const rest = String(cell || '').replace(/(\d+(?:\.\d+)?|NA)\s*\/\s*(\d+(?:\.\d+)?|NA)/g, (match, a, b) => {
    pairs.push([toNumber(a), toNumber(b)]);
    return ' ';
  });
  for (const token of rest.match(/\d+(?:\.\d+)?|NA/g) || []) singles.push(toNumber(token));
  return { singles, pairs };
}

function splitCells(line) {
  const text = line.trim();
  if (!text.startsWith('|')) return null;
  const parts = text.split('|');
  // 去掉首尾空段（| a | b | 切分后首尾为空串）
  const cells = parts.slice(1, parts.length - 1).map((cell) => cell.trim());
  return cells.length ? cells : null;
}

// 解析 npu-smi info 的表格：卡信息段 + 进程段
function parseNpuSmi(text) {
  const lines = String(text || '').split(/\r?\n/);
  const chips = [];
  const processes = new Map();
  let section = 'cards';

  for (const line of lines) {
    if (/Process\s+id/i.test(line) || /Process\s+name/i.test(line)) {
      section = 'process';
      continue;
    }
    const cells = splitCells(line);
    if (!cells) continue;

    if (section === 'process') {
      // 两种表头都兼容：| NPU Chip | Process id | ... | 与 | NPU ID | Process id | ... |
      // 行形式分别是 "0 0 | 12345 | python | 2048 | 35" 和 "4 | 3318331 | VLLMWorker_TP | 78877"
      if (!/^\d+$/.test(cells[1] || '')) continue;
      const ids = (cells[0] || '').match(/^(\d+)(?:\s+(\d+))?$/);
      if (!ids || !cells[2]) continue;
      const npuId = Number(ids[1]);
      const list = processes.get(npuId) || [];
      list.push({
        pid: Number(cells[1]),
        name: cells[2],
        memMb: toNumber((cells[3] || '').match(/\d+(?:\.\d+)?/)?.[0]) || 0,
        aicore: toNumber((cells[4] || '').match(/\d+(?:\.\d+)?/)?.[0]),
      });
      processes.set(npuId, list);
      continue;
    }

    // 卡信息首行有两种排布：
    //   | 0  910B2 | OK | 92.3  36  0 / 0 |                     （ID 与型号同格）
    //   | 0 | Ascend950PR | OK | 221.3  54  0 / 0 |              （各自独立列）
    const head = (cells[0] || '').match(/^(\d+)(?:\s+(.+))?$/);
    const healthIndex = cells.findIndex((cell) => HEALTH_SET.has(String(cell || '').toUpperCase()));
    if (head && healthIndex > 0) {
      const usage = parseUsageCell(cells[healthIndex + 1] || '');
      chips.push({
        id: chips.length,
        npuId: Number(head[1]),
        chipId: Number(head[1]),
        name: (head[2] || (healthIndex > 1 ? cells[1] : '') || '').trim(),
        health: cells[healthIndex],
        power: usage.singles[0] == null ? null : usage.singles[0],
        temp: usage.singles[1] == null ? null : usage.singles[1],
        aicore: null,
        memUsed: null,
        memTotal: null,
        hbmUsed: null,
        hbmTotal: null,
        busId: '',
        processes: [],
      });
      continue;
    }

    // 卡信息次行：| 0 | 0000:C1:00.0 | 0  0 / 0  2048 / 65536 |
    //             |   |              | 0000:01:00.0 | 0  0 / 0  4700 / 86016 |
    if (!chips.length) continue;
    const busIndex = cells.findIndex((cell) => /^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{2}:/i.test(cell || ''));
    if (busIndex !== -1) {
      const chip = chips[chips.length - 1];
      const usage = parseUsageCell(cells[busIndex + 1] || '');
      if (/^\d+$/.test(cells[0] || '')) chip.chipId = Number(cells[0]);
      chip.busId = cells[busIndex];
      chip.aicore = usage.singles[0];
      chip.memUsed = usage.pairs[0] ? usage.pairs[0][0] : null;
      chip.memTotal = usage.pairs[0] ? usage.pairs[0][1] : null;
      chip.hbmUsed = usage.pairs[1] ? usage.pairs[1][0] : null;
      chip.hbmTotal = usage.pairs[1] ? usage.pairs[1][1] : null;
    }
  }

  for (const chip of chips) {
    chip.processes = (processes.get(chip.npuId) || []).map((item) => ({ ...item }));
  }
  // NPU ID 升序即平台侧卡号 0..N-1
  chips.sort((a, b) => a.npuId - b.npuId);
  chips.forEach((chip, index) => {
    chip.id = index;
  });
  return chips;
}

function chipHealthy(chip) {
  return HEALTH_OK.has(String(chip.health || '').trim());
}

/* --------------------------------- 采集流程 -------------------------------- */

function createSnapshot(nodeId, patch) {
  return {
    nodeId,
    status: 'pending',
    pingMs: null,
    strategy: '',
    checkedAt: Date.now(),
    durationMs: 0,
    error: '',
    chips: [],
    ...patch,
  };
}

// 演示数据：每个节点哪些卡在跑任务（其余卡为空闲）
const DEMO_BUSY = [[0, 1, 2, 3], [6], [], [0, 1, 2, 3, 4, 5, 6, 7]];
const DEMO_PROCESS_NAMES = ['python3 train.py', 'vllm_engine', 'mindspore_worker', 'llama_infer'];

// 15 秒一个周期抖动一次，看起来像实机在跑
function demoPulse(seed) {
  const t = Math.floor(Date.now() / DEMO_PULSE_MS);
  return Math.abs(Math.sin(seed * 12.9898 + t * 4.1414)) % 1;
}

function demoChips(node) {
  const index = Number.isInteger(node.index) ? node.index : 0;
  const busy = DEMO_BUSY[index % DEMO_BUSY.length];
  const chips = [];
  for (let i = 0; i < 8; i += 1) {
    const running = busy.includes(i);
    const r1 = demoPulse(index * 31 + i);
    const r2 = demoPulse(index * 71 + i * 3 + 5);
    // 节点 1 的 3 号卡模拟一个健康告警，用来验证告警样式
    const health = index === 1 && i === 3 ? 'Warning' : 'OK';
    const hbmTotal = 65536;
    const hbmUsed = running ? Math.round(28000 + r1 * 30000) : Math.round(300 + r2 * 900);
    const aicore = running ? Math.round(55 + r1 * 40) : Math.round(r2 * 3);
    const temp = running ? Math.round(48 + r1 * 16) : Math.round(32 + r2 * 6);
    const pid = 10000 + index * 100 + i * 7;
    chips.push({
      id: i,
      npuId: i,
      chipId: i,
      name: index === 2 ? 'Ascend310P3' : 'Ascend910B2C',
      health,
      power: running ? Math.round(120 + r1 * 60) : Math.round(38 + r2 * 10),
      temp: health === 'Warning' ? 79 : temp,
      aicore,
      memUsed: running ? Math.round(hbmUsed * 0.12) : Math.round(80 + r2 * 200),
      memTotal: 65536,
      hbmUsed,
      hbmTotal,
      processCount: running ? 1 + Math.round(r1) : 0,
      processes: running
        ? [
            {
              pid: pid + 1,
              name: DEMO_PROCESS_NAMES[(index + i) % DEMO_PROCESS_NAMES.length],
              memory: Math.round(hbmUsed * 0.9),
            },
          ]
        : [],
      busId: `0000:${(0x80 + i).toString(16).toUpperCase()}:00.0`,
    });
  }
  return chips;
}

function demoSnapshot(node, startedAt) {
  const chips = demoChips(node);
  const snapshot = createSnapshot(node.id, {
    status: 'online',
    pingMs: 2 + Math.floor(demoPulse(node.index || 0) * 6),
    strategy: 'demo',
    durationMs: Date.now() - startedAt,
    chips,
  });
  snapshots.set(node.id, snapshot);
  return snapshot;
}

async function refreshNode(node) {
  const startedAt = Date.now();
  if (DEMO) return demoSnapshot(node, startedAt);
  const ping = await pingHost(node.ip);
  if (!ping.ok) {
    const reachable = ping.missing ? await tcpProbe(node.ip) : false;
    if (!reachable) {
      const snapshot = createSnapshot(node.id, {
        status: 'offline',
        pingMs: null,
        durationMs: Date.now() - startedAt,
        error: 'ping 不通，机器可能已下线',
      });
      snapshots.set(node.id, snapshot);
      return snapshot;
    }
  }

  const remote = await runRemote(node);
  if (!remote.ok) {
    const classified = classifyFailure(remote.errors || []);
    const snapshot = createSnapshot(node.id, {
      status: classified.status,
      pingMs: ping.ms,
      durationMs: Date.now() - startedAt,
      error: classified.error,
    });
    snapshots.set(node.id, snapshot);
    return snapshot;
  }

  const chips = parseNpuSmi(remote.stdout);
  if (!chips.length) {
    const snapshot = createSnapshot(node.id, {
      status: 'parse-error',
      pingMs: ping.ms,
      strategy: remote.strategy,
      durationMs: Date.now() - startedAt,
      error: 'npu-smi 输出无法解析，节点上可能没有 NPU',
    });
    snapshots.set(node.id, snapshot);
    return snapshot;
  }

  const snapshot = createSnapshot(node.id, {
    status: 'online',
    pingMs: ping.ms,
    strategy: remote.strategy,
    durationMs: Date.now() - startedAt,
    chips,
  });
  snapshots.set(node.id, snapshot);
  return snapshot;
}

async function runCycle() {
  if (running) return;
  running = true;
  try {
    const queue = provider().filter((node) => node && node.ip);
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const node = queue.shift();
        try {
          await refreshNode(node);
        } catch (err) {
          snapshots.set(node.id, createSnapshot(node.id, { status: 'ssh-failed', error: err.message || '采集异常' }));
        }
      }
    });
    await Promise.all(workers);
  } finally {
    running = false;
  }
}

function start(getMachines) {
  provider = typeof getMachines === 'function' ? getMachines : () => [];
  if (DEMO) console.log('[info] NPU_DEMO=1：实机状态使用演示数据，不会连接真实节点');
  runCycle();
  timer = setInterval(runCycle, POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function get(nodeId) {
  return snapshots.get(nodeId) || null;
}

function forget(nodeId) {
  snapshots.delete(nodeId);
}

// 立即采集单个节点：新增节点、点「检测」、后台每小时巡检都走这里
async function refreshOne(node) {
  return refreshNode(node);
}

// 下发给前端：只保留展示需要的字段
function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    status: snapshot.status,
    pingMs: snapshot.pingMs,
    strategy: snapshot.strategy,
    checkedAt: snapshot.checkedAt,
    durationMs: snapshot.durationMs,
    error: snapshot.error,
    chips: snapshot.chips.map((chip) => ({
      id: chip.id,
      npuId: chip.npuId,
      name: chip.name,
      health: chip.health,
      temp: chip.temp,
      power: chip.power,
      aicore: chip.aicore,
      memUsed: chip.memUsed,
      memTotal: chip.memTotal,
      hbmUsed: chip.hbmUsed,
      hbmTotal: chip.hbmTotal,
      healthy: chipHealthy(chip),
      processCount: chip.processes.length,
      processes: chip.processes.slice(0, 8),
    })),
  };
}

module.exports = {
  start,
  stop,
  get,
  forget,
  refreshOne,
  publicSnapshot,
  parseNpuSmi,
  chipHealthy,
};
