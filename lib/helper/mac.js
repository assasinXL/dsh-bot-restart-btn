// helper/mac.js —— macOS 助手脚本生成器（SIGTERM/SIGKILL、ps、lsof、osascript）
import {
  HOST_GRACE_MS, MAIN_STOP_GRACE_MS, RESPAWN_ATTEMPTS, RESPAWN_ALIVE_MS,
  LAUNCH_PROBE_TIMEOUT_MS, RELISTEN_MS, RELISTEN_POLL_MS, RESPAWN_ENV_DROP,
  MAC_TOOLS, macPsArgs, macListenArgs, parseLsofListenPort, parsePsProcessTable,
  collectDescendants, appleScriptLiteral, macAlertScript,
  normalizePath, tokenizeCommandLine, tokenizePosixCommandLine, relaunchArgsFrom,
  argsFromWindowsCommandLine, argsFromPosixCommandLine, webListenScript,
} from './shared.js';

/**
 * macOS 助手脚本（v1.3.0）。与 Windows 版**同一契约**，只换系统原语：
 *  - 停机：SIGTERM 主进程（宽限 stopGraceMs，默认 10s）→ 仍在则 SIGKILL。
 *    主进程一死，宿主立刻收到 IPC disconnect → application.shutdown 优雅关闭（会话日志落盘）；
 *    宿主超过 hostGraceMs 仍未退才 SIGKILL 补刀（补刀是最后手段，会丢未落盘写入）。
 *  - 启动参数：ps -ww 读主进程命令行（先查已知 exe 前缀，再 POSIX 分词；路径含空格也不会拆错）。
 *  - 监听观测：ps 取新实例进程树 → lsof 查这些 pid 的 LISTEN（只进日志，绝不当成功判据）。
 *  - 失败弹窗：osascript display alert（应用已死，弹窗是唯一能把话传到眼前的通道）。
 */
export function buildMacHelperScript(options) {
  const {
    exe,
    mainPid,
    hostPid,
    errLog,
    ack,
    receipt = '',
    hostGraceMs = HOST_GRACE_MS,
    stopGraceMs = MAIN_STOP_GRACE_MS,
    attempts = RESPAWN_ATTEMPTS,
    aliveMs = RESPAWN_ALIVE_MS,
    probeTimeoutMs = LAUNCH_PROBE_TIMEOUT_MS,
    webListenMs = RELISTEN_MS,
    webListenPollMs = RELISTEN_POLL_MS,
  } = options;
  const j = (value) => JSON.stringify(value === undefined ? null : value);
  return `'use strict';
// dsh-restart-now helper (v1.3.0, darwin) —— 由宿主在重启前写出并 detached 拉起，独立于应用进程树。
// 与 Windows 版同一契约：只停 Electron 主进程 → 宿主因 IPC 断开优雅退出（会话落盘）→ 再拉起应用。
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
const STOP_GRACE_MS = ${j(stopGraceMs)};
const ATTEMPTS = ${j(attempts)};
const ALIVE_MS = ${j(aliveMs)};
const ENV_DROP = ${JSON.stringify([...RESPAWN_ENV_DROP])};
const PROBE_TIMEOUT_MS = ${j(probeTimeoutMs)};
// 拉起后观测「新实例的 web 服务是否真的在监听」（第 6 项）。只观测，不当成功判据。
const WEB_LISTEN_MS = ${j(webListenMs)};
const WEB_LISTEN_POLL_MS = ${j(webListenPollMs)};
const PS = ${j(MAC_TOOLS.ps)};
const LSOF = ${j(MAC_TOOLS.lsof)};
const OSASCRIPT = ${j(MAC_TOOLS.osascript)};

// 与模块同一份源码（toString 注入）：宿主与助手的解析/判定规则永不分叉。
${normalizePath.toString()}
${tokenizeCommandLine.toString()}
${tokenizePosixCommandLine.toString()}
${relaunchArgsFrom.toString()}
${argsFromWindowsCommandLine.toString()}
${argsFromPosixCommandLine.toString()}
${parsePsProcessTable.toString()}
${collectDescendants.toString()}
${macPsArgs.toString()}
${macListenArgs.toString()}
${parseLsofListenPort.toString()}
${appleScriptLiteral.toString()}
${macAlertScript.toString()}

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

// 发信号停机。ESRCH = 进程已经不在了，对调用方等价于成功（幂等），绝不记成失败。
function signal(pid, sig, label) {
  try { process.kill(pid, sig); return true; } catch (error) {
    if (error && error.code === 'ESRCH') return true;
    fail('kill ' + label + ' with ' + sig + ' failed: ' + ((error && error.message) || String(error)));
    return false;
  }
}
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  return !alive(pid);
}

// 问系统「主进程当初是怎么被启动的」。问不到就返回 null —— 那不等于「没有参数」，
// 但两者对调用方的结论一样：不带参数启动（绝不拿自己的 argv 去猜）。
function readLaunchArgs() {
  if (!Number.isInteger(MAIN) || MAIN <= 1) return null;
  let text = '';
  try {
    text = execFileSync(PS, macPsArgs(MAIN), {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    fail('launch-args probe failed: ' + ((error && error.message) || String(error)));
    return null;
  }
  const trimmed = String(text || '').trim();
  return trimmed === '' ? null : trimmed;
}

// 拉起全失败时把话说到用户脸前（v1.2.1 同款语义）：应用已经没了，弹窗是唯一通道。
// osascript 独立 detached 拉起，不阻塞助手收尾；600ms 内没冒 ENOENT 就认为弹窗进程已起。
async function alertUser(message) {
  let started = true;
  let child;
  try {
    child = spawn(OSASCRIPT, ['-e', macAlertScript(message)], { detached: true, stdio: 'ignore' });
  } catch (error) {
    return false;
  }
  child.once('error', () => { started = false; });
  try { child.unref(); } catch (error) { /* 老 Node 无 unref */ }
  await sleep(600);
  return started;
}

// 问系统要一次「新实例的进程树里有没有人在 LISTEN」；自己做轮询到超时。
// 拿不到 lsof / 命令报错都只回 unsupported，绝不因此判重启失败（新实例可能合法换端口）。
async function waitWebListen(mainPid, timeoutMs) {
  const started = Date.now();
  const settle = (verdict, port, error) => ({ verdict: verdict, port: port || 0, wait: Date.now() - started, error: error || '' });
  while (Date.now() - started <= timeoutMs) {
    let table;
    try {
      table = execFileSync(PS, ['-axo', 'pid=,ppid='], {
        encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      return settle('unsupported', 0, String((error && error.message) || error));
    }
    const pids = collectDescendants(parsePsProcessTable(table), mainPid);
    try {
      const output = execFileSync(LSOF, macListenArgs(pids), {
        encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const port = parseLsofListenPort(output);
      if (port > 0) return settle('ok', port, '');
    } catch (error) {
      // lsof 退出码 1 = 这些 pid 没有匹配的监听（正常状态），继续轮询。
      if (!(error && (error.status === 1 || error.code === 'EPIPE'))) {
        return settle('unsupported', 0, String((error && error.message) || error));
      }
    }
    await sleep(WEB_LISTEN_POLL_MS);
  }
  return settle('timeout', 0, '');
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
  //    （此时 ppid 变成 0/1）。拿 0/1 去 kill 等于攻击 init 或空目标，必须先挡住。
  if (!Number.isInteger(MAIN) || MAIN <= 1) { fail('invalid main pid: ' + MAIN); return; }

  // ① 先写 ack：宿主据此判定派发成功（拿不到 ack 就报错、绝不杀任何进程）
  try { fs.writeFileSync(ACK, JSON.stringify({ at: new Date().toISOString(), helperPid: process.pid })); }
  catch (error) { fail('ack write failed: ' + (error && error.message)); return; }

  // ①b 趁主进程还活着，问它当初是怎么被启动的；问不到/不敢用就带空参数（见 relaunchArgsFrom）
  const rawCommandLine = readLaunchArgs();
  const launchArgs = relaunchArgsFrom(rawCommandLine, EXE, 'darwin');
  perf(launchArgs === null
    ? 'launch_args=unavailable' + (rawCommandLine ? ' (command line unusable)' : '')
    : 'launch_args=' + JSON.stringify(launchArgs));
  const args = launchArgs === null ? [] : launchArgs;

  await sleep(500);

  // ② 停主进程：SIGTERM 先礼（Electron 主进程默认按 Node 规则终止），宽限后 SIGKILL 后兵。
  //    只杀主进程、绝不按进程树杀：宿主必须在主进程死后走 IPC disconnect 的优雅关闭路径。
  const T1 = Date.now();
  if (alive(MAIN)) {
    signal(MAIN, 'SIGTERM', 'main');
    if (!(await waitGone(MAIN, STOP_GRACE_MS))) {
      fail('main alive after ' + STOP_GRACE_MS + 'ms, sending SIGKILL');
      signal(MAIN, 'SIGKILL', 'main');
    }
  }
  if (!(await waitGone(MAIN, 30000))) {
    fail('wait main timeout: ' + MAIN);
    writeReceipt({ failed: { at: new Date().toISOString(), reason: 'main-not-stopped' } });
    return;
  }
  const T2 = Date.now();

  // ③ 等宿主自己退（IPC 断开 → application.shutdown → 会话落盘），超时才定点补刀
  let hostDown = await waitGone(HOST, HOST_GRACE_MS);
  if (!hostDown) {
    fail('host alive after ' + HOST_GRACE_MS + 'ms, killing ' + HOST);
    signal(HOST, 'SIGKILL', 'host');
    hostDown = await waitGone(HOST, 10000);
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
  const listen = await waitWebListen(newPid, WEB_LISTEN_MS);
  perf('web_listen=' + listen.verdict + ' wait=' + listen.wait + 'ms'
    + (listen.port ? ' port=' + listen.port : '')
    + (listen.error ? ' error=' + listen.error : ''));
  process.exit(0);

  function readStart() {
    try { return JSON.parse(fs.readFileSync(RECEIPT, 'utf8')).atMs; } catch (error) { return 0; }
  }
})();
`;
}
