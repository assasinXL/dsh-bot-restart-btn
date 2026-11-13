// helper/shared.js —— 助手链路的常量与纯函数（宿主与助手共用的同一份源码）
//
// 这里的函数有两个用途：宿主半边直接调用（单测友好），以及通过 toString() 注入到生成的
// 助手脚本里——所以它们必须是**自包含**的（不引用其它模块符号），改一处两边同时生效。
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';

/** 默认「给宿主优雅关闭」的宽限窗口。 */
export const HOST_GRACE_MS = 15000;
/** 拉起重试次数与每次存活验证时长。 */
export const RESPAWN_ATTEMPTS = 3;
export const RESPAWN_ALIVE_MS = 2500;
/** 问「主进程当初怎么被启动的」的超时（WMI 首次查询会慢一些）。 */
export const LAUNCH_PROBE_TIMEOUT_MS = 8000;
/** 拉起后等「web 服务重新监听」的窗口与轮询间隔（v1.2.1 第 6 项）。 */
export const RELISTEN_MS = 20000;
export const RELISTEN_POLL_MS = 500;
/** macOS 停机宽限（v1.3.0）：先 SIGTERM 给 Electron 主进程一个体面退出的机会，超时才 SIGKILL。
 *  Windows 没有等价语义（taskkill 只有强杀），保持原样。 */
export const MAIN_STOP_GRACE_MS = 10000;
/** 助手脚本支持的平台（与 lib/environment.js 的 SUPPORTED_PLATFORMS 一致，单测交叉校验）。 */
export const HELPER_PLATFORMS = Object.freeze(['win32', 'darwin']);
/**
 * 生成「新实例的 web 服务是否在监听」的 PowerShell 探测脚本（v1.2.1 第 6 项）。
 *
 * 为什么不连旧端口：实测每次启动端口都不一样（56355 → 57042 → 55843），
 * 连旧端口只会在**每次成功**重启后报超时，是纯噪音。
 * 为什么不只看主进程存活：进程活着 ≠ 服务起来了（端口被占、宿主崩了都可能还有窗口）。
 *
 * 所以判据改为「新实例的**进程树**里有人在 LISTEN」：web 服务跑在宿主子进程里，
 * 不是主进程本身。脚本内部自己轮询，一次 spawn 覆盖整个等待窗口。
 * @param {number} mainPid 新实例的主进程 pid。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @param {number} pollMs 轮询间隔毫秒数。
 * @returns {string} 供 `powershell.exe -Command` 执行的脚本。
 */
export function webListenScript(mainPid, timeoutMs, pollMs) {
  // [本地补丁 · dsh-bot-restart-btn] 原实现「取进程树里第一个 LISTEN 端口」会撞上宿主同时
  // 监听的探针/内部端口（实测 50197/50198），报出来的不是你眼睛看到的界面口（50195）。
  // 现在逐个端口做一次 HTTP GET /：能拿回 HTTP 状态（含 401 的鉴权墙）的那个才是 web 服务口；
  // 给出 4 秒 HTTP 宽限，仍无响应则退回「进程树里有人在 LISTEN」的旧判据，绝不因此误判失败。
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$main = ' + Math.trunc(Number(mainPid) || 0),
    '$limit = (Get-Date).AddMilliseconds(' + Math.trunc(Number(timeoutMs) || 0) + ')',
    '$httpGrace = (Get-Date).AddMilliseconds(4000)',
    'while ((Get-Date) -lt $limit) {',
    '  $ids = @($main)',
    '  foreach ($child in (Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $main))) { $ids += $child.ProcessId }',
    '  $ports = @(Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)',
    '  foreach ($p in $ports) {',
    '    $hit = $false',
    '    try {',
    '      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $p + "/") -UseBasicParsing -TimeoutSec 2 -MaximumRedirection 0',
    '      if ($r -and [int]$r.StatusCode -ge 200) { $hit = $true }',
    '    } catch {',
    '      $resp = $_.Exception.Response',
    '      if ($resp -and [int]$resp.StatusCode -ge 200) { $hit = $true }',
    '    }',
    '    if ($hit) { Write-Output ("ok " + $p + " http"); exit 0 }',
    '  }',
    '  if ($ports.Count -gt 0 -and (Get-Date) -gt $httpGrace) { Write-Output ("ok " + $ports[0] + " tcp"); exit 0 }',
    '  Start-Sleep -Milliseconds ' + Math.trunc(Number(pollMs) || 0),
    '}',
    'Write-Output "timeout"',
  ].join('\n');
}
/**
 * 比较路径时统一分隔符、大小写与尾部分隔符（v1.3.0 平台感知）。
 *
 * Windows：NTFS 大小写不敏感，分隔符统一成反斜杠再小写比较。
 * macOS：APFS 默认大小写不敏感，但路径**可能**是大小写敏感的；这里刻意保留大小写——
 * 宁可偶尔判「不是同一个 exe」（回退到不带参数启动，安全），也不要把两个不同程序判成同一个
 * （那会拉起错误的进程）。分隔符统一成 / 再去掉尾部分隔符。
 * @param value 待归一化的路径
 * @param platform 目标平台（默认 win32，保持 v1.2 的既有调用语义）
 */
export function normalizePath(value, platform = 'win32') {
  const text = String(value ?? '');
  if (platform === 'win32') return text.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
  return text.replace(/\/+$/u, '');
}
/**
 * 按 Windows 的规则把命令行拆成参数（v1.2.1）。
 *
 * 只处理最常见的两种写法：引号包裹、以及引号里的 `\\"`。刻意不实现完整的反斜杠连写规则——
 * 遇到 `\\"` 时调用方会直接放弃复用原始参数，所以这里不需要为罕见形态承担有损解析的风险。
 * @param {string} text 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
export function tokenizeCommandLine(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '"') {
      current += '"';
      started = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}
/**
 * 按 POSIX shell 的常见规则把命令行拆成参数（v1.3.0，macOS 用）。
 *
 * 只处理最常见的两种写法：单/双引号包裹、以及引号/空白前的反斜杠转义。刻意不实现
 * 完整的 POSIX 展开（$VAR / $(...) / 反引号）——真出现那种形态时，ps 输出的原文本来
 * 就不是可安全复用的 argv，宁可让调用方退回不带参数启动。
 * @param text 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
export function tokenizePosixCommandLine(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = '';
        continue;
      }
      if (char === '\\' && quote === '"' && (text[index + 1] === '"' || text[index + 1] === '\\')) {
        current += text[index + 1];
        started = true;
        index += 1;
        continue;
      }
      current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      if (index + 1 < text.length) {
        current += text[index + 1];
        started = true;
        index += 1;
      }
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}
/**
 * 从「主进程命令行」里取出可复用的启动参数（v1.2.1，借鉴 dsh-desktop-restart）。
 *
 * 为什么不能直接转发自己的 `process.argv`：本插件跑在桌面宿主进程里，它的 argv 是
 * 「desktop-host 运行器」的参数（`--expose-internals ...index.js <一堆路径>`）；
 * 原样转发会拉起一个没有窗口的宿主进程，比不带参数更糟。所以只能在重启时问系统
 * 「最上面那个 GUI 进程当初是怎么被启动的」。
 *
 * 三重保险，任一条不成立就返回 null（调用方退回不带参数启动，绝不猜）：
 *   ① 空命令行 → null
 *   ② 命令行第 0 段不是同一个 exe（进程表有同名/多份安装） → null
 *   ③ 参数里出现 `--type=` 或 `--expose-internals` → 抓到的是 Chromium 子进程或宿主，不是用户启动 → null
 *
 * v1.3.0 平台分叉：Windows 的 WMI 返回带引号的命令行，走原来的 tokenizeCommandLine；
 * macOS 的 ps 返回的是 argv 用空格拼接后的原文（不重新加引号），而应用 exe 路径本身含空格，
 * 无法靠分词还原第 0 段。所以 darwin 分支先用「已知 exe 字符串前缀」切出参数区，再用 POSIX 分词：
 *   命令行 === exe            → []（确实是这个 exe、没有额外参数）
 *   命令行以 exe + 空格开头    → 参数区按 POSIX 规则分词
 *   其它                      → null（不敢猜）
 * @param {string|null|undefined} commandLine 进程表读到的命令行。
 * @param {string} exe 目标可执行文件。
 * @param {'win32'|'darwin'} [platform] 解析规则；默认 win32（保持 v1.2 调用语义）。
 * @returns {string[]|null} 要转发的参数；null 表示「问不出来/不敢用」。
 */
export function relaunchArgsFrom(commandLine, exe, platform = 'win32') {
  if (typeof commandLine !== 'string') return null;
  const text = commandLine.trim();
  if (text === '') return null;
  const args = platform === 'darwin'
    ? argsFromPosixCommandLine(text, exe)
    : argsFromWindowsCommandLine(text, exe);
  if (args === null) return null;
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null;
  }
  return args;
}
/** Windows 命令行 → 参数（含 exe 校验）。 */
export function argsFromWindowsCommandLine(text, exe) {
  if (text.includes('\\"')) return null;
  const tokens = tokenizeCommandLine(text);
  if (tokens.length === 0) return null;
  if (normalizePath(tokens[0], 'win32') !== normalizePath(exe, 'win32')) return null;
  return tokens.slice(1);
}
/** macOS ps 命令行 → 参数（含 exe 校验；路径含空格，所以用前缀匹配而不是依赖分词还原第 0 段）。 */
export function argsFromPosixCommandLine(text, exe) {
  const target = String(exe ?? '').replace(/\/+$/u, '');
  if (target === '') return null;
  if (text === target) return [];
  if (!text.startsWith(target + ' ')) return null;
  const rest = text.slice(target.length + 1);
  const tokens = tokenizePosixCommandLine(rest);
  if (tokens.length === 0) return null;
  return tokens;
}
/**
 * 拉起新实例前必须从继承环境里删掉的键（v1.2.1）。
 *
 * 判据：这些变量描述的是「某一次运行 / 某一个会话」的事实，而不是「这台机器」的事实。
 * 平台文档（@deepseek-ai/dsh-shell-env）说它们是「每次模型 shell 调用时新收集的管理环境」，
 * 也就是说每次调用都该重新算；跨进程继承等于把上一轮的事实带进下一轮。
 *   ① ELECTRON_RUN_AS_NODE —— 留着新实例会退化成 node，没有窗口（v1.1 起就删）
 *   ② DSH_SESSION_ID       —— 被中断那次会话的 id：留着会污染回执/续跑/日志的归属
 *   ③ DSH_WEB_URL          —— **旧进程**的 Web 端口（= webApp.getAdvertisedUrl()）；
 *                             新实例自己会重新绑端口，旧地址指向已退出的进程
 *   ④ DSH_SHELL            —— 标记「本进程由模型 shell 拉起」，新实例是用户级宿主
 *
 * 反过来，安装身份必须保留：DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR 决定用哪套安装、
 * 哪个 profile。删掉它们，新实例会退回默认 home 或默认 profile——那才是真的灾难。
 */
export const RESPAWN_ENV_DROP = Object.freeze([
  'ELECTRON_RUN_AS_NODE',
  'DSH_SESSION_ID',
  'DSH_WEB_URL',
  'DSH_SHELL',
]);
/**
 * 解析要拉起的目标可执行文件：配置里填了就用配置，否则从当前宿主进程推导。
 *
 * Windows：宿主 process.execPath 是 app 目录里的可执行文件，真正的主程序固定叫
 * `DeepSeek Harness.exe`，所以按目录推导。
 * macOS（v1.3.0）：宿主是应用包里那个 Mach-O（`<App>.app/Contents/MacOS/<App>`，
 * 由 Electron 以 ELECTRON_RUN_AS_NODE 启动），process.execPath 本身就是主进程二进制，
 * 直接用它——旧逻辑拼 `...MacOS/DeepSeek Harness.exe` 必然不存在（真机已验证）。
 * 其它平台：同样退回 execPath（环境门禁本就不会放行）。
 * @param config 生效配置（可含 exePath）
 * @param execPath 宿主进程的 process.execPath
 * @param platform 目标平台（默认取 process.platform）
 */
export function resolveExe(config, execPath, platform = process.platform) {
  const configured = config && typeof config.exePath === 'string' ? config.exePath.trim() : '';
  if (configured) return configured;
  const binary = String(execPath ?? '').trim();
  if (binary === '') return '';
  if (platform === 'win32') return win32.join(win32.dirname(binary), 'DeepSeek Harness.exe');
  return posix.normalize(binary);
}
// —— v1.3.0：macOS 系统原语的纯函数封装（便于单测；助手脚本通过 toString 注入同一份实现）——

/** 断言用的系统工具绝对路径（助手是 detached 进程，不赌 PATH）。 */
export const MAC_TOOLS = Object.freeze({
  ps: '/bin/ps',
  lsof: '/usr/sbin/lsof',
  osascript: '/usr/bin/osascript',
});

/**
 * 读主进程命令行的 ps 参数（`-ww` 关掉终端宽度截断，否则长路径会被截成一半）。
 * @param {number} pid 主进程 pid。
 * @returns {string[]} ps 参数。
 */
export function macPsArgs(pid) {
  return ['-ww', '-p', String(Math.trunc(Number(pid) || 0)), '-o', 'command='];
}

/**
 * lsof 观测「这些 pid 的 TCP 监听」的参数（-n 不做 DNS、-P 不解析端口名、-a 让过滤条件 AND）。
 * @param {number[]} pids 进程 pid 列表。
 * @returns {string[]} lsof 参数。
 */
export function macListenArgs(pids) {
  const args = ['-nP', '-a', '-iTCP', '-sTCP:LISTEN'];
  for (const pid of Array.isArray(pids) ? pids : []) {
    const id = Math.trunc(Number(pid) || 0);
    if (id > 0) args.push('-p', String(id));
  }
  return args;
}

/**
 * 从 lsof 输出里取第一个 LISTEN 端口；没有监听返回 0。
 * NAME 列形如 `127.0.0.1:50508 (LISTEN)` / `*:443 (LISTEN)` / `[::1]:3000 (LISTEN)`。
 * @param {string} output lsof 输出。
 * @returns {number} 端口（1-65535）或 0。
 */
export function parseLsofListenPort(output) {
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const matched = /\)?\s*(?:\*|[^\s:]*):(\d{1,5})\s+\(LISTEN\)/u.exec(line);
    if (!matched) continue;
    const port = Number(matched[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return 0;
}

/**
 * 解析 `ps -axo pid=,ppid=` 的输出成「ppid → 子 pid 列表」。
 * @param {string} output ps 输出。
 * @returns {Map<number, number[]>} 父子索引。
 */
export function parsePsProcessTable(output) {
  const children = new Map();
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!matched) continue;
    const pid = Number(matched[1]);
    const ppid = Number(matched[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

/**
 * 从父子索引里收集 rootPid 的整棵进程树（含自身，BFS，防御脏数据成环）。
 * @param {Map<number, number[]>} children parsePsProcessTable 的结果。
 * @param {number} rootPid 根 pid。
 * @returns {number[]} 进程树 pid 列表。
 */
export function collectDescendants(children, rootPid) {
  const root = Math.trunc(Number(rootPid) || 0);
  if (root <= 0 || !(children instanceof Map)) return [];
  const seen = new Set([root]);
  const queue = [root];
  const out = [];
  while (queue.length > 0) {
    const current = queue.shift();
    out.push(current);
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * AppleScript 字符串字面量转义（v1.3.0）。
 * 不能用 JSON.stringify：AppleScript 方言不认 JSON 的 \uXXXX 转义，换行要写成 \n，
 * 反斜杠与双引号各自用反斜杠转义。
 * @param {string} text 原文。
 * @returns {string} 带双引号的 AppleScript 字符串字面量。
 */
export function appleScriptLiteral(text) {
  return '"' + String(text ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r\n|\r|\n/gu, '\\n') + '"';
}

/**
 * 拉起失败弹窗的 AppleScript 源码（纯函数，便于单测）：应用已经没了，弹窗是唯一能说话的通道。
 * @param {string} message 正文。
 * @param {string} [title] 标题。
 * @returns {string} 供 osascript -e 执行的源码。
 */
export function macAlertScript(message, title = 'DeepSeek Harness') {
  return 'display alert ' + appleScriptLiteral(title) + ' message ' + appleScriptLiteral(message) + ' as critical';
}
/**
 * 一次重启涉及的 %TEMP% 产物路径（同一 stamp → 同一组，prune 时同进退）。
 * helper：助手脚本；ack：派发确认（宿主据此决定 202/500）；errLog：失败与 perf 日志。
 */
export function artifactPaths(dir, stamp) {
  return {
    helper: join(dir, `dsh-restart-now-helper-${stamp}.cjs`),
    ack: join(dir, `dsh-restart-now-helper-${stamp}.ack`),
    errLog: join(dir, `dsh-restart-now-${stamp}.err.log`),
  };
}
export function buildHelperSpawn(execPath, helperPath, env = process.env) {
  const merged = Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' });
  return {
    file: execPath,
    args: [helperPath],
    options: { detached: true, stdio: 'ignore', env: merged, windowsHide: true },
  };
}

/** 本插件在 %TEMP% 留下的产物命名（prune 与清理逻辑共用）。 */
export const ARTIFACT_RE =
  /^dsh-restart-now-(?:helper-)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(?:cjs|ack|err\.log)$/;

/**
 * 只保留最近 keep 次重启的产物组（helper/ack/errLog 同进退），其余删除。
 * 逐文件吞错（正在使用的旧日志可能删不掉，下轮再删），目录不存在或缺权限时静默返回。
 */
export function pruneRestartArtifacts(dir, keep = 10) {
  const result = { removed: 0, kept: 0 };
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return result;
  }
  const groups = new Map();
  for (const name of names) {
    const matched = ARTIFACT_RE.exec(name);
    if (!matched) continue;
    const stamp = matched[1];
    if (!groups.has(stamp)) groups.set(stamp, []);
    groups.get(stamp).push(name);
  }
  const stamps = Array.from(groups.keys()).sort();
  const drop = Math.max(0, stamps.length - Math.max(0, keep));
  for (let i = 0; i < drop; i += 1) {
    for (const name of groups.get(stamps[i])) {
      try {
        unlinkSync(join(dir, name));
        result.removed += 1;
      } catch (error) {
        /* 下轮再删 */
      }
    }
  }
  result.kept = Math.min(stamps.length, Math.max(0, keep));
  return result;
}
