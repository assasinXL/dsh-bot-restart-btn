// dsh-restart-now —— 重启助手与派发参数（宿主半边，纯函数，便于单测）
//
// 沿革（每一版都可追溯到一次真机故障）：
//   v0.7  taskkill /PID <ppid> /T /F 会按父子关系连坐杀掉 detached 助手 → 改 WMI 派发脱离进程树
//   v0.9  火绒拦「隐藏执行 PowerShell」+ WMI 给助手开可见控制台黑框 → 改 wscript.exe + VBS(ShowWindow=0)
//   v1.1  实测（.m4/exp-kill 三组实验）：detached 子进程在「只杀主进程」时存活，WMI/VBS 整层可删；
//         杀法改为「只结束 Electron 主进程（不带 /T）」，让宿主因 IPC 断开自行优雅关闭（会话落盘），
//         超时再定点补杀宿主；拉起改用 detached spawn(应用自身 exe) 当 node，助手派发不再需要 WMI。
//   v1.3.0 加 macOS：契约不变（只杀 Electron 主进程 → 宿主收 IPC disconnect 优雅退出 → 再拉起），
//         变的只有系统原语：taskkill→SIGTERM(宽限)/SIGKILL、WMI→ps、PowerShell 监听探测→lsof、
//         PowerShell 消息框→osascript。macOS 主进程 = <App>.app/Contents/MacOS/<App>，路径含空格，
//         所以解析启动参数用「已知 exe 前缀匹配 + POSIX 分词」而不是按空白切。
//
// 助手时序（两平台同构）：写 ack → 问主进程启动参数（问不到就不带参数）→ 等 500ms
//          → 停 main（Windows: taskkill /F；macOS: SIGTERM，宽限 10s 后 SIGKILL）
//          → 等 main 消失 30s → 等宿主优雅退出 graceMs → 仍未退则 SIGKILL/taskkill host 补刀
//          → 800ms 缓冲 → 带上参数拉起 exe（重试 3 次，每次存活验证 2.5s）→ 写回执
//          → 全失败则弹窗告知「请手动打开」（v1.2.1）
//          → 成功后观测新实例的 web 服务是否真的在监听（只进日志，不影响结论）
import { HELPER_PLATFORMS } from './helper/shared.js';
import { buildWindowsHelperScript } from './helper/win.js';
import { buildMacHelperScript } from './helper/mac.js';

// 对外 API 保持不变：index.js 只认 './helper-src.js'。
export * from './helper/shared.js';
export { buildWindowsHelperScript, buildMacHelperScript };

/**
 * 生成助手脚本（可独立运行的 CommonJS 源码）。
 *
 * 设计要点：
 *  - 只杀 Electron 主进程、不带 /T：宿主的 IPC 连接断开后会走官方 application.shutdown 优雅关闭，
 *    会话日志得以落盘；带 /T 会把宿主一起强杀，那才是真的丢数据（竞品实测结论）。
 *  - 宿主 pid 已知（process.ppid），主进程退出后定点等它自己退，超时才补刀。
 *  - 拉起前必须按 ENV_DROP 清环境：删掉 ELECTRON_RUN_AS_NODE（否则新实例退化成 node 无窗口），
 *    并清掉 DSH_SESSION_ID / DSH_WEB_URL / DSH_SHELL 这些「上一次运行」的事实（v1.2.1）。
 *  - 拉起时尽量复用主进程原始启动参数（v1.2.1）：先问 WMI「GUI 主进程当初怎么被启动的」，
 *    三重校验不过就不带参数——绝不用自己的 argv（那是 desktop-host 运行器的参数）。
 *  - 拉起后做存活验证并重试，全失败写日志 + 回执 failed 段，并弹系统消息框告知
 *    「请手动打开」（v1.2.1：此时界面已经不存在，弹窗是唯一能把话传到眼前的通道）。
 *  - 拉起成功后观测旧端口是否重新监听（v1.2.1 第 6 项）：进程活着 ≠ 服务起来了，
 *    这一步把盲区记进日志；只观测，不因此判失败（新实例可能合法换端口）。
 *
 * 刻意不做（2026-10-22 决定）：端口卡住时「清掉同 exe 的残留进程」。
 * 我们的流程已按 pid 精确杀主进程、再等宿主优雅退出、超时才定点补杀宿主，端口不会悬空；
 * 替宿主决定「哪个进程该杀」风险大于收益（杀错就是别的安装实例/正在保存的会话）。
 */
export function buildHelperScript(options = {}) {
  const platform = options.platform || 'win32';
  if (platform === 'win32') return buildWindowsHelperScript(options);
  if (platform === 'darwin') return buildMacHelperScript(options);
  throw new TypeError('buildHelperScript: unsupported platform ' + JSON.stringify(platform)
    + ' (supported: ' + HELPER_PLATFORMS.join(', ') + ')');
}
