/**
 * ZCode Pilot 状态栏：性能 / 用量双框指标条 —— 事件流实现（唯一方案）
 * ==========================================================
 * 常驻位置固定：输入框下方 composer-below，左右两个可点击的框：
 *   左「性能」：1轮123步 · 51tok/s
 *   右「用量」：20.7M tok · 缓存命中 97%
 *
 * 点击行为（本次改造）：
 *   - 左框 → 「会话统计」面板：模型用时 / 工具调用用时 / 首 token 平均（TTFT）/ 输出速度（TPS）；
 *   - 右框 → 「Token 用量」面板：缓存命中 / 未缓存输入 / 缓存读取 / 输出（全量精确数字）。
 *   - 面板是 body 级 fixed 节点，锚定所点框、优先向下展开；点击外部或 Esc 收起。
 *
 * 视觉：
 *   - 两个独立圆角框（不是一整条胶囊），框内「主值 + 分隔点 + 次级值」；
 *   - 数值统一 tabular-nums，刷新时不左右跳动；标签/单位弱化，主值高亮；
 *   - 三态可辨：空闲(idle) 静默灰点 / 流式(stream) 绿点呼吸 + 左框底色与描边加强 /
 *     结束(done) 转静默。
 *   - 明暗主题：优先取应用 CSS 变量（--color-foreground 等），缺失时回退到自身变量；
 *     自身变量按「.dark / [data-theme='light'] → prefers-color-scheme」两级判定。
 *   - prefers-reduced-motion：关闭呼吸与过渡动画，改用静态描边区分三态。
 *   - 零外部资源：无字体、无图片、无网络请求，全部样式由本文件注入。
 *
 * 数据口径（全部来自官方事件，不做臆造）：
 *   - 轮数/步数：DOM 可见轮次；步数 = 该轮完成的模型请求数（usage.delta 去重计数）。
 *   - 模型用时/工具调用用时：优先取 turnHeader.modelDurationMs / toolDurationMs 的会话累计；
 *     官方字段缺失时（长工具链轮次、部分客户端版本不会下发）用本地事件时间戳兜底：
 *       genMs     = 连续吐字区间累计（相邻 stream.chunk 间隔 ≤4s 的部分才算模型生成）；
 *       toolWaitMs = 上一次 usage.delta 到下一次开始吐字之间的等待（工具执行/排队）。
 *     兜底值在明细面板里带「≈」前缀，与官方精确值区分。
 *   - 首 token 平均：各轮 (首个 stream.chunk − 本轮开始) 的算术平均。
 *   - 输出速度：已完成轮的精确输出 token ÷ 精确模型生成时长；官方时长缺失时用 genMs；
 *     流式中优先 4s 滑动窗口，窗口不足时退回本轮平均，静默期保持最近一次速度。
 *   - Token 用量：inputTokens（含缓存读取）+ outputTokens；缓存命中 = cacheRead ÷ inputTokens；
 *     未缓存输入 = inputTokens − cacheReadTokens。
 *
 * 数据源（ZCode 主进程经 window.postMessage 转交的 ServicePort 事件流）：
 *   - version:1 事件流：usage.delta（真实 outputTokens/inputTokens）、stream.chunk
 *   - conversation 行事件：turnHeader / userInput / reasoning / assistantText / row.delta
 * 由此得到精确的 tok/s（4s 滑动窗口）、首 token 延迟、out（本轮累计输出）。
 *
 * ⚠️ 关键约束：**绝不调用 port.start()**
 *   MessagePort 队列一旦启用，消息只派发给"启用瞬间已注册的监听器"。本脚本是普通
 *   script（早于 type=module 的应用主包执行），若先 start() 就会消费掉服务端的
 *   Initialize 启动握手 → 应用的协议客户端永远收不到握手 → ZCode 3.12.2 卡在启动界面。
 *   因此只 addEventListener，把 start() 留给应用；届时双方都能收到消息。
 *
 *   真实 Chrome 实测（MessageChannel，双方持有同一 port）：
 *     我们先 start()          → 我们 ["Initialize"]，应用 []            ✗ 卡启动
 *     我们不 start、应用 start → 我们 ["Initialize"]，应用 ["Initialize"] ✓ 正常
 *   注意：不能用 Node 验证此语义——Node 的 MessagePort 在 addEventListener 时隐式
 *   start，会让"不 start"也失败，从而得出错误结论。
 *
 * 已知特性：tok/s 在开始生成后约 1~4 秒才出现（需要滑动窗口内 ≥2 个采样点，且首块到达
 *   前的思考阶段无文本增量可算），期间只显示状态点与时间，属预期。
 *
 * 基于社区分享版本实现，仅删除 port.start() 一行并补充诊断，计算逻辑与原版一致。
 *
 * 安全：只读事件流、只写自己的 host 元素与浮层节点；异常静默；找不到挂载点时自清理。
 * 位置：**固定挂在「输入框下方」**（composer-below）。右键切换位置已按用户要求移除，
 *   历史遗留在 localStorage 的 `ztps-pos` 会在启动时清掉，不再有第二个挂载点分支。
 * 回滚：脚本/补丁异常时用 scripts/zcp_restore.py --latest 秒级还原，无需重装。
 */
(() => {
  if (window.__zcpMeter) return;
  window.__zcpMeter = true;
  const dec = new TextDecoder();
  const MARK = "data-ztps";

  // 位置切换功能已下线：清掉老版本写下的偏好，避免排障时被一个读不到的键误导。
  try { localStorage.removeItem("ztps-pos"); } catch (err) { /* 静默 */ }

  // ---------- 侧边栏/辅助对话与主会话边界判定 ----------
  // 核心诉求：无论何时只挂载在主界面对话框，绝不在侧边栏（辅助对话）来回跳动。
  function isInsideSidePane(el) {
    if (!el || typeof el.closest !== "function") return false;
    try {
      return !!el.closest(
        "[data-workspace-side-frame], " +
        "[data-side-pane-tabs-content], " +
        "[data-side-pane-tab-content], " +
        "[data-side-pane-tabs-viewport], " +
        "[data-workspace-sidebar-panel], " +
        "[data-mobile-side-pane-overlay], " +
        "[data-side-pane-terminal-stash], " +
        "aside, " +
        "[class*='side-pane'], [class*='sidePane'], [class*='sidebar-panel'], [class*='sidebarPanel']"
      );
    } catch (err) { return false; }
  }

  function isInsideMainConversation(el) {
    if (!el || typeof el.closest !== "function") return false;
    try {
      return !!el.closest("[data-workspace-conversation-frame]");
    } catch (err) { return false; }
  }

  // 位置切换（右键菜单 / 工具栏内联 / 会话顶部 sticky）整套已下线：只保留「输入框下方」一个挂载点。
  // 遗留的 `[data-ztps-menu]` 浮层节点由 removeLegacyFooters() 每次渲染时摘除。


  // ---------- 主题兜底 ----------
  // 颜色优先用应用自己的 CSS 变量（--color-foreground 等），一旦某个版本改了变量名，
  // 就退到我们自己的变量上；而我们的变量按「应用主题类（.dark）→ 系统偏好」两级判定，
  // 避免出现「浅色主题 + 深色兜底字色」这种看不清的组合。
  // 视觉规格：分段指标（图标 + 数值 + 单位）、组间发丝线、数值 tabular-nums、三态状态点、悬停明细浮层。
  const STYLE_ID = "ztps-style";
  const STYLE_V = "zcode-pilot-ui-5";
  function ensureStyle() {
    const prev = document.getElementById(STYLE_ID);
    if (prev && prev.getAttribute("data-ztps-style") === STYLE_V) return;
    try {
      if (prev) prev.remove();   // 热注入/升级时替换旧样式，避免新旧规则叠加
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.setAttribute("data-ztps-style", STYLE_V);
      st.textContent = `
/* ============ 令牌：应用变量优先，缺失时用自身兜底（明/暗两套） ============ */
[data-ztps-bar],[data-ztps-pop]{
  --ztps-fg:#0f172a;--ztps-dim:#64748b;--ztps-faint:#94a3b8;
  --ztps-accent:#059669;--ztps-idle:rgba(5,150,105,.45);--ztps-live:#10b981;--ztps-done:#059669;
  --ztps-green-strong:#047857;--ztps-green-soft:#059669;--ztps-green-ink:#065f46;
  --ztps-green-surface:rgba(16,185,129,.10);--ztps-green-surface-2:rgba(16,185,129,.16);
  --ztps-green-line:rgba(16,185,129,.24);--ztps-green-line-strong:rgba(16,185,129,.42);
  --ztps-surface:var(--ztps-green-surface);--ztps-surface-on:var(--ztps-green-surface-2);
  --ztps-hairline:var(--ztps-green-line);--ztps-hairline-on:var(--ztps-green-line-strong);
  --ztps-line:rgba(16,185,129,.22);
  --ztps-canvas:var(--color-background,#ffffff);
  --ztps-bg:rgba(255,255,255,.72);
  --ztps-pop:linear-gradient(155deg,rgba(255,255,255,.94) 0%,rgba(236,253,245,.88) 55%,rgba(255,255,255,.92) 100%);
  --ztps-pop-border:rgba(15,23,42,.10);
  --ztps-pop-glow:rgba(16,185,129,.20);
  --ztps-pop-shadow:0 24px 60px rgba(15,23,42,.18),0 4px 14px rgba(15,23,42,.08),inset 0 1px 0 rgba(255,255,255,.85);
  --ztps-shadow:var(--ztps-pop-shadow);
}
.dark [data-ztps-bar],html.dark [data-ztps-bar],body.dark [data-ztps-bar],
.dark [data-ztps-pop],html.dark [data-ztps-pop],body.dark [data-ztps-pop]{
  --ztps-fg:#ecfdf5;--ztps-dim:rgba(236,253,245,.62);--ztps-faint:rgba(236,253,245,.42);
  --ztps-accent:#34d399;--ztps-idle:rgba(110,231,183,.42);--ztps-live:#34d399;--ztps-done:#10b981;
  --ztps-green-strong:#a7f3d0;--ztps-green-soft:#6ee7b7;--ztps-green-ink:#d1fae5;
  --ztps-green-surface:rgba(52,211,153,.10);--ztps-green-surface-2:rgba(52,211,153,.16);
  --ztps-green-line:rgba(52,211,153,.20);--ztps-green-line-strong:rgba(52,211,153,.38);
  --ztps-line:rgba(52,211,153,.18);
  --ztps-canvas:var(--color-background,#0f172a);
  --ztps-bg:rgba(8,14,12,.72);
  --ztps-pop:linear-gradient(155deg,rgba(20,30,26,.90) 0%,rgba(8,16,13,.94) 55%,rgba(12,22,18,.92) 100%);
  --ztps-pop-border:rgba(255,255,255,.10);
  --ztps-pop-glow:rgba(52,211,153,.18);
  --ztps-pop-shadow:0 28px 70px rgba(0,0,0,.62),0 4px 16px rgba(0,0,0,.40),inset 0 1px 0 rgba(255,255,255,.10);
  --ztps-shadow:var(--ztps-pop-shadow);
}
@media (prefers-color-scheme: dark){
  :root:not(.light):not([data-theme='light']) [data-ztps-bar],
  :root:not(.light):not([data-theme='light']) [data-ztps-pop]{
    --ztps-fg:#ecfdf5;--ztps-dim:rgba(236,253,245,.62);--ztps-faint:rgba(236,253,245,.42);
    --ztps-accent:#34d399;--ztps-idle:rgba(110,231,183,.42);--ztps-live:#34d399;--ztps-done:#10b981;
    --ztps-green-strong:#a7f3d0;--ztps-green-soft:#6ee7b7;--ztps-green-ink:#d1fae5;
    --ztps-green-surface:rgba(52,211,153,.10);--ztps-green-surface-2:rgba(52,211,153,.16);
    --ztps-green-line:rgba(52,211,153,.20);--ztps-green-line-strong:rgba(52,211,153,.38);
    --ztps-line:rgba(52,211,153,.18);
    --ztps-canvas:var(--color-background,#0f172a);
    --ztps-bg:rgba(8,14,12,.72);
    --ztps-pop:linear-gradient(155deg,rgba(20,30,26,.90) 0%,rgba(8,16,13,.94) 55%,rgba(12,22,18,.92) 100%);
    --ztps-pop-border:rgba(255,255,255,.10);
    --ztps-pop-glow:rgba(52,211,153,.18);
    --ztps-pop-shadow:0 28px 70px rgba(0,0,0,.62),0 4px 16px rgba(0,0,0,.40),inset 0 1px 0 rgba(255,255,255,.10);
    --ztps-shadow:var(--ztps-pop-shadow);
  }
}
/* ============ 双框：左性能 / 右用量，各自可点开明细 ============ */
[data-ztps-bar]{
  display:flex;align-items:center;justify-content:center;gap:8px;
  flex-wrap:nowrap;min-width:0;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}
[data-ztps-bar] .ztps-chip{
  display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;min-width:0;
  border-radius:9px;
  /* 不透明主题底色垫在绿色渐变下：胶囊悬在消息滚动区上沿，半透明会被滚过的文字「透视遮挡」 */
  background-color:var(--ztps-canvas);
  background-image:linear-gradient(180deg,var(--ztps-green-surface-2),var(--ztps-green-surface));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 0 0 1px var(--ztps-green-line),0 1px 2px rgba(16,185,129,.08);
  color:var(--ztps-green-strong);
  font-size:11px;line-height:1;letter-spacing:.01em;white-space:nowrap;
  cursor:pointer;user-select:none;
  transition:background-color .22s cubic-bezier(.22,1,.36,1),box-shadow .22s cubic-bezier(.22,1,.36,1),color .22s cubic-bezier(.22,1,.36,1),transform .22s cubic-bezier(.22,1,.36,1);
}
[data-ztps-bar] .ztps-chip:hover{
  color:var(--ztps-green-ink);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.34),inset 0 0 0 1px var(--ztps-green-line-strong),0 6px 18px rgba(16,185,129,.16);
  transform:translateY(-1px);
}
[data-ztps-bar] .ztps-chip:active{transform:translateY(0) scale(.99)}
[data-ztps-bar] .ztps-chip[data-active='1']{
  color:var(--ztps-green-ink);
  background-image:linear-gradient(var(--ztps-green-surface-2),var(--ztps-green-surface-2));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.34),inset 0 0 0 1px var(--ztps-green-line-strong),0 6px 18px rgba(16,185,129,.16);
}
[data-ztps-bar][data-state='stream'] .ztps-chip[data-kind='stats']{
  background-image:linear-gradient(180deg,var(--ztps-green-surface-2),var(--ztps-green-surface));
  box-shadow:inset 0 0 0 1px var(--ztps-green-line-strong);
}
[data-ztps-bar] .ztps-chip-main{color:var(--ztps-green-strong);font-weight:650;letter-spacing:-.01em}
[data-ztps-bar] .ztps-chip-sub{color:var(--ztps-green-soft);font-size:10px;font-weight:500}
[data-ztps-bar] .ztps-chip-sub.ztps-accent{color:var(--ztps-green-strong)}
[data-ztps-bar] .ztps-chip-sep{opacity:.42;color:var(--ztps-green-soft)}
[data-ztps-bar] .ztps-chip.ztps-empty{color:var(--ztps-green-soft)}
/* ============ 状态点：空闲 / 流式(呼吸) / 结束 ============ */
[data-ztps-bar] .ztps-dot,[data-ztps-pop] .ztps-dot{
  flex:0 0 auto;width:6px;height:6px;border-radius:50%;
  background:var(--ztps-idle);box-shadow:0 0 0 0 rgba(22,163,74,0);
  transition:background-color .2s ease,box-shadow .2s ease;
}
[data-ztps-bar][data-state='stream'] .ztps-dot,[data-ztps-pop][data-state='stream'] .ztps-dot{
  background:var(--ztps-live);animation:ztps-breathe 1.7s ease-in-out infinite;
}
[data-ztps-bar][data-state='done'] .ztps-dot,[data-ztps-pop][data-state='done'] .ztps-dot{background:var(--ztps-done)}
@keyframes ztps-breathe{
  0%{box-shadow:0 0 0 0 rgba(22,163,74,.32);opacity:1}
  70%{box-shadow:0 0 0 4px rgba(22,163,74,0);opacity:.66}
  100%{box-shadow:0 0 0 0 rgba(22,163,74,0);opacity:1}
}
/* ============ 点击明细面板 ============ */
[data-ztps-pop]{
  position:fixed;left:0;top:0;z-index:2147483001;pointer-events:auto;
  width:268px;max-width:calc(100vw - 16px);
  padding:14px 16px 12px;border-radius:16px;
  background:var(--ztps-pop);color:var(--ztps-fg);
  border:1px solid var(--ztps-pop-border);
  box-shadow:var(--ztps-pop-shadow);
  -webkit-backdrop-filter:blur(24px) saturate(165%);
  backdrop-filter:blur(24px) saturate(165%);
  font-size:12px;line-height:1.45;white-space:normal;user-select:none;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
  opacity:0;transform:translateY(6px) scale(.98);visibility:hidden;
  transform-origin:top center;
  transition:opacity .22s cubic-bezier(.22,1,.36,1),transform .22s cubic-bezier(.22,1,.36,1),visibility .22s;
}
[data-ztps-pop]::before{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:radial-gradient(120% 90% at 0% 0%,var(--ztps-pop-glow),transparent 58%);
  opacity:.6;
}
[data-ztps-pop][data-placement='top']{transform-origin:bottom center}
[data-ztps-pop][data-show='1']{opacity:1;transform:none;visibility:visible}
[data-ztps-pop] .ztps-pop-h{
  display:flex;align-items:center;gap:8px;
  padding-bottom:10px;margin-bottom:9px;
  border-bottom:1px solid var(--ztps-green-line);
}
[data-ztps-pop] .ztps-pop-ico{
  flex:0 0 auto;width:15px;height:15px;fill:none;stroke:var(--ztps-green-soft);
  stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;opacity:.92;
}
[data-ztps-pop] .ztps-pop-t{font-size:12.5px;font-weight:650;letter-spacing:.01em;color:var(--ztps-green-ink)}
[data-ztps-pop] .ztps-pop-total{
  margin-left:auto;font-size:12px;font-weight:650;color:var(--ztps-green-strong);
  font-variant-numeric:tabular-nums;
}
[data-ztps-pop] .ztps-pop-row{
  display:flex;align-items:baseline;justify-content:space-between;
  gap:16px;padding:4px 0;
}
[data-ztps-pop] .ztps-pop-k{color:var(--ztps-dim)}
[data-ztps-pop] .ztps-pop-v{color:var(--ztps-green-strong);text-align:right;font-weight:550;font-variant-numeric:tabular-nums}
[data-ztps-pop] .ztps-pop-v.ztps-accent{color:var(--ztps-green-strong)}
[data-ztps-pop] .ztps-pop-empty{color:var(--ztps-dim);padding:3px 0 5px}
/* ============ 无障碍：尊重 prefers-reduced-motion（改用静态描边区分流式） ============ */
@media (prefers-reduced-motion: reduce){
  [data-ztps-bar] .ztps-chip,[data-ztps-bar] .ztps-dot,[data-ztps-pop],[data-ztps-pop] .ztps-dot{transition:none!important}
  [data-ztps-bar] .ztps-dot,[data-ztps-pop] .ztps-dot{animation:none!important}
  [data-ztps-bar][data-state='stream'] .ztps-dot,[data-ztps-pop][data-state='stream'] .ztps-dot{box-shadow:0 0 0 3px rgba(22,163,74,.22)}
}
`;
      document.head.appendChild(st);
    } catch (err) { /* 静默 */ }
  }

  const turns = new Map();          // turnId(msg_xxx) -> 轮统计
  const firstChunkByScid = {};
  const rowTurn = new Map();        // rowId -> turnId（row.delta 增量归属）
  const respTurn = new Map();       // assistantResponseId -> turnId（stream.chunk 的 assistantMessageId 归属）
  const scidTurn = new Map();       // sourceCommandId -> turnId（usage.delta 关联兜底）

  const get = (id) => {
    if (!turns.has(id)) turns.set(id, {
      msgId: id, sourceCommandId: null, sessionId: null,
      startedAt: null, endedAt: null, activeMs: null, modelDurationMs: null,
      toolDurationMs: null, otherDurationMs: null,
      firstChunkAt: null, rowFirstAt: null, lastUsageAt: null,
      // 官方时长缺失时的本地兜底：genMs = 连续吐字区间累计（模型生成），
      // toolWaitMs = 上一次请求结束到下一次开始吐字之间的等待（工具执行/排队，偏保守）。
      genMs: 0, toolWaitMs: 0, lastChunkAt: null, waitFrom: null,
      outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
      requestCount: 0, reqIds: new Set(),
      textTok: 0, win: [], modelId: null, streaming: false,
    });
    return turns.get(id);
  };

  // 轮复用（编辑重发/重试复用同一 turnId）时清空上一轮统计，避免旧值残留到新轮
  function resetTurnStats(t) {
    t.endedAt = null; t.activeMs = null; t.modelDurationMs = null;
    t.toolDurationMs = null; t.otherDurationMs = null;
    t.firstChunkAt = null; t.rowFirstAt = null; t.lastUsageAt = null;
    t.genMs = 0; t.toolWaitMs = 0; t.lastChunkAt = null; t.waitFrom = null;
    t.outputTokens = 0; t.inputTokens = 0; t.cacheReadTokens = 0; t.cacheWriteTokens = 0; t.reasoningTokens = 0; t.totalTokens = 0;
    t.requestCount = 0; t.reqIds = new Set();
    t.textTok = 0; t.win = []; t.lastTps = null; t.streaming = true;
  }

  // 本地时长估算的阈值（口径见文件头「数据口径」）：
  //  * 两段吐字间隔 ≤ GEN_GAP_MS 视为同一段模型生成（连续吐字）；
  //  * 工具/排队等待短于 TOOL_MIN_MS 不计（usage 与下一块几乎同时到达，多数是抖动）。
  const GEN_GAP_MS = 4000;
  const TOOL_MIN_MS = 200;

  // token 粗估：CJK 字符 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token
  const estTok = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x2e7f ? 1 : 0.25;
    return Math.round(n);
  };

  const pushWin = (t, ts, tok) => {
    t.win.push([ts, tok]);
    const floor = ts - 6000;
    while (t.win.length > 2 && t.win[0][0] < floor) t.win.shift();
  };

  let scanRaf = 0;
  function scheduleScan() {
    if (scanRaf) return;
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0;
      scan();
    });
  }

  function onRow(row) {
    if (!row) return;
    if (row.op === "row.delta") { onRowDelta(row); return; }
    if (!row.turnId) return;
    const t = get(row.turnId);
    if (row.rowId != null) rowTurn.set(row.rowId, row.turnId);
    if (row.kind === "turnHeader") {
      if ((t.endedAt != null || t.lastUsageAt != null) && row.startedAt && row.startedAt !== t.startedAt) resetTurnStats(t);
      t.startedAt = row.startedAt ?? t.startedAt;
      t.endedAt = row.endedAt ?? t.endedAt;
      t.activeMs = row.activeMs ?? t.activeMs;
      t.modelDurationMs = row.modelDurationMs ?? t.modelDurationMs;
      t.toolDurationMs = row.toolDurationMs ?? t.toolDurationMs;
      t.otherDurationMs = row.otherDurationMs ?? t.otherDurationMs;
      t.streaming = row.state != null && !/^(completedSuccess|completed|failed|stopped|cancelled)/.test(row.state);
      if (row.sourceCommandId) t.sourceCommandId = row.sourceCommandId;
      scheduleScan();
    } else if (row.kind === "userInput") {
      if ((t.endedAt != null || t.lastUsageAt != null) && row.createdAt && row.createdAt !== t.startedAt) resetTurnStats(t);
      t.startedAt = row.createdAt ?? t.startedAt;
      t.streaming = true;
      if (row.sourceCommandId) t.sourceCommandId = row.sourceCommandId;
      scheduleScan();
    } else if (row.kind === "reasoning" || row.kind === "assistantText") {
      if (row.assistantResponseId) respTurn.set(row.assistantResponseId, row.turnId);
      if (row.text && row.text.length) t.textTok = estTok(row.text);   // 全量覆盖，防增量累计漂移
      if (t.firstChunkAt == null && t.rowFirstAt == null && row.createdAt) {
        t.rowFirstAt = row.createdAt;   // 兜底首块（优先 stream.chunk）
      }
    }
  }

  function onRowDelta(row) {
    if (row.path !== "text" || !row.append) return;
    const turnId = rowTurn.get(row.rowId);
    if (!turnId) return;
    const t = turns.get(turnId);
    if (!t) return;
    t.textTok += estTok(row.append);
    pushWin(t, Date.now(), t.textTok);
  }

  function onEvent(ev) {
    if (!ev || ev.version !== 1) return;
    const scid = ev.sourceCommandId;
    if (ev.kind === "usage.delta") {
      if (!scid) return;
      const t = findByScid(scid) || turns.get(scidTurn.get(scid));
      if (!t) return;
      // 步数 = 已完成的模型请求数。官方可能因重连/重放重复下发同一 requestId，
      // 这里按 requestId 去重，避免「步数」和 token 被重复累计。
      if (ev.requestId) {
        if (t.reqIds.has(ev.requestId)) return;
        t.reqIds.add(ev.requestId);
      }
      t.requestCount += 1;
      t.outputTokens += ev.outputTokens || 0;
      t.inputTokens += ev.inputTokens || 0;
      t.cacheReadTokens += ev.cacheReadTokens || 0;
      t.cacheWriteTokens += ev.cacheWriteTokens || 0;
      t.reasoningTokens += ev.reasoningTokens || 0;
      t.totalTokens += ev.totalTokens || 0;
      t.modelId = ev.modelId || t.modelId;
      if (t.modelId && typeof window !== "undefined") {
        window.__zcpMeterModelId = t.modelId;
      }
      t.sessionId = ev.sessionId || t.sessionId;
      t.lastUsageAt = ev.occurredAt ?? t.lastUsageAt;
      // 一个模型请求结束 → 到下一个请求开始吐字之前的空档，估算为工具执行/排队用时。
      t.waitFrom = ev.occurredAt ?? Date.now();
      if (t.firstChunkAt == null && firstChunkByScid[scid] != null) {
        t.firstChunkAt = firstChunkByScid[scid];
      }
      scheduleScan();
    } else if (ev.kind === "stream.chunk") {
      if (firstChunkByScid[scid] == null) firstChunkByScid[scid] = ev.occurredAt;
      let t = findByScid(scid);
      if (!t && ev.assistantMessageId) {
        const tid = respTurn.get(ev.assistantMessageId);
        if (tid) { t = turns.get(tid); if (t && scid) scidTurn.set(scid, tid); }
      }
      if (!t && scid && scidTurn.has(scid)) t = turns.get(scidTurn.get(scid));
      if (!t) return;
      if (t.firstChunkAt == null) t.firstChunkAt = firstChunkByScid[scid];
      t.sessionId = ev.sessionId || t.sessionId;
      t.streaming = true;   // turnHeader 未到时也标记生成中

      // ★ 本地计时兜底：官方 modelDurationMs / toolDurationMs 并非所有客户端版本、
      //   所有轮次都会下发（长工具链的轮次尤其常见只有 usage 没有 header 时长）。
      //   用吐字间隔累计「模型生成时长」，用「上一次请求结束 → 本次首块」累计工具等待，
      //   保证 107 步的长轮也不会在面板里全是「—」。
      const at = Number(ev.occurredAt) || Date.now();
      if (t.lastChunkAt != null) {
        const dt = at - t.lastChunkAt;
        if (dt > 0 && dt <= GEN_GAP_MS) t.genMs += dt;
      }
      if (t.waitFrom != null) {
        const wait = at - t.waitFrom;
        if (wait >= TOOL_MIN_MS) t.toolWaitMs += wait;
        t.waitFrom = null;
      }
      t.lastChunkAt = at;

      pushWin(t, at, t.textTok);   // 心跳采样，保证窗口时间轴连续
    }
  }

  const findByScid = (scid) => {
    // 先走映射表（usage.delta 每条都要调，原来是无脑全表扫描）
    if (scidTurn.has(scid)) {
      const t = turns.get(scidTurn.get(scid));
      if (t && t.sourceCommandId === scid) return t;
    }
    for (const t of turns.values()) if (t.sourceCommandId === scid) return t;
    return null;
  };

  function handleFrame(data) {
    try {
      let d = data;
      if (d == null) return;
      if (d instanceof ArrayBuffer) d = new Uint8Array(d);
      if (!ArrayBuffer.isView(d)) return;
      const txt = dec.decode(d);
      const i = txt.indexOf("{");
      if (i < 0) return;
      const j = JSON.parse(txt.slice(i));
      if (j.version === 1) { onEvent(j); return; }
      const payload = j.frame && j.frame.payload;
      if (!payload) return;
      const evs = payload.events || payload.deltas || [];
      for (const e of evs) {
        if (e.row) onRow(e.row);
        else if (e.op === "row.appended" || e.op === "row.upserted" || e.op === "row.delta") onRow(e.row || e);
      }
    } catch (err) { /* 静默 */ }
  }

  // ---------- 格式化 ----------
  const fmtTps = (v) => (v >= 10 ? String(Math.round(v)) : String(+Number(v || 0).toFixed(1)));
  // 框内缩写：20.7M tok（M/B 大写，k 小写），与截图口径一致
  const fmtTok = (v) => {
    const n = Number(v) || 0;
    if (n < 1e3) return String(Math.round(n));
    const trim = (x) => String(+x.toFixed(x < 10 ? 1 : 0));
    if (n < 1e6) return trim(n / 1e3) + "k";
    if (n < 1e9) return trim(n / 1e6) + "M";
    return trim(n / 1e9) + "B";
  };
  // 明细面板用全量数字：20,684,917 tok（不做 k/M 缩写）
  const fmtFull = (v) => {
    const n = Math.max(0, Math.round(Number(v) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };
  // 命中率取整（截图口径 97%）
  const fmtPctInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n)) : "0";
  };
  // 中文时长：49分3秒 / 8分53秒 / 42秒
  const fmtSpanCN = (ms) => {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + "秒";
    return Math.floor(s / 60) + "分" + (s % 60) + "秒";
  };
  // 首 token 平均：8.3秒（10 秒内保留一位小数），更长沿用中文时分秒
  const fmtLatCN = (ms) => {
    const s = Math.max(0, (ms || 0) / 1000);
    if (s > 0 && s < 10) return (Math.round(s * 10) / 10).toFixed(1) + "秒";
    return fmtSpanCN(ms);
  };
  function statsOf(t) {
    const firstAt = t.firstChunkAt ?? t.rowFirstAt ?? null;
    const ttft = firstAt != null && t.startedAt != null ? firstAt - t.startedAt : null;
    let out = t.outputTokens;
    if (out === 0 && t.textTok > 0) out = t.textTok;   // 中止/失败未报 usage：以内容估算兜底
    const reasoning = t.reasoningTokens || 0;
    let tps = null;
    if (t.streaming) {
      out = Math.max(out, t.textTok);   // 流式中 usage 未到，用内容估算补齐（精确值到达后自然切换）
      const now = Date.now();
      const win = t.win.filter((w) => now - w[0] <= 4000);
      if (win.length >= 2) {
        const dt = (win[win.length - 1][0] - win[0][0]) / 1000;
        const dtok = win[win.length - 1][1] - win[0][1];
        if (dt >= 1 && dtok > 0) tps = dtok / dt;
      }
      // 实时窗口不够（刚起步 / 工具链路较长）→ 用本地累计生成时长给平均速度，
      // 避免长轮次在静默期只能显示「—」。
      if (tps == null && t.genMs > 800 && out > 0) tps = out / (t.genMs / 1000);
      if (tps == null && t.lastTps != null) tps = t.lastTps;   // 工具执行等静默期：保持最近速度
    } else {
      // 优先使用官方下发的精确 modelDurationMs 校准全轮纯模型生成速率
      if (t.modelDurationMs != null && t.modelDurationMs > 500 && t.outputTokens > 0) {
        tps = t.outputTokens / (t.modelDurationMs / 1000);
      } else if (t.genMs > 800 && out > 0) {
        // 官方没给时长（长工具链轮次常见）→ 本地累计生成时长兜底
        tps = out / (t.genMs / 1000);
      } else {
        const decodeFrom = firstAt ?? t.startedAt;
        const decodeMs = decodeFrom != null && t.lastUsageAt != null ? t.lastUsageAt - decodeFrom : null;
        tps = t.outputTokens > 0 && decodeMs > 500 ? t.outputTokens / (decodeMs / 1000) : null;
      }
      if (tps == null && t.lastTps != null) tps = t.lastTps;
    }
    if (tps != null) t.lastTps = tps;
    return {
      ttft, tps, out, reasoning,
      streaming: t.streaming,
      // 官方时长缺失、用了本地估算时标记出来（面板显示「≈」）
      modelApprox: !(t.modelDurationMs != null && t.modelDurationMs > 0) && t.genMs > 0,
      toolApprox: !(t.toolDurationMs != null && t.toolDurationMs > 0) && t.toolWaitMs > 0,
    };
  }

  const hasActivity = (t) => t.streaming || t.textTok > 0 || t.outputTokens > 0;

  // ---------- 渲染 ①: 输入框下方常驻胶囊（当前会话最近一轮 + 会话累计） ----------
  // 挂载基准 = composer 卡片（v4-composer）：胶囊作为卡片的下一个兄弟节点，与输入框同宽。
  // 历史：曾支持「工具栏行内 / 会话顶部 sticky」两种额外落点，实测会被误认成官方控件、
  // 且遮挡会话标题行，已按用户要求下线 —— 位置固定，不可更改。
  // 诊断：window.__zcpMeterDiag 暴露每一环的探测结果（选择器命中数/是否找到卡片），
  // 版本升级后若胶囊消失，先在 console 看该对象定位失败环节。
  const COMPOSER_INPUT_SELECTORS = [
    "[data-testid='v4-composer-input']",
    "[data-testid*='composer-input']",
    "textarea[data-testid]",
    "form textarea",
    "textarea",
  ];

  function findComposerInput() {
    const tried = [];
    for (const sel of COMPOSER_INPUT_SELECTORS) {
      let hit = null;
      try {
        let els = Array.from(document.querySelectorAll(sel));
        if (els.length) {
          // ① 严格剔除侧边栏/辅助对话中的输入框，绝不将状态栏挂入侧边栏
          els = els.filter((e) => !isInsideSidePane(e));
          if (els.length) {
            // ② 优先取处于主会话容器 [data-workspace-conversation-frame] 内的输入框
            const mainEls = els.filter(isInsideMainConversation);
            const pool = mainEls.length ? mainEls : els;
            if (pool.length === 1) {
              hit = pool[0];
            } else {
              const vis = pool.filter((e) => e.offsetParent != null);
              const candidates = vis.length ? vis : pool;
              if (candidates.length === 1) {
                hit = candidates[0];
              } else {
                // ③ 排序准则：以最靠下为主要准则；但当纵向坐标极度接近（<20px，左右并排）时，
                //    绝对优先选择靠左（主工作区，left 较小）的主会话输入框，彻底杜绝跳动
                candidates.sort((a, b) => {
                  const ra = a.getBoundingClientRect();
                  const rb = b.getBoundingClientRect();
                  const dTop = rb.top - ra.top;
                  if (Math.abs(dTop) > 20) return dTop;
                  return ra.left - rb.left;
                });
                hit = candidates[0];
              }
            }
          }
        }
      } catch (err) { /* 选择器不合法，跳过 */ }
      tried.push({ selector: sel, count: hit ? 1 : 0 });
      if (hit) return { el: hit, tried };
    }
    return { el: null, tried };
  }

  // composer 卡片(v4-composer):工具栏行与「输入框下方」条共用的定位基准
  function findComposerCard() {
    const { el: ta, tried } = findComposerInput();
    if (diag) {
      diag.inputTried = tried;
      diag.inputFound = !!ta;
    }
    if (!ta) return null;
    let card = null;
    try { card = ta.closest("[data-testid='v4-composer']"); } catch (err) { /* ignore */ }
    if (!card) card = ta.closest("form") ? ta.closest("form").parentElement : null;
    if (!card) card = ta.parentElement;
    if (card && isInsideSidePane(card)) return null;   // 侧边栏卡片直接拒收
    return card || null;
  }

  // 诊断对象（console 里直接看 window.__zcpMeterDiag）
  let diag = null;
  try {
    diag = window.__zcpMeterDiag = window.__zcpMeterDiag || {};
    diag.scriptVersion = "3.17-pilot-ui-5";
    diag.loadedAt = new Date().toISOString();
  } catch (err) { /* ignore */ }

  // ---------- 小图标（内联 SVG，零外部资源） ----------
  // 图标只回答「这一段数字是什么」，跟随胶囊基色并整体降透明度，绝不与数值抢视觉权重。
  const NS_SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    lat: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.5 1.5"/><path d="M9.5 2.5h5"/>',
    tps: '<path d="M13 3 5 13.5h5L8.5 21 17 10.5h-5z"/>',
    think: '<path d="M12 3a5.5 5.5 0 0 0-3.2 9.9 3 3 0 0 0 .9 2.1h4.6a3 3 0 0 0 .9-2.1A5.5 5.5 0 0 0 12 3z"/><path d="M10 18.5h4"/><path d="M10.8 21h2.4"/>',
    rounds: '<path d="M4 6.5h16"/><path d="M4 12h16"/><path d="M4 17.5h10"/>',
    total: '<path d="M12 3.5c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z"/><path d="M4 6.5v11c0 1.7 3.6 3 8 3s8-1.3 8-3v-11"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    input: '<path d="M12 3.5v9"/><path d="M8 8.5l4 4 4-4"/><path d="M4 18.5h16"/>',
    output: '<path d="M12 20.5v-9"/><path d="M8 15.5l4-4 4 4"/><path d="M4 5.5h16"/>',
  };
  function icon(name, cls) {
    const svg = document.createElementNS(NS_SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", cls || "ztps-ico");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICONS[name] || "";
    return svg;
  }

  // ---------- 挂载点（固定：输入框下方一行，不可更改） ----------
  // host(含内层 pill) 作为 composer 卡片的下一个兄弟节点，与输入框同宽：
  // 承载「本轮即时指标 + 会话累计」，永远不进入工具栏行，也不吸顶到会话区。
  // 历史：曾支持 toolbar(工具栏行内居中) / session-top(消息区 sticky) 两种落点，
  // 实测会被误认成官方控件并遮挡会话标题行，已按用户要求彻底下线。
  const MODE = "composer-below";
  // 宿主内联样式的布局版本：样式规则升级后即使挂载位置没变，也要绕过快路径重写一次
  //   v2（2026-11-13）：去掉 translateY —— 实测它是「滚动时被裁一半」的根因。
  //   v3：补 margin-bottom 余量，但胶囊仍在时间线内，距窗体底 23px，用户反馈「太高」。
  //   v4（2026-11-13 CDP 实测）：把宿主挂到滚动容器 v4-timeline 之外，才能真正贴底。
  const LAYOUT_V = "ztps-layout-4";
  function attach(host) {
    const card = findComposerCard();
    if (!card || !card.parentElement || isInsideSidePane(card)) return false;
    // ★ 贴底关键：v4-timeline 是 overflow-y:auto 的滚动容器，胶囊挂在它**里面**时永远被
    //   裁在它的底边 —— 而那条底边距窗体底还隔着父容器 pb-4 的 16px + 窗体自身 7px，
    //   所以怎么调 margin 都「悬空/太高」。把宿主挂到时间线**之外**（作它的 flex 兄弟），
    //   再用「负 margin-bottom = 父容器底部 padding」把它拉进 padding 区，胶囊才真正贴到
    //   窗体底（CDP 实测距底 7px）；时间线 flex-1 自动让位，无裁切、不压输入卡片。
    //   找不到时间线（空态/设置页等）时退回「卡片之后」的旧落点，保证不丢胶囊。
    let tl = null;
    try { tl = card.closest('[data-testid="v4-timeline"]'); } catch (err) { /* ignore */ }
    const outside = !!(tl && tl.parentElement);
    const anchor = outside ? tl : card;
    const styled = host.getAttribute("data-ztps-layout") === LAYOUT_V;
    const inPlace = host.getAttribute("data-ztps-mode") === MODE && host.isConnected &&
        host._target === anchor && host.previousElementSibling === anchor;
    // 快路径：位置与样式都对 → 同步宽度与负 margin。
    // ★ 负 margin 必须每拍重算：初次挂载常发生在加载期，父容器 pb-4 还没生效（padB=0），
    //   若只在首次写死，margin 会永远停在 0、胶囊悬空 23px。窗口缩放/主题切换同理。
    if (styled && inPlace) {
      if (outside) {
        host.style.width = Math.round(card.getBoundingClientRect().width) + "px";
        const padB = parseFloat(getComputedStyle(anchor.parentElement).paddingBottom) || 0;
        host.style.marginBottom = (-padB) + "px";
      }
      return true;
    }
    if (!inPlace) {
      anchor.insertAdjacentElement("afterend", host);
      host.setAttribute("data-ztps-mode", MODE);
    }
    host.style.cssText = "";
    if (outside) {
      const padB = parseFloat(getComputedStyle(anchor.parentElement).paddingBottom) || 0;
      Object.assign(host.style, {
        display: "flex", justifyContent: "center", alignItems: "center",
        width: Math.round(card.getBoundingClientRect().width) + "px",
        alignSelf: "center", flex: "0 0 auto",
        marginTop: "3px", marginBottom: (-padB) + "px", padding: "0",
        position: "relative", zIndex: "5", pointerEvents: "auto",
      });
    } else {
      Object.assign(host.style, {
        display: "flex", justifyContent: "center", alignItems: "center",
        marginTop: "3px", marginBottom: "0px", padding: "0",
        position: "relative", zIndex: "5",
        alignSelf: "stretch", pointerEvents: "auto",
      });
    }
    host.setAttribute("data-ztps-layout", LAYOUT_V);
    host._target = anchor;
    host.querySelectorAll("[data-ztps-chip]").forEach((chip) => {
      chip.style.pointerEvents = "auto";
    });
    return true;
  }

  // 两个框共用一套结构：主值 · 次级值；左框带状态点，点击各自展开明细。
  function makeChip(kind, title) {
    const chip = document.createElement("div");
    chip.className = "ztps-chip";
    chip.setAttribute("data-kind", kind);
    chip.setAttribute("data-ztps-chip", kind);
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
    chip.setAttribute("aria-haspopup", "dialog");
    chip.setAttribute("aria-expanded", "false");
    chip.title = title;
    chip.addEventListener("contextmenu", (e) => e.preventDefault());
    const activate = (e) => { e.stopPropagation(); togglePop(kind, chip); };
    chip.addEventListener("click", activate);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        activate(e);
      }
    });
    return chip;
  }

  function paintChip(chip, main, sub, opts) {
    const o = opts || {};
    const key = [main, sub, o.accent ? "a" : "", o.dot ? "d" : ""].join("|");
    if (chip._zkey === key) return;
    chip._zkey = key;
    chip.innerHTML = "";
    if (o.dot) chip.appendChild(makeDot());
    const m = document.createElement("span");
    m.className = "ztps-chip-main";
    m.textContent = main;
    chip.appendChild(m);
    const sep = document.createElement("span");
    sep.className = "ztps-chip-sep";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "·";
    chip.appendChild(sep);
    const sb = document.createElement("span");
    sb.className = "ztps-chip-sub" + (o.accent ? " ztps-accent" : "");
    sb.textContent = sub;
    chip.appendChild(sb);
  }

  function renderBar() {
    try {
      // 只认当前主会话 DOM 里可见的轮次——排除侧边栏辅助对话的轮次干扰
      const mainFrame = document.querySelector("[data-workspace-conversation-frame]");
      let domSess = null;
      if (mainFrame) {
        domSess = mainFrame.getAttribute("data-session-id");
        if (!domSess) {
          const innerSess = mainFrame.querySelector("[data-session-id]");
          if (innerSess) domSess = innerSess.getAttribute("data-session-id");
        }
      }

      const visible = new Set();
      // 只有在内存中有轮次数据时才扫描可见 DOM；若 turns 为空（新启动/仅看历史），直接跳过数百个节点的 DOM 遍历
      if (turns.size > 0) {
        if (mainFrame) {
          mainFrame.querySelectorAll("section[data-turn-id]").forEach((el) => {
            visible.add(el.getAttribute("data-turn-id"));
          });
        } else {
          document.querySelectorAll("section[data-turn-id]").forEach((el) => {
            if (!isInsideSidePane(el)) visible.add(el.getAttribute("data-turn-id"));
          });
        }
      }
      lastVisible = visible;
      // 会话累计（只统计当前主会话 DOM 里可见的轮次）：
      // 轮数 / 步数（模型请求数）/ Token / 模型用时 / 工具调用用时 / 首 token 样本
      const agg = {
        rounds: 0, steps: 0, input: 0, cache: 0, cacheWrite: 0, reasoning: 0, output: 0,
        modelMs: 0, modelOut: 0, toolMs: 0, ttftSum: 0, ttftCount: 0,
        // 官方时长缺失、用了本地估算 → 面板显示「≈」
        modelApprox: false, toolApprox: false,
      };
      let latest = null;
      for (const t of turns.values()) {
        if (!visible.has(t.msgId)) continue;
        // 轮次归属会话与当前显示会话不符时排除(会话切换的 DOM 中间态残留兜底)
        if (t.sessionId && domSess && t.sessionId !== domSess) continue;
        if (t.startedAt != null || hasActivity(t)) agg.rounds++;
        agg.steps += t.requestCount || 0;
        agg.input += t.inputTokens || 0;
        agg.cache += t.cacheReadTokens || 0;
        agg.cacheWrite += t.cacheWriteTokens || 0;
        agg.reasoning += t.reasoningTokens || 0;
        // 流式中 usage 未到的轮以内容估算兜底,精确值到达后自然覆盖
        agg.output += Math.max(t.outputTokens || 0, t.streaming ? (t.textTok || 0) : 0);
        // 速度优先用「已完成且官方给了精确模型时长」的轮；官方没给时退回本地累计生成时长
        // （长工具链轮次经常只有 usage、没有 header 时长，否则整轮 TPS 永远是空的）。
        const modelMs = (t.modelDurationMs != null && t.modelDurationMs > 0)
          ? t.modelDurationMs : (t.genMs || 0);
        if (modelMs > 0) {
          agg.modelMs += modelMs;
          agg.modelOut += t.outputTokens || 0;
          if (!(t.modelDurationMs != null && t.modelDurationMs > 0)) agg.modelApprox = true;
        }
        const toolMs = (t.toolDurationMs != null && t.toolDurationMs > 0)
          ? t.toolDurationMs : (t.toolWaitMs || 0);
        if (toolMs > 0) {
          agg.toolMs += toolMs;
          if (!(t.toolDurationMs != null && t.toolDurationMs > 0)) agg.toolApprox = true;
        }
        const firstAt = t.firstChunkAt ?? t.rowFirstAt;
        const ttft = firstAt != null && t.startedAt != null ? firstAt - t.startedAt : null;
        if (ttft != null && ttft >= 0) { agg.ttftSum += ttft; agg.ttftCount++; }
        if (!latest || (t.startedAt ?? 0) > (latest.startedAt ?? 0)) latest = t;
      }
      // 会话级输出速度：流式中优先本轮实时窗口（反应最快）；否则用已完成轮的精确口径
      // （官方 modelDurationMs 优先，缺失时退回本地累计生成时长 genMs）。
      // 这里只算一次 statsOf：它同时维护 lastTps（静默期保持最近速度）。
      const live = latest ? statsOf(latest) : null;
      let tps = null;
      if (latest && latest.streaming && live && live.tps != null) {
        tps = live.tps;
      } else if (agg.modelMs > 500 && agg.modelOut > 0) {
        tps = agg.modelOut / (agg.modelMs / 1000);
      } else if (live && live.tps != null) {
        tps = live.tps;
      }
      let host = document.querySelector("[" + MARK + "-bar]");
      if (diag) {
        diag.domSessionId = domSess;
        diag.visibleTurns = visible.size;
        diag.turnStats = turns.size;
        diag.latestFound = !!latest;
        diag.attachMode = MODE;
        if (latest) {
          diag.latest = {
            msgId: latest.msgId, sessionId: latest.sessionId,
            startedAt: latest.startedAt, endedAt: latest.endedAt,
            streaming: latest.streaming, out: latest.outputTokens, textTok: latest.textTok,
            reasoning: latest.reasoningTokens,
          };
        }
        diag.hostAttached = !!host;
      }
      // 数据态:轮次有时间戳或生成活动;空态:当前会话无任何轮次(新会话/未对话)。
      // 状态栏常驻:空态显示「TPS 待命」(空闲静态),不拿当前时间冒充轮次时间
      const hasData = !!latest && (hasActivity(latest) || latest.endedAt != null || latest.startedAt != null);
      if (diag) diag.hiddenReason = hasData ? null : "空态(无轮次数据)";
      if (!host) {
        host = document.createElement("div");
        host.setAttribute("data-ztps-bar", "1");
        host.setAttribute("data-ztps-mode", MODE);
        host.setAttribute("data-state", "idle");
        host.appendChild(makeChip("stats", "点击查看会话统计"));
        host.appendChild(makeChip("tokens", "点击查看 Token 用量"));
      }
      // 挂载点失效(输入框卡片不在了：新建任务空态、设置页等)→ 移除,杜绝旧内容残留
      if (!attach(host)) {
        if (diag) diag.hiddenReason = "挂载点未找到(" + MODE + ")";
        closePop();
        host.remove();
        return;
      }
      const statsChip = host.querySelector("[data-ztps-chip='stats']");
      const tokensChip = host.querySelector("[data-ztps-chip='tokens']");
      const s = live;   // 上面已算过（同一次渲染内复用，避免重复结算 lastTps）
      const streaming = !!(s && s.streaming);
      const totalTok = (agg.input || 0) + (agg.output || 0);
      const hitPct = agg.input > 0 ? (agg.cache / agg.input) * 100 : null;
      lastView = { t: latest, s, agg, tps, totalTok, hitPct, empty: !hasData };

      host.setAttribute("data-state", hasData ? (streaming ? "stream" : "done") : "idle");

      if (statsChip) {
        paintChip(
          statsChip,
          `${agg.rounds}轮${agg.steps}步`,
          tps != null ? `${fmtTps(tps)}tok/s` : "—tok/s",
          { dot: true, accent: streaming && tps != null }
        );
      }
      if (tokensChip) {
        paintChip(
          tokensChip,
          `${fmtTok(totalTok)} tok`,
          hitPct != null ? `缓存命中 ${fmtPctInt(hitPct)}%` : "缓存命中 —",
          { dot: true }
        );
      }
      // 面板开着时同步刷新数字（内容签名未变时零 DOM 写入）
      refreshPop();
    } catch (err) { /* 静默 */ }
  }

  // ---------- 渲染 ②: 清理历史遗留的逐轮统计行（统计只在工具栏展示） ----------
  // 轮次表回收：turns / rowTurn / respTurn / scidTurn / firstChunkByScid 原来只增不删，
  // 长会话或长时间挂着会一直涨。规则：不在当前可见轮次里、且 30 分钟没有活动的记录删掉。
  const PRUNE_MS = 30 * 60 * 1000;
  let lastVisible = null;
  function prune() {
    const now = Date.now();
    for (const [id, t] of turns) {
      if (lastVisible && lastVisible.has(id)) continue;
      const last = t.lastUsageAt || t.endedAt || t.startedAt || 0;
      if (now - last <= PRUNE_MS) continue;
      turns.delete(id);
      if (t.sourceCommandId) scidTurn.delete(t.sourceCommandId);
      for (const [rid, tid] of rowTurn) if (tid === id) rowTurn.delete(rid);
      for (const [rid, tid] of respTurn) if (tid === id) respTurn.delete(rid);
    }
    for (const k of Object.keys(firstChunkByScid)) {
      if (!scidTurn.has(k) && now - (firstChunkByScid[k] || 0) > PRUNE_MS) delete firstChunkByScid[k];
    }
  }

  function removeLegacyFooters() {
    try {
      // 任何误落入侧边栏/辅助对话中的 bar 节点，强制摘除
      document.querySelectorAll(`[${MARK}-bar]`).forEach((el) => {
        if (isInsideSidePane(el)) el.remove();
      });
      document.querySelectorAll(`[${MARK}]:not([data-ztps-bar])`).forEach((el) => el.remove());
      // 位置切换菜单已下线：老版本遗留的 `[data-ztps-menu]` 浮层一并摘除
      document.querySelectorAll("[data-ztps-menu]").forEach((el) => el.remove());
      // 面板是 body 级 fixed 节点，锚点(框)消失时必须一并回收，避免留下孤儿面板
      if (popEl && popChip && !popChip.isConnected) dropPop();
    } catch (err) { /* 静默 */ }
  }

  // ---------- 渲染 ③: 点击明细面板（左框=会话统计，右框=Token 用量） ----------
  // 面板挂在 body：框自身 overflow 不会裁掉它；fixed 定位跟随所点框。
  // 与旧版悬停浮层的区别：现在可点击、可驻留，点击外部或 Esc 才收起。
  let popEl = null, popChip = null, popKind = null, popKey = "", lastView = null;
  const POP_AUTO_CLOSE_MS = 15000;   // 无操作 15s 自动收起；移动/点击/聚焦会重新计时
  let popTimer = 0;
  let popScrollTick = 0;
  if (diag) diag.popAutoCloseMs = POP_AUTO_CLOSE_MS;

  function clearPopTimer() {
    if (popTimer) { try { clearTimeout(popTimer); } catch (err) { /* 静默 */ } popTimer = 0; }
    if (popScrollTick) { try { clearTimeout(popScrollTick); } catch (err) { /* 静默 */ } popScrollTick = 0; }
  }
  function armPopTimer() {
    clearPopTimer();
    popTimer = setTimeout(() => {
      popTimer = 0;
      if (popEl && popEl.getAttribute("data-show") === "1") closePop();
    }, POP_AUTO_CLOSE_MS);
  }

  function makeDot() {
    const d = document.createElement("span");
    d.className = "ztps-dot";
    d.setAttribute("aria-hidden", "true");
    return d;
  }

  function dropPop() {
    clearPopTimer();
    if (popEl) { try { popEl.remove(); } catch (err) { /* 静默 */ } }
    popEl = null; popChip = null; popKind = null; popKey = "";
  }

  function closePop() {
    clearPopTimer();
    if (popEl && popEl.getAttribute("data-show") === "1") popEl.setAttribute("data-show", "0");
    if (popChip) {
      popChip.setAttribute("data-active", "0");
      popChip.setAttribute("aria-expanded", "false");
    }
    popKind = null; popKey = "";
  }

  function ensurePop(chip) {
    if (popEl && popChip === chip && popEl.isConnected) return popEl;
    dropPop();
    const p = document.createElement("div");
    p.setAttribute("data-ztps-pop", "1");
    p.setAttribute("data-show", "0");
    p.setAttribute("role", "dialog");
    document.body.appendChild(p);
    popEl = p; popChip = chip;
    return p;
  }

  function popRow(g, k, v, cls) {
    if (v == null || v === "") return;
    const row = document.createElement("div");
    row.className = "ztps-pop-row";
    const a = document.createElement("span");
    a.className = "ztps-pop-k"; a.textContent = k;
    const b = document.createElement("span");
    b.className = "ztps-pop-v" + (cls ? " " + cls : "");
    b.textContent = v;
    row.appendChild(a); row.appendChild(b);
    g.appendChild(row);
  }

  function popHeader(iconName, title, total) {
    const h = document.createElement("div");
    h.className = "ztps-pop-h";
    h.appendChild(icon(iconName, "ztps-pop-ico"));
    const t = document.createElement("span");
    t.className = "ztps-pop-t"; t.textContent = title;
    h.appendChild(t);
    if (total != null) {
      const m = document.createElement("span");
      m.className = "ztps-pop-total"; m.textContent = total;
      h.appendChild(m);
    }
    return h;
  }

  // 面板内容签名：数据没变时避免每次 500ms 巡检都重写 DOM
  function popKeyOf(kind, v) {
    if (!v) return "";
    const a = v.agg;
    if (kind === "tokens") return ["t", a.input, a.output, a.cache].join("|");
    return ["s", a.modelMs, a.modelApprox ? "≈" : "", a.toolMs, a.toolApprox ? "≈" : "",
            a.ttftSum, a.ttftCount,
            v.tps == null ? "" : Math.round(v.tps)].join("|");
  }

  function buildPop(kind) {
    if (!popEl || !lastView) return;
    const agg = lastView.agg;
    popEl.innerHTML = "";

    if (kind === "tokens") {
      const total = (agg.input || 0) + (agg.output || 0);
      popEl.appendChild(popHeader("total", "Token 用量", `${fmtFull(total)} tok`));
      if (agg.input === 0 && agg.output === 0) {
        const empty = document.createElement("div");
        empty.className = "ztps-pop-empty";
        empty.textContent = "发起一轮对话后显示";
        popEl.appendChild(empty);
        return;
      }
      const g = document.createElement("div");
      const uncached = Math.max(0, (agg.input || 0) - (agg.cache || 0));
      popRow(g, "缓存命中", lastView.hitPct != null ? `${fmtPctInt(lastView.hitPct)}%` : "—");
      popRow(g, "未缓存输入", `${fmtFull(uncached)} tok`);
      popRow(g, "缓存读取", `${fmtFull(agg.cache)} tok`);
      popRow(g, "输出", `${fmtFull(agg.output)} tok`);
      popEl.appendChild(g);
      return;
    }

    // 会话统计
    popEl.appendChild(popHeader("lat", "会话统计", null));
    const g = document.createElement("div");
    const avgTtft = agg.ttftCount > 0 ? agg.ttftSum / agg.ttftCount : null;
    // 官方没下发精确时长时用本地累计值兜底，前缀「≈」明示是估算口径。
    popRow(g, "模型用时", agg.modelMs > 0
      ? (agg.modelApprox ? "≈" : "") + fmtSpanCN(agg.modelMs) : "—");
    popRow(g, "工具调用用时", agg.toolMs > 0
      ? (agg.toolApprox ? "≈" : "") + fmtSpanCN(agg.toolMs) : "—");
    popRow(g, "首 token 平均（TTFT）", avgTtft != null ? fmtLatCN(avgTtft) : "—");
    popRow(g, "输出速度（TPS）", lastView.tps != null ? `${fmtTps(lastView.tps)} tok/s` : "—");
    popEl.appendChild(g);
  }

  // 定位：优先后展开到框下方；下方放不下才翻到框上方，最后贴视口内收敛。
  function placePop() {
    if (!popEl || !popChip) return;
    const r = popChip.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, M = 8, GAP = 8;
    const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
    let left = Math.min(Math.max(M, r.left), Math.max(M, vw - M - pw));
    let top = r.bottom + GAP;
    if (top + ph > vh - M) top = Math.max(M, r.top - GAP - ph);
    popEl.setAttribute("data-placement", top < r.top ? "top" : "bottom");
    popEl.style.left = Math.round(left) + "px";
    popEl.style.top = Math.round(top) + "px";
  }

  function openPop(kind, chip) {
    try {
      ensurePop(chip);
      popKind = kind;
      popKey = "";
      buildPop(kind);
      popKey = popKeyOf(kind, lastView);
      placePop();
      popEl.setAttribute("data-show", "1");
      chip.setAttribute("data-active", "1");
      chip.setAttribute("aria-expanded", "true");
      armPopTimer();
    } catch (err) { /* 静默 */ }
  }

  function togglePop(kind, chip) {
    const open = popEl && popEl.getAttribute("data-show") === "1" && popChip === chip && popKind === kind;
    if (open) closePop();
    else openPop(kind, chip);
  }

  // 数据刷新时同步面板内容（内容签名不变则零 DOM 写入）
  function refreshPop() {
    if (!popEl || popKind == null || popEl.getAttribute("data-show") !== "1" || !lastView) return;
    const key = popKeyOf(popKind, lastView);
    if (key === popKey) return;
    popKey = key;
    buildPop(popKind);
    placePop();
  }

  // 点击框以外区域 / 按 Esc 收起；滚动与失焦时收起，避免面板与框错位。
  // 面板内无操作 15s 自动收起（移动/点击/聚焦会重新计时）。
  document.addEventListener("pointerdown", (e) => {
    if (!popEl || popEl.getAttribute("data-show") !== "1") return;
    const t = e.target;
    if (popEl.contains(t)) { armPopTimer(); return; }
    if (popChip && popChip.contains(t)) { armPopTimer(); return; }
    closePop();
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (!popEl || popEl.getAttribute("data-show") !== "1") return;
    const t = e.target;
    if (popEl.contains(t) || (popChip && popChip.contains(t))) armPopTimer();
  }, true);
  document.addEventListener("focusin", (e) => {
    if (!popEl || popEl.getAttribute("data-show") !== "1") return;
    if (popEl.contains(e.target)) armPopTimer();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePop();
  }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closePop();
  });
  // 滚动只重定位、不关闭：状态条是 sticky 的，用户滚动查看对话时面板不该突然消失。
  window.addEventListener("scroll", () => {
    if (!popEl || popEl.getAttribute("data-show") !== "1") return;
    if (popScrollTick) return;
    popScrollTick = setTimeout(() => {
      popScrollTick = 0;
      if (popEl && popEl.getAttribute("data-show") === "1") placePop();
    }, 80);
  }, true);
  window.addEventListener("blur", closePop);
  window.addEventListener("resize", () => {
    if (popEl && popEl.getAttribute("data-show") === "1") placePop();
  });

  function scan() {
    renderBar();
  }

  function start() {
    ensureStyle();
    removeLegacyFooters();
    // 彻底移除 document.body 的 MutationObserver，杜绝长会话挂载时的底层 C++ 监听负荷。
    // 流式生成期间 100% 由 MessagePort 消息帧事件驱动实时刷新（0 延迟）；
    // 会话常驻状态栏通过 500ms 轻量巡检维护（挂载状态下瞬时短路，零开销）。
    setInterval(() => {
      if (document.hidden) return;
      scheduleScan();
    }, 500);
    // 低频维护（5s）：清理过期轮次数据与遗留废弃节点
    setInterval(() => {
      if (document.hidden) return;
      prune();
      removeLegacyFooters();
    }, 5000);
    scan();
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  // ---------- 端口获取 ----------
  function hookPort(port) {
    if (!port || port.__zcpMeter) return;
    port.__zcpMeter = true;
    // 关键：只注册监听，**绝不调用 port.start()**
    // start() 会让消息只派发给"启用瞬间"的监听器，从而吃掉应用的 Initialize 握手。
    // 交给应用 start；届时所有已注册监听器（含我们）同时收到消息。
    port.addEventListener("message", (ev) => handleFrame(ev.data));
    window.__zcpMeterPort = port;   // 调试用
    if (diag) {
      diag.portHooked = true;
      diag.portStarted = false;   // 恒为 false —— 本版本刻意不 start
      diag.portHookedAt = new Date().toISOString();
    }
  }
  // 端口转交的消息格式跨版本不同，两种都要认：
  //   旧版（≤3.11.x）：window.postMessage("zcode:service-port", "*", [port])   → data 为字符串
  //   新版（3.12.2+）：window.postMessage({type:"zcode:service-port",...}, "*", [port]) → data 为对象
  // 只比较字符串会让新版端口永远不被接管（表现为 turnStats 恒为 0、胶囊不显示）。
  function takePortIfHandoff(d) {
    if (!d) return false;
    if (d === "zcode:service-port") return true;
    if (typeof d === "object" && d.type) {
      return d.type === "zcode:service-port" || d.type === "zcode:scoped-service-port";
    }
    return false;
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (diag) {
      diag.lastMessage = typeof e.data === "string" ? e.data
        : (e.data && e.data.type) || Object.prototype.toString.call(e.data);
      diag.lastMessagePorts = (e.ports || []).length;
    }
    if (takePortIfHandoff(e.data)) {
      if (e.ports && e.ports[0]) hookPort(e.ports[0]);
    }
  }, true);

  window.__zcpMeterTurns = turns;
  window.__zcpMeterHook = hookPort;   // 调试用：热注入时可对存量端口手动补挂
  // 自检：加载 5s 后若仍未接管端口，把诊断信息打到 console（便于版本升级后排障）
  setTimeout(() => {
    if (diag) {
      diag.portInjectedAt = diag.portInjectedAt || null;
      diag.diagReady = true;
      if (!diag.portHooked) {
        console.warn("[zcode-tps] 未接管到服务端口，统计将不可用。window.__zcpMeterDiag =", diag);
      } else {
        console.info("[zcode-tps] 已接管端口，window.__zcpMeterDiag =", diag);
      }
    }
  }, 5000);
})();
