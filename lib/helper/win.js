// helper/win.js —— Windows 助手脚本生成器（taskkill /F、WMI 读命令行、PowerShell 观测与弹窗）
import {
  HOST_GRACE_MS, RESPAWN_ATTEMPTS, RESPAWN_ALIVE_MS, LAUNCH_PROBE_TIMEOUT_MS,
  RELISTEN_MS, RELISTEN_POLL_MS, RESPAWN_ENV_DROP, normalizePath, tokenizeCommandLine,
  tokenizePosixCommandLine, relaunchArgsFrom, argsFromWindowsCommandLine, argsFromPosixCommandLine,
  webListenScript,
} from './shared.js';

/**
 * Windows 助手脚本（v1.1 起逐字沿用；v1.3.0 只加了 pid 健全性检查）。
 * 平台专项：taskkill /F、WMI 读命令行、PowerShell 观测监听与消息框、.exe 路径推导。
 */
export function buildWindowsHelperScript(options) {
  const {
    exe,
    mainPid,
    hostPid,
    errLog,
    ack,
    receipt = '',
    hostGraceMs = HOST_GRACE_MS,
    attempts = RESPAWN_ATTEMPTS,
    aliveMs = RESPAWN_ALIVE_MS,
    probeTimeoutMs = LAUNCH_PROBE_TIMEOUT_MS,
    webListenMs = RELISTEN_MS,
    webListenPollMs = RELISTEN_POLL_MS,
  } = options;
  const j = (value) => JSON.stringify(value === undefined ? null : value);
  return `'use strict';
// dsh-restart-now helper (v1.3.0, win32) —— 由宿主在重启前写出并 detached 拉起，独立于应用进程树。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');

const path = require('node:path');

const EXE = ${j(exe)};
const MAIN = ${j(mainPid)};
const HOST = ${j(hostPid)};
const ERR_LOG = ${j(errLog)};
const ACK = ${j(ack)};
const RECEIPT = ${j(receipt)};
const HOST_GRACE_MS = ${j(hostGraceMs)};
const ATTEMPTS = ${j(attempts)};
const ALIVE_MS = ${j(aliveMs)};
const ENV_DROP = ${JSON.stringify([...RESPAWN_ENV_DROP])};
const PROBE_TIMEOUT_MS = ${j(probeTimeoutMs)};
// 拉起后观测「新实例的 web 服务是否真的在监听」（第 6 项）。只观测，不当成功判据。
const WEB_LISTEN_MS = ${j(webListenMs)};
const WEB_LISTEN_POLL_MS = ${j(webListenPollMs)};

// 启动参数复用（v1.2.1；v1.3.0 加 POSIX 分支）：下面这些函数是模块里同名函数的**同一份源码**
// （toString 注入），避免助手脚本再抄一遍解析规则；改逻辑只改一处。
${normalizePath.toString()}
${tokenizeCommandLine.toString()}
${tokenizePosixCommandLine.toString()}
${relaunchArgsFrom.toString()}
${argsFromWindowsCommandLine.toString()}
${argsFromPosixCommandLine.toString()}
// web 服务监听探测（v1.2.1 第 6 项）同样是同一份源码。
${webListenScript.toString()}

// 问系统「主进程当初是怎么被启动的」。问不到就返回 null —— 那不等于「没有参数」，
// 但两者对调用方的结论一样：不带参数启动（绝不拿自己的 argv 去猜）。
function readLaunchArgs() {
  if (!Number.isInteger(MAIN) || MAIN <= 0) return null;
  const probe = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" + MAIN + "'; "
    + 'if ($p -and $p.CommandLine) { $p.CommandLine }';
  let text = '';
  try {
    text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    fail('launch-args probe failed: ' + ((error && error.message) || String(error)));
    return null;
  }
  const trimmed = String(text || '').trim();
  return trimmed === '' ? null : trimmed;
}

// 拉起全失败时把话说到用户脸前（v1.2.1）。窗口再也不会回来、日志没人会看，
// 弹窗是唯一能把「请手动打开」传到眼前的通道。尽力而为：弹不出来就记一笔，绝不影响收尾。
async function alertUser(message) {
  // 注意：PowerShell 里反斜杠**不是**转义符，所以不能用 JSON.stringify 拼字面量
  // （那样 C:\\Temp 会原样显示成两个反斜杠）。单引号字面量里只需把 ' 写成 ''。
  const quoted = "'" + String(message).replace(/'/g, "''") + "'";
  const shellScript = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('
    + quoted + ", 'DeepSeek Harness') | Out-Null";
  const encoded = Buffer.from(shellScript, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const started = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const child = spawn(shell, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => done(false));
        child.unref();
      } catch (error) {
        done(false);
        return;
      }
      // ENOENT 是异步事件：给它一点时间冒出来，才轮得到下一个 shell
      setTimeout(() => done(true), 600);
    });
    if (started) return true;
  }
  return false;
}

// 问系统要一次「新实例的进程树里有没有人在 LISTEN」，脚本自己轮询到超时。
// 拿不到 PowerShell / 命令报错都只回 unsupported，绝不因此判重启失败。
function waitWebListen(mainPid, timeoutMs) {
  const started = Date.now();
  const settle = (verdict, port, error, mode) => ({ verdict: verdict, port: port || 0, mode: mode || '', wait: Date.now() - started, error: error || '' });
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', webListenScript(mainPid, timeoutMs, WEB_LISTEN_POLL_MS),
    ], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const text = String(output || '').trim();
    if (text.indexOf('ok ') === 0) {
      // [本地补丁 · dsh-bot-restart-btn] 第三段是探测方式：http = 真回了 HTTP 的界面口；
      // tcp = HTTP 宽限内没人应答，退回「进程树里有人在 LISTEN」的旧判据。
      const parts = text.slice(3).trim().split(/\\s+/);
      const port = Number(parts[0]);
      const mode = parts[1] === 'http' ? 'http' : (parts[1] === 'tcp' ? 'tcp' : '');
      return settle('ok', Number.isInteger(port) ? port : 0, '', mode);
    }
    return settle('timeout', 0, '');
  } catch (error) {
    return settle('unsupported', 0, String((error && error.message) || error));
  }
}

const T0 = Date.now();
function fail(message) {
  try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' ' + message + '\\n'); } catch (error) { /* 日志失败不影响主流程 */ }
}
function perf(message) {
  try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' perf: ' + message + '\\n'); } catch (error) {}
}
function alive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kill(pid, label) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (error) {
    fail('taskkill ' + label + ' failed: ' + (error && error.message));
    return false;
  }
}

function writeReceipt(patch) {
  if (!RECEIPT) return;
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')); } catch (error) { current = {}; }
    fs.writeFileSync(RECEIPT, JSON.stringify(Object.assign({}, current, patch), null, 2));
  } catch (error) { fail('receipt write failed: ' + (error && error.message)); }
}

(async () => {
  // ⓪ pid 健全性（v1.3.0）：宿主是 Electron 主进程的子进程，但主进程可能已经先没了
  //    （此时 ppid 变成 0/1）。拿 0/1 去 taskkill 等于攻击 init 或空目标，必须先挡住。
  if (!Number.isInteger(MAIN) || MAIN <= 1) { fail('invalid main pid: ' + MAIN); return; }

  // ① 先写 ack：宿主据此判定派发成功（拿不到 ack 就报错、绝不杀任何进程）
  try { fs.writeFileSync(ACK, JSON.stringify({ at: new Date().toISOString(), helperPid: process.pid })); }
  catch (error) { fail('ack write failed: ' + (error && error.message)); return; }

  // ①b 趁主进程还活着，问它当初是怎么被启动的；问不到/不敢用就带空参数（见 relaunchArgsFrom）
  const rawCommandLine = readLaunchArgs();
  const launchArgs = relaunchArgsFrom(rawCommandLine, EXE);
  perf(launchArgs === null
    ? 'launch_args=unavailable' + (rawCommandLine ? ' (command line unusable)' : '')
    : 'launch_args=' + JSON.stringify(launchArgs));
  const args = launchArgs === null ? [] : launchArgs;

  await sleep(500);

  // ② 只结束 Electron 主进程（不带 /T）：宿主随之失去 IPC，走官方优雅关闭
  const T1 = Date.now();
  kill(MAIN, 'main');
  let deadline = Date.now() + 30000;
  while (alive(MAIN) && Date.now() < deadline) await sleep(200);
  if (alive(MAIN)) { fail('wait main timeout: ' + MAIN); writeReceipt({ failed: { at: new Date().toISOString(), reason: 'main-not-stopped' } }); return; }
  const T2 = Date.now();

  // ③ 等宿主自己退（给会话落盘留出时间），超时才定点补刀
  let hostDown = false;
  deadline = Date.now() + HOST_GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(HOST)) { hostDown = true; break; }
    await sleep(200);
  }
  if (!hostDown) {
    fail('host alive after ' + HOST_GRACE_MS + 'ms, killing ' + HOST);
    kill(HOST, 'host');
    deadline = Date.now() + 10000;
    while (alive(HOST) && Date.now() < deadline) await sleep(200);
  }
  const T3 = Date.now();

  // ④ 拉起新实例：干净环境（见 ENV_DROP：去掉 ELECTRON_RUN_AS_NODE 否则没有窗口，
  //    并清掉上一次运行/会话的 DSH_* 事实）+ 存活验证 + 重试
  const env = Object.assign({}, process.env);
  const dropped = [];
  for (const key of ENV_DROP) {
    if (key in env) dropped.push(key);
    delete env[key];
  }
  perf('env_dropped=' + (dropped.join(',') || 'none'));
  let newPid = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await sleep(attempt === 1 ? 800 : 1000);
    let child;
    try {
      child = spawn(EXE, args, { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env });
    } catch (error) {
      lastError = (error && error.message) || String(error);
      fail('respawn spawn failed (attempt ' + attempt + '): ' + lastError);
      continue;
    }
    child.on('error', (error) => fail('respawn error: ' + ((error && error.message) || String(error))));
    try { child.unref(); } catch (error) {}
    const pid = child.pid;
    await sleep(ALIVE_MS);
    if (pid && alive(pid)) { newPid = pid; break; }
    lastError = 'exited within ' + ALIVE_MS + 'ms';
    fail('respawn attempt ' + attempt + ' ' + lastError);
  }

  const T4 = Date.now();
  perf('main_stop=' + (T2 - T1) + 'ms host_grace=' + (T3 - T2) + 'ms respawn=' + (T4 - T3) + 'ms total=' + (T4 - T0) + 'ms');

  if (!newPid) {
    fail('respawn failed after ' + ATTEMPTS + ' attempts');
    writeReceipt({ failed: { at: new Date().toISOString(), reason: 'respawn-failed', detail: lastError } });
    // 唯一能把「请手动打开」送到眼前的通道（此时应用已经没了，界面不存在）
    const shown = await alertUser('重启失败：新实例没能启动。' + String.fromCharCode(10, 10)
      + '原因：' + (lastError || 'unknown') + String.fromCharCode(10, 10)
      + '请手动打开 DeepSeek Harness。日志：' + ERR_LOG);
    perf('alert_shown=' + shown);
    return;
  }
  writeReceipt({ respawnedAt: new Date().toISOString(), newPid: newPid, downtimeMs: T4 - (Number(readStart()) || T0) });

  // ⑤ 观测「新实例的 web 服务真的开始监听了吗」（v1.2.1 第 6 项）。
  //    进程活着 ≠ 服务起来了；这里查新实例的**进程树**里有没有人在 LISTEN（端口每次启动都变，
  //    所以不比端口号，只看有没有人听）。**只观测、不判失败**：结论只进日志，不影响重启结论。
  const listen = waitWebListen(newPid, WEB_LISTEN_MS);
  perf('web_listen=' + listen.verdict + (listen.mode ? ' ' + listen.mode : '') + ' wait=' + listen.wait + 'ms'
    + (listen.port ? ' port=' + listen.port : '')
    + (listen.error ? ' error=' + listen.error : ''));
  process.exit(0);

  function readStart() {
    try { return JSON.parse(fs.readFileSync(RECEIPT, 'utf8')).atMs; } catch (error) { return 0; }
  }
})();
`;
}
