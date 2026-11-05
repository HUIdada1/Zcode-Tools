/**
 * ZCode Pilot 渲染层控制面：自动继续开关 + 崩溃恢复
 * ==================================================================
 * 架构（docs/CONTRACT.md §2.3，**已定稿，不要改**）：
 *   - 正常「自动继续」的决策与续跑 = 官方 Stop hook（autocontinue_hook.py + loopguard.py），
 *     **渲染层完全不参与**；渲染层没有、也不试图寻找任何「发送文本/入队/中断」的内部 API。
 *   - 渲染层只做四件事：
 *       ① 开关 UI（composer 工具条 `[data-testid="chat-mode-select-trigger"]` 右侧）
 *          —— **按当前会话**写 `sessions[sid].mode`，只影响这个对话框；
 *       ② 状态文件同步（`~/.zcode/pilot/state.json`，经 preload 桥 `window.zcode.pilotState`）
 *       ③ 设置页侧边 tab（`[data-testid="settings-page"]` → 「扩展 → ZCode Pilot」），
 *          表单写 `settings`，默认策略对齐 dsh-client-auto-continue；
 *       ④ **崩溃恢复**时的续跑发送（唯一需要「发送」的地方，契约 §2.3.4）
 *
 * 状态文件分工（契约 §2.2，严格读-改-写，绝不整体覆盖别人的字段）：
 *   enabled / paused / cancelToken → sync.py 写；sessions[sid].mode / settings / journal → 本脚本写；
 *   lastContinueAt / sessions[sid].consecutive → hook 写。
 *
 * ★ 硬约束（违反会导致客户端卡启动或既有三个脚本 UI 被破坏）：
 *   1. 观察事件流时**只** `port.addEventListener("message", ...)`，**绝不调用 `port.start()`**
 *      —— start() 会让消息只派发给「启用瞬间已注册的监听器」，吃掉应用的 Initialize 握手。
 *      （与 zcode-tps.js 完全同法；本脚本对同一 MessagePort 再挂一个监听器，互不干扰。）
 *   2. 绝不与 zcode-tps.js / zcode-enhance-prompt.js / zcode-model-puller.js 抢挂载点或覆盖其 DOM：
 *      本脚本所有自有节点一律 `data-zpilot*` 前缀；往容器里插节点时若首位已被 `[data-ztps-bar]`
 *      占据，则插在它之后，绝不顶掉 TPS 的状态栏。
 *   3. 桥缺失 / 挂载点找不到 → **安静降级**：不显示开关、不刷 console 错误、不抛异常。
 *      所有诊断只写进 `window.__zpilotDiag`。
 *
 * ★ 崩溃恢复（契约 §2.3.4，唯一发送路径）：
 *   - 每轮进行中把在途轮次写进状态文件 `journal[sessionId]`，轮次正常收尾即删除；
 *   - 启动时若 journal 里有未收尾轮次、且当前会话空闲、且自动继续处于开启态，则：
 *       ① 用**已在本仓库验证过的五级写回**把续跑文本写进 composer
 *          （优先**直接复用** `window.__zenhanceDiag.writeText`；增强脚本未注入时使用本文件内
 *            逐字照抄自 zcode-enhance-prompt.js 的同款实现，绝不自创写回方式）
 *       ② 点击 `[data-testid="v4-composer-send"]`（缺失时回退 dock 内提交按钮 / 表单提交）
 *       ③ 校验：1.5s 内出现新的流式活动才算成功；失败重试 1 次；再失败只提示、不循环重试
 *   - 台账带 `attempts`（上限 2）与 24h 过期，重启不会无限重发。
 *
 * 回滚：本脚本由 zcode_patcher.py 的 PILOT_SPEC 注入；出问题时
 *   `python skills/zcode-pilot/scripts/restore_clean.py --latest` 秒级还原，无需重装。
 */
(() => {
  if (window.__zpilot) return;
  window.__zpilot = true;

  const MARK = "data-zpilot";
  const dec = new TextDecoder();   // 事件流帧解码（与 zcode-tps.js 同法）
  const diag = (window.__zpilotDiag = window.__zpilotDiag || {});
  diag.scriptVersion = "1.0";
  diag.loadedAt = new Date().toISOString();

  // ============================ 常量（契约 §2.2 / §2.3.4 / §3 / §4） ============================
  const POLL_MS = 1500;              // 状态文件轮询周期（契约 §2.2）
  const ATTACH_MS = 1000;            // 挂载点巡检周期（React 重渲染后自动重挂）
  const VERIFY_MS = 1500;            // 崩溃恢复的流式活动校验窗口（契约 §2.3.4）
  const MAX_ATTEMPTS = 2;            // 崩溃恢复最大尝试次数（首次 + 重试 1 次）
  const HEARTBEAT_MS = 3000;         // journal 心跳节流（限制 IPC 写盘频率）
  const JOURNAL_STALE_MS = 24 * 60 * 60 * 1000;
  const MAX_CONSECUTIVE = 3;         // dsh 默认值；实际显示用 settings.maxConsecutive
  const LS_JOURNAL = "zpilot-journal";     // 桥不持久化 journal 时的本地镜像（降级）

  // 契约 §4 文案表（**逐字复制，禁止改写标点**）。
  // 正常续跑由 hook 使用这 9 条；渲染层只在崩溃恢复时用到，默认 #6「继续」。
  const TEXTS = {
    1: "继续",
    2: "继续",
    3: "继续",
    4: "继续",
    5: "你上一轮只输出内部推理，无回复也无工具调用，用户什么都没看到。每一轮须以工具调用或可见回复结束。",
    6: "继续",
    7: "上一步工具「{tool}」可能未完成，先确认状态再继续，勿重复执行",
    8: "上一步工具「{tool}」已完成，结果:{result}。勿重复执行，直接继续",
    9: "检测到循环，停止重复刚才动作，换方式继续",
  };

  // 设置默认值必须与 autocontinue_hook.py 的 DEFAULT_SETTINGS / 主进程 handler 的
  // default.settings 保持一致（dsh-client-auto-continue 的默认策略）。
  const DEFAULT_SETTINGS = {
    defaultMode: "recover",          // 默认仅故障恢复，不接力正常完成的回合
    resumeSilentTurns: true,
    guardTools: true,
    loopGuard: true,
    graceMs: 3000,
    cooldownMs: 20000,
    maxConsecutive: 3,
    continueText: "继续",
    continueTextMaxTokens: "继续",
    continueTextSilent: "你上一轮只输出内部推理，无回复也无工具调用，用户什么都没看到。每一轮须以工具调用或可见回复结束。",
    continueTextLoop: "继续",
    continueTextInterrupted: "继续",
    guardPendingText: "上一步工具「{tool}」可能未完成，先确认状态再继续，勿重复执行",
    guardDoneText: "上一步工具「{tool}」已完成，结果:{result}。勿重复执行，直接继续",
    loopText: "检测到循环，停止重复刚才动作，换方式继续",
  };
  const RECOVER_TEXT = TEXTS[6];

  // ============================ 静默工具 ============================
  const safe = (fn, fallback) => {
    try { return fn(); } catch (err) { return fallback; }
  };
  const readLS = (k) => safe(() => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, null);
  const writeLS = (k, v) => safe(() => { localStorage.setItem(k, JSON.stringify(v)); return true; }, false);

  // ============================ 侧边栏 / 主会话边界判定 ============================
  // 与 zcode-tps.js / zcode-enhance-prompt.js 同一套判定（照抄，勿改）：
  // 任何 UI 都只能落在主工作区会话里，绝不在侧边栏（辅助对话）来回跳动。
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

  // ============================ 状态（唯一权威 = 状态文件） ============================
  let st = { version: 1, enabled: true, runtime: true, paused: false, cancelToken: 0 };
  let sessions = {};        // 契约 §2.2：hook 写，本脚本只读；sessions[sid].mode 由本脚本写
  let journal = {};         // 契约 §2.2：本脚本写（崩溃恢复台账）
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let stateReady = false;
  let lastCancelToken = null;
  let bridgeMissing = false;
  let bridgeChecked = false;    // 首次桥探测是否已完成（未完成前不建 UI，避免「闪现后消失」）
  let journalViaState = true;   // 桥是否真的持久化 journal（写回后读回校验）
  let lastHeartbeatAt = 0;

  function normalizeSettings(raw) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    if (raw.defaultMode === "recover" || raw.defaultMode === "loop") out.defaultMode = raw.defaultMode;
    for (const k of ["resumeSilentTurns", "guardTools", "loopGuard"]) {
      if (typeof raw[k] === "boolean") out[k] = raw[k];
    }
    for (const k of ["graceMs", "cooldownMs"]) {
      if (typeof raw[k] === "number" && isFinite(raw[k]) && raw[k] >= 0) out[k] = Math.floor(raw[k]);
    }
    if (typeof raw.maxConsecutive === "number" && isFinite(raw.maxConsecutive) && raw.maxConsecutive >= 1) {
      out.maxConsecutive = Math.floor(raw.maxConsecutive);
    }
    for (const k of ["continueText", "continueTextMaxTokens", "continueTextSilent",
      "continueTextLoop", "continueTextInterrupted", "guardPendingText",
      "guardDoneText", "loopText"]) {
      if (typeof raw[k] === "string" && raw[k].trim()) out[k] = raw[k].trim();
    }
    return out;
  }

  // 会话模式：default（跟随 settings.defaultMode）/ off / recover / loop。
  // 旧的全局 runtime=false 作为兼容：没有按会话记录时视为 off。
  function rawModeOf(sid) {
    if (sid && sessions[sid] && typeof sessions[sid].mode === "string") {
      const m = sessions[sid].mode;
      if (m === "default" || m === "off" || m === "recover" || m === "loop") return m;
    }
    return st.runtime === false ? "off" : "default";
  }
  function effectiveMode(sid) {
    if (st.enabled !== true || st.paused === true) return "off";
    const raw = rawModeOf(sid);
    return raw === "default" ? (settings.defaultMode === "loop" ? "loop" : "recover") : raw;
  }
  const isArmedFor = (sid) => effectiveMode(sid) !== "off";
  const isArmed = () => isArmedFor(sessionId());

  const stateLabel = () => {
    if (st.enabled !== true) return "关";
    if (st.paused === true) return "暂停";
    const m = effectiveMode(sessionId());
    return m === "off" ? "关" : m === "loop" ? "循环" : "开";
  };
  const stateKind = () => {
    if (st.enabled !== true) return "off";
    if (st.paused === true) return "paused";
    const m = effectiveMode(sessionId());
    return m === "off" ? "off" : m === "loop" ? "loop" : "on";
  };

  function sessionId() {
    // ★ 以 DOM 当前会话为准：切换到已有对话时不一定有新事件，事件流的
    //   currentSessionId 可能仍是上一个会话；按会话开关必须跟着用户眼前的对话走。
    const fromDom = safe(() => {
      // 分屏时可能有多个 conversation-frame：优先取当前可见 composer 所属的那个。
      let f = null;
      const trigger = findChatModeTrigger().el;
      if (trigger && typeof trigger.closest === "function") {
        f = trigger.closest("[data-workspace-conversation-frame]");
      }
      if (!f) f = document.querySelector("[data-workspace-conversation-frame]");
      if (!f) return null;
      let sid = f.getAttribute("data-session-id");
      if (!sid) {
        const inner = f.querySelector("[data-session-id]");
        if (inner) sid = inner.getAttribute("data-session-id");
      }
      return sid || null;
    }, null);
    return fromDom || currentSessionId || null;
  }

  function consecutiveOf(sid) {
    if (!sid || !sessions || typeof sessions !== "object") return null;
    const rec = sessions[sid];
    if (!rec || typeof rec !== "object") return null;
    const n = rec.consecutive;
    return typeof n === "number" && isFinite(n) ? n : null;
  }

  // ============================ 桥（preload 注入的 window.zcode.pilotState） ============================
  function bridge() {
    const z = window.zcode;
    return z && typeof z.pilotState === "function" ? z : null;
  }

  // 返回值兼容两种形状：`{...fields, success, state}`（py-core 现状）与「直接返回 state 对象」。
  function normalizeState(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.success === false) return null;
    const inner = raw.state && typeof raw.state === "object" && !Array.isArray(raw.state) ? raw.state : raw;
    return inner && typeof inner === "object" ? inner : null;
  }

  function applyState(raw) {
    const s = normalizeState(raw);
    if (!s) return false;
    const prevToken = lastCancelToken;
    for (const k of ["enabled", "runtime", "paused"]) {
      if (typeof s[k] === "boolean") st[k] = s[k];
    }
    if (typeof s.cancelToken === "number" && isFinite(s.cancelToken)) st.cancelToken = s.cancelToken;
    if (s.sessions && typeof s.sessions === "object" && !Array.isArray(s.sessions)) sessions = s.sessions;
    if (s.settings !== undefined) settings = normalizeSettings(s.settings);
    // journal：状态文件优先；桥不返回时保留本地镜像（不覆盖，避免把台账清空）
    if (s.journal && typeof s.journal === "object" && !Array.isArray(s.journal)) journal = s.journal;
    if (s.version !== undefined) st.version = 1;

    // 契约 §2.2：cancelToken 变化 → 清空本地待发队列与所有待发定时器
    if (prevToken != null && st.cancelToken !== prevToken) {
      clearQueue();
      clearTaskTimers();
      diag.cancelTokenBumped = { from: prevToken, to: st.cancelToken, at: Date.now() };
    }
    lastCancelToken = st.cancelToken;
    return true;
  }

  // 只读拉取（patch 省略 = 只读；绝不在只读路径落盘）
  async function fetchState() {
    const api = bridge();
    bridgeChecked = true;
    if (!api) { bridgeMissing = true; return false; }
    bridgeMissing = false;
    try {
      const raw = await api.pilotState();
      const ok = applyState(raw);
      if (ok) stateReady = true;
      diag.stateRead = ok;
      diag.state = { enabled: st.enabled, runtime: st.runtime, paused: st.paused, cancelToken: st.cancelToken };
      return ok;
    } catch (err) {
      diag.stateError = String((err && err.message) || err);
      return false;
    }
  }

  // 合并写入（读-改-写由主进程 handler 负责；本脚本只提交自己那一份补丁）
  async function patchState(patch) {
    const api = bridge();
    if (!api) return null;
    try {
      const raw = await api.pilotState(patch);
      applyState(raw);
      return normalizeState(raw);
    } catch (err) {
      diag.patchError = String((err && err.message) || err);
      return null;
    }
  }

  // ============================ 本地队列与定时器（cancelToken / 暂停 时清空） ============================
  const queue = [];                 // 待发动作（崩溃恢复用；正常续跑不经过渲染层）
  const taskTimers = new Set();     // 会被 cancelToken 变化清空的定时器
  let draining = false;
  let pollTimer = 0;
  let attachTimer = 0;

  // 入队并同步排空：真正的「本地待发队列」——契约 §2.2 要求 cancelToken 变化时清空它，
  // 因此恢复动作必须先入队再执行，才能在作废时被整体丢弃。
  function enqueueRecover(sid, entry) {
    queue.length = 0;
    queue.push({ type: "recover", sid, entry });
    drainQueue();
  }

  function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        if (job && job.type === "recover") attemptRecover(job.sid, job.entry);
      }
    } finally { draining = false; }
  }

  function setTaskTimer(fn, ms) {
    const id = setTimeout(() => {
      taskTimers.delete(id);
      safe(fn);
    }, ms);
    taskTimers.add(id);
    return id;
  }
  function clearTaskTimers() {
    for (const id of taskTimers) { try { clearTimeout(id); } catch (err) { /* 静默 */ } }
    taskTimers.clear();
  }
  function clearQueue() {
    if (queue.length) {
      diag.queueDropped = (diag.queueDropped || 0) + queue.length;
      queue.length = 0;
    }
  }

  // ============================ 事件流观测（只读；绝不 port.start()） ============================
  let lastActivityAt = 0;
  let streaming = false;
  let currentSessionId = null;
  let currentTurnId = null;

  function touchActivity() { lastActivityAt = Date.now(); }

  function isStreaming() {
    if (streaming) return true;
    // DOM 兜底：3.16.3 已确认 `v4-stop` 存在，它只在生成中出现
    return safe(() => !!document.querySelector("[data-testid='v4-stop']"), false);
  }

  function markTurnStart(sid, turnId) {
    if (!sid) return;
    const now = Date.now();
    const cur = journal[sid];
    // 已有台账且（拿不到 turnId 或 turnId 相同）→ 视为同一轮，只刷新活动时间，
    // 绝不因为 stream.chunk 每帧到达而反复新建条目 / 反复写盘。
    if (cur && (!turnId || cur.turnId === turnId)) { cur.lastActivityAt = now; return; }
    journal[sid] = {
      turnId: turnId || ("t" + now),
      startedAt: now,
      lastActivityAt: now,
      text: settings.continueTextInterrupted || RECOVER_TEXT,   // 契约 §4：崩溃恢复默认「继续」
    };
    diag.journalStart = { sessionId: sid, turnId: journal[sid].turnId };
    persistJournal();
  }

  function markTurnEnd(sid) {
    const id = sid || currentSessionId;
    if (!id || !journal[id]) return;
    delete journal[id];
    diag.journalEnd = { sessionId: id, at: Date.now() };
    persistJournal();
  }

  function persistJournal() {
    diag.journalKeys = Object.keys(journal).length;
    // 同步镜像：卸载路径（pagehide）与桥不支持 journal 时都能保住台账
    writeLS(LS_JOURNAL, journal);
    diag.journalViaState = journalViaState;
    if (bridgeMissing) return;
    (async () => {
      try {
        const back = await patchState({ journal: journal });
        // 写回后读回校验：桥若忽略 journal 键，则判定为不支持 → 降级
        const supported = !!(back && back.journal && typeof back.journal === "object");
        journalViaState = supported;
        diag.journalViaState = supported;
      } catch (err) {
        journalViaState = false;
        diag.journalViaState = false;
      }
    })();
  }

  function loadJournalMirror() {
    // 只在桥没给出 journal 时才采用镜像（状态文件始终是唯一权威）
    if (journal && Object.keys(journal).length) return;
    const mirror = readLS(LS_JOURNAL);
    if (mirror && typeof mirror === "object" && !Array.isArray(mirror)) {
      journal = mirror;
      diag.journalFromMirror = true;
    }
  }

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

  function onRow(row) {
    if (!row || typeof row !== "object") return;
    if (row.op === "row.delta") return;          // 文本增量：对轮次生命周期无信息
    const sid = row.sessionId || row.session_id || null;
    if (sid) currentSessionId = sid;
    const turnId = row.turnId || null;
    if (turnId) currentTurnId = turnId;
    if (row.kind === "turnHeader") {
      const ended = row.endedAt != null ||
        (row.state != null && /^(completedSuccess|completed|failed|stopped|cancelled)/.test(String(row.state)));
      if (ended) {
        streaming = false;
        markTurnEnd(sid);
      } else {
        streaming = true;
        touchActivity();
        markTurnStart(sid, turnId);
      }
    } else if (row.kind === "userInput") {
      streaming = true;
      touchActivity();
      markTurnStart(sid, turnId);
    } else if (row.kind === "reasoning" || row.kind === "assistantText") {
      touchActivity();
    }
  }

  function onEvent(ev) {
    if (!ev || ev.version !== 1) return;
    const sid = ev.sessionId || null;
    if (sid) currentSessionId = sid;
    if (ev.kind === "usage.delta" || ev.kind === "stream.chunk") {
      streaming = true;
      touchActivity();
      if (ev.assistantMessageId) currentTurnId = ev.assistantMessageId;
      if (ev.kind === "stream.chunk") markTurnStart(sid, currentTurnId);
    }
  }

  function hookPort(port) {
    if (!port || port.__zpilot) return;
    port.__zpilot = true;
    // ★ 关键：只注册监听，**绝不调用 port.start()**（见文件头硬约束 1）
    port.addEventListener("message", (ev) => handleFrame(ev.data));
    diag.portHooked = true;
    diag.portStarted = false;   // 恒为 false —— 本脚本刻意不 start
  }

  // 端口转交的消息格式跨版本不同，两种都要认（与 zcode-tps.js 同法）
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
    if (takePortIfHandoff(e.data) && e.ports && e.ports[0]) hookPort(e.ports[0]);
  }, true);

  // ============================ 样式（全部 data-zpilot 作用域；应用变量优先 + 自身兜底） ============================
  const STYLE_ID = "zpilot-style";
  const STYLE_V = "zcode-pilot-ui-2";
  function ensureStyle() {
    const prev = document.getElementById(STYLE_ID);
    if (prev && prev.getAttribute("data-zpilot-style") === STYLE_V) return;
    safe(() => {
      if (prev) prev.remove();
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.setAttribute("data-zpilot-style", STYLE_V);
      el.textContent = `
[data-zpilot-toggle],[data-zpilot-toast]{
  --zp-fg:#1b1f24;--zp-dim:#5b6470;--zp-line:rgba(127,127,127,.34);
  --zp-surface:rgba(127,127,127,.075);--zp-hairline:rgba(127,127,127,.22);
  --zp-on:#16a34a;--zp-on-soft:rgba(22,163,74,.12);--zp-paused:#b45309;--zp-paused-soft:rgba(180,83,9,.12);
  --zp-loop:#2563eb;--zp-loop-soft:rgba(37,99,235,.12);
  --zp-off:#8b93a1;--zp-bg:#ffffff;
}
.dark [data-zpilot-toggle],html.dark [data-zpilot-toggle],body.dark [data-zpilot-toggle],
.dark [data-zpilot-toast],html.dark [data-zpilot-toast],body.dark [data-zpilot-toast]{
  --zp-fg:#e8e8e8;--zp-dim:#9a9a9a;--zp-line:rgba(127,127,127,.42);
  --zp-surface:rgba(127,127,127,.10);--zp-hairline:rgba(127,127,127,.28);
  --zp-on:#4ade80;--zp-on-soft:rgba(74,222,128,.14);--zp-paused:#e0983a;--zp-paused-soft:rgba(224,152,58,.14);
    --zp-loop:#60a5fa;--zp-loop-soft:rgba(96,165,250,.14);
  --zp-off:#6b7280;--zp-bg:#1e1e1e;
}
@media (prefers-color-scheme: dark){
  :root:not(.light):not([data-theme='light']) [data-zpilot-toggle],
  :root:not(.light):not([data-theme='light']) [data-zpilot-toast]{
    --zp-fg:#e8e8e8;--zp-dim:#9a9a9a;--zp-line:rgba(127,127,127,.42);
    --zp-surface:rgba(127,127,127,.10);--zp-hairline:rgba(127,127,127,.28);
    --zp-on:#4ade80;--zp-on-soft:rgba(74,222,128,.14);--zp-paused:#e0983a;--zp-paused-soft:rgba(224,152,58,.14);
    --zp-loop:#60a5fa;--zp-loop-soft:rgba(96,165,250,.14);
    --zp-off:#6b7280;--zp-bg:#1e1e1e;
  }
}
/* ============ 开关：紧凑 toggle（22px 高，与 TPS 胶囊同一视觉高度） ============ */
[data-zpilot-toggle]{
  display:inline-flex;align-items:center;flex:0 0 auto;gap:6px;height:22px;padding:0 8px 0 6px;
  border-radius:999px;background:var(--zp-surface);
  box-shadow:inset 0 0 0 1px var(--zp-hairline);
  color:var(--color-foreground-subtle,var(--zp-dim,#5b6470));
  font-size:11px;line-height:1;white-space:nowrap;user-select:none;cursor:pointer;
  transition:background-color .16s ease,box-shadow .16s ease,color .16s ease;
}
[data-zpilot-toggle]:hover{background:rgba(127,127,127,.14);color:var(--color-foreground,var(--zp-fg,#1b1f24))}
[data-zpilot-toggle][data-state='on']{background:var(--zp-on-soft);box-shadow:inset 0 0 0 1px rgba(22,163,74,.30);color:var(--color-foreground,var(--zp-fg,#1b1f24))}
[data-zpilot-toggle][data-state='paused']{background:var(--zp-paused-soft);box-shadow:inset 0 0 0 1px rgba(180,83,9,.32);color:var(--color-foreground,var(--zp-fg,#1b1f24))}
[data-zpilot-toggle][data-state='loop']{background:var(--zp-loop-soft);box-shadow:inset 0 0 0 1px rgba(37,99,235,.30);color:var(--color-foreground,var(--zp-fg,#1b1f24))}
[data-zpilot-toggle][data-state='off']{opacity:.86}
[data-zpilot-toggle] .zp-track{
  position:relative;flex:0 0 auto;width:22px;height:12px;border-radius:999px;
  background:var(--zp-line);transition:background-color .16s ease;
}
[data-zpilot-toggle] .zp-knob{
  position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;
  background:var(--zp-bg);box-shadow:0 1px 2px rgba(0,0,0,.30);
  transition:transform .16s ease;
}
[data-zpilot-toggle][data-runtime='1'] .zp-track{background:var(--zp-on)}
[data-zpilot-toggle][data-state='loop'][data-runtime='1'] .zp-track{background:var(--zp-loop)}
[data-zpilot-toggle][data-runtime='1'] .zp-knob{transform:translateX(10px)}
[data-zpilot-toggle] .zp-t{color:inherit}
[data-zpilot-toggle] .zp-v{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
[data-zpilot-toggle][data-state='on'] .zp-v{color:var(--zp-on)}
[data-zpilot-toggle][data-state='paused'] .zp-v{color:var(--zp-paused)}
[data-zpilot-toggle][data-state='loop'] .zp-v{color:var(--zp-loop)}
[data-zpilot-toggle][data-state='off'] .zp-v{color:var(--zp-off)}
[data-zpilot-toggle][data-busy='1']{opacity:.6;pointer-events:none}
/* ============ 提示条（只读；不拦截点击） ============ */
[data-zpilot-toast]{
  position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483000;
  max-width:72vw;padding:8px 14px;border-radius:10px;
  background:var(--color-background,var(--zp-bg,#ffffff));
  color:var(--color-foreground,var(--zp-fg,#1b1f24));
  border:1px solid var(--zp-hairline);box-shadow:0 8px 24px rgba(0,0,0,.18);
  font-size:12px;line-height:1.45;white-space:pre-wrap;pointer-events:none;
}
@media (prefers-reduced-motion: reduce){
  [data-zpilot-toggle],[data-zpilot-toggle] .zp-track,[data-zpilot-toggle] .zp-knob{transition:none!important}
}
`;
      document.head.appendChild(el);
    });
  }

  // ============================ 提示条 ============================
  let toastEl = null;
  let toastTimer = 0;
  function toast(msg, ms) {
    safe(() => {
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement("div");
        toastEl.setAttribute(MARK + "-toast", "1");
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = String(msg);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (toastEl) { toastEl.remove(); toastEl = null; }
        toastTimer = 0;
      }, ms || 3200);
    });
  }

  // ============================ 开关 UI ============================
  // 落点（契约 §5）：**必须紧跟在「模式切换」按钮右侧**（同一个父容器内的下一个兄弟）。
  // 关键点：挂载时 React 往往还没渲染出 trigger（首次进入会话/切换会话都会这样），
  // 所以「找不到 trigger」只能是**临时**落到工具栏行尾，之后每一轮轮询都要重新尝试搬回
  // trigger 右侧——旧实现把「已经在行尾」当成了终态，漂移纠正条件又要求两者同父且严格相邻，
  // 结果一次降级就永久停在工具栏末尾（实测 diag.toggleWhere 一直是 toolbar-end）。
  let toggleEl = null;

  function findChatModeTrigger() {
    const tried = [];
    let els = [];
    try { els = Array.from(document.querySelectorAll("[data-testid='chat-mode-select-trigger']")); } catch (err) { /* 静默 */ }
    tried.push({ selector: "chat-mode-select-trigger", count: els.length });
    els = els.filter((e) => !isInsideSidePane(e));
    if (!els.length) return { el: null, tried };
    const mainEls = els.filter(isInsideMainConversation);
    const pool = mainEls.length ? mainEls : els;
    // 排序：靠下优先；纵向接近时取靠左（主工作区），与既有脚本同一准则
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const dTop = rb.top - ra.top;
      if (Math.abs(dTop) > 20) return dTop;
      return ra.left - rb.left;
    });
    return { el: pool[0], tried };
  }

  // 工具栏行：从发送/停止按钮向上找 class 含 flex + items-end 的 div（与 zcode-tps.js 同法）
  function findToolbarRow() {
    const btn = safe(() => document.querySelector("[data-testid='v4-composer-send'], [data-testid='v4-stop']"), null);
    if (!btn || isInsideSidePane(btn)) return null;
    let cur = btn;
    while (cur && cur !== document.body) {
      if (cur.tagName === "DIV") {
        const c = typeof cur.className === "string" ? cur.className : "";
        if (/(^|\s)flex(\s|$)/.test(c) && /items-end/.test(c)) return cur;
      }
      cur = cur.parentElement;
    }
    return btn.parentElement || null;
  }

  function buildToggle() {
    const el = document.createElement("div");
    el.setAttribute(MARK + "-toggle", "1");
    el.setAttribute("role", "switch");
    el.setAttribute("tabindex", "0");
    el.setAttribute("data-state", "off");
    el.setAttribute("data-runtime", "0");
    const track = document.createElement("span");
    track.className = "zp-track";
    const knob = document.createElement("span");
    knob.className = "zp-knob";
    track.appendChild(knob);
    const t = document.createElement("span");
    t.className = "zp-t";
    t.textContent = "自动继续";
    const v = document.createElement("span");
    v.className = "zp-v";
    el.appendChild(track);
    el.appendChild(t);
    el.appendChild(v);
    el._zpv = v;

    // 阻止事件冒泡到官方工具栏（避免误触发 Radix 菜单/发送等）
    for (const evt of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
      el.addEventListener(evt, (e) => { e.stopPropagation(); }, true);
    }
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggleClick();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        e.stopPropagation();
        onToggleClick();
      }
    });
    return el;
  }

  async function onToggleClick() {
    if (!stateReady || bridgeMissing) return;
    const sid = sessionId();
    if (!sid || sid === "draft") {
      toast("自动继续：当前对话还没有建立会话，发送一条消息后再切换");
      return;
    }
    if (st.enabled !== true) { toast("自动继续：已在插件配置中关闭，请先到插件配置里开启"); return; }
    if (st.paused === true) { toast("自动继续：当前全局暂停中，请先到插件配置里恢复"); return; }

    const before = rawModeOf(sid);
    const next = effectiveMode(sid) === "off" ? "default" : "off";
    // 乐观更新：只改当前会话的 mode，其他会话不受影响。
    sessions[sid] = Object.assign({}, sessions[sid] || {}, { mode: next });
    if (toggleEl) toggleEl.setAttribute("data-busy", "1");
    renderAll();
    const back = await patchState({ sessionMode: { id: sid, mode: next } });
    if (!back) {                        // 写入失败 → 回滚 UI 并提示（契约要求）
      sessions[sid] = Object.assign({}, sessions[sid] || {}, { mode: before });
      diag.toggleError = "写入失败已回滚";
      toast("自动继续：当前会话开关写入失败，已回滚");
    } else {
      diag.toggleWrite = { sessionId: sid, mode: next, at: Date.now() };
      toast(next === "off"
        ? "自动继续：已关闭当前会话（其他对话不受影响）"
        : "自动继续：已开启当前会话（跟随默认策略）");
    }
    if (toggleEl) toggleEl.removeAttribute("data-busy");
    renderAll();
  }

  function toggleTitle() {
    const sid = sessionId();
    const mode = effectiveMode(sid);
    const n = consecutiveOf(sid);
    const cnt = n != null ? `\n本会话连续触发：${n}/${settings.maxConsecutive}` : "";
    const base = st.enabled !== true
      ? "自动继续：已在插件配置中关闭"
      : st.paused === true
        ? "自动继续：全局暂停中，暂停需在插件配置里恢复"
        : mode === "off"
          ? "自动继续：当前会话已关闭（点击开启）"
          : mode === "loop"
            ? "自动继续：当前会话为自主循环（点击关闭）"
            : "自动继续：当前会话已开启（点击关闭）";
    return base + cnt + "\n只影响当前会话；其他对话各自独立。\n续跑由官方 Stop hook 执行。";
  }

  function renderToggle() {
    if (!toggleEl) return;
    const kind = stateKind();
    if (toggleEl.getAttribute("data-state") !== kind) toggleEl.setAttribute("data-state", kind);
    // 轨道只反映「当前会话自身的开关」；暂停/总开关关闭由 data-state 表达。
    const on = rawModeOf(sessionId()) !== "off" ? "1" : "0";
    if (toggleEl.getAttribute("data-runtime") !== on) toggleEl.setAttribute("data-runtime", on);
    const txt = stateLabel();
    if (toggleEl._zpv && toggleEl._zpv.textContent !== txt) toggleEl._zpv.textContent = txt;
    const title = toggleTitle();
    if (toggleEl.title !== title) toggleEl.title = title;
    safe(() => toggleEl.setAttribute("aria-checked", on === "1" ? "true" : "false"));
    safe(() => toggleEl.setAttribute("aria-label", "自动继续：" + txt));
  }

  function isRightOfTrigger(trigger) {
    // 「右侧」＝**紧邻**在模式切换之后。曾经用宽松判定（同父、下标更大即算合规），
    // 结果把「漂到行尾」也当成合规 —— 实测开关就因此永久停在工具栏最右端（CDP 2026-10-29）。
    return !!toggleEl && !!trigger && toggleEl.previousElementSibling === trigger;
  }

  function attachToggle() {
    if (!toggleEl) return false;
    const { el: trigger } = findChatModeTrigger();
    if (trigger && !isInsideSidePane(trigger) && trigger.parentElement) {
      diag.triggerFound = true;
      if (!isRightOfTrigger(trigger)) {
        safe(() => trigger.parentElement.insertBefore(toggleEl, trigger.nextSibling));
      }
      if (!toggleEl.isConnected) { diag.toggleHiddenReason = "插入失败"; return false; }
      diag.toggleWhere = "after-trigger";
      delete diag.toggleHiddenReason;
      return true;
    }
    // trigger 尚未渲染 → 只是临时落点，下一轮轮询还会搬回 trigger 右侧
    diag.triggerFound = false;
    if (!toggleEl.isConnected) {
      const row = findToolbarRow();
      if (!row || isInsideSidePane(row)) { diag.toggleHiddenReason = "未找到挂载点"; return false; }
      safe(() => row.appendChild(toggleEl));
      if (!toggleEl.isConnected) { diag.toggleHiddenReason = "插入失败"; return false; }
      diag.toggleWhere = "toolbar-end(待搬回)";
    }
    delete diag.toggleHiddenReason;
    return true;
  }

  // ============================ 会话区状态显示（已按用户要求移除） ============================
  // 曾经在这里往会话顶部插一条 895px 宽的胶囊状态条（「自动继续 开」），实测被误认成官方控件、
  // 且挡住标题行；状态与开关同源，开关自身已有 on/paused/off 三态显示，无需第二处展示。

  // ============================ 统一渲染（开关状态与状态文件同源，1 帧内一致） ============================
  function renderAll() {
    renderToggle();
    diag.ui = {
      state: stateLabel(), kind: stateKind(), armed: isArmed(),
      mode: effectiveMode(sessionId()), consecutive: consecutiveOf(sessionId()),
      settingsTab: settingsUiActive ? "active" : "inactive",
    };
  }

  function ensureUi() {
    if (!bridgeChecked) return;      // 首次桥探测完成前不建 UI
    if (bridgeMissing) { hideUi(); return; }
    ensureStyle();
    ensureSettingsUi();              // 设置页侧边 tab 与当前路由无关，独立巡检
    if (!toggleEl) toggleEl = buildToggle();
    const tOk = attachToggle();
    diag.toggleAttached = tOk;
    renderAll();
  }

  function hideUi() {
    // 桥缺失 → 安静降级：移除自有节点，不留残影，不报错
    safe(() => { if (toggleEl) { toggleEl.remove(); toggleEl = null; } });
    diag.uiHidden = "bridge-missing";
  }

  // ============================ 设置页侧边 tab（ZCode Pilot） ============================
  // 注入点（ZCode 3.16.x 实测）：
  //   设置页根      [data-testid="settings-page"]
  //   侧边导航      aside nav（原生 section 按钮带 [data-settings-section-nav]）
  //   内容面板      [data-settings-panel-frame]
  // 策略：在原生导航末尾追加一个分组 + 一个 tab；点击后用绝对定位面板覆盖内容区。
  // 不修改 React 的 state / DOM 结构，React 重渲染后由 1s 巡检自动补回。
  const SETTINGS_STYLE_ID = "zpilot-settings-style";
  const SETTINGS_STYLE_V = "zcode-pilot-settings-1";
  const SETTINGS_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6' +
    'M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/><circle cx="12" cy="12" r="3.4"/></svg>';

  const SETTINGS_FIELDS = [
    { key: "defaultMode", label: "默认会话模式", type: "select",
      options: [["recover", "仅故障恢复"], ["loop", "自主循环"]],
      hint: "没有单独设置模式的会话使用此模式。默认仅故障恢复，不接力正常完成的回合。" },
    { key: "resumeSilentTurns", label: "续跑无输出回合", type: "bool",
      hint: "模型有活动但没有可见输出时自动续跑。" },
    { key: "guardTools", label: "工具幂等护栏", type: "bool",
      hint: "续跑前检查上一步工具调用，避免重复执行有副作用的操作。" },
    { key: "loopGuard", label: "循环守卫", type: "bool",
      hint: "检测重复动作循环，打断并用循环提示文本换方式继续。" },
    { key: "graceMs", label: "宽限期 (ms)", type: "number", min: 0, step: 100,
      hint: "检测到中断后等待多久再自动发送；期间宿主自行恢复则取消。" },
    { key: "cooldownMs", label: "冷却时间 (ms)", type: "number", min: 0, step: 1000,
      hint: "同一会话两次故障恢复的最小间隔。" },
    { key: "maxConsecutive", label: "最大连续次数", type: "number", min: 1, step: 1,
      hint: "连续故障恢复达到该次数后停止；自主循环的正常接力不计入。" },
    { key: "continueText", label: "继续文本", type: "text",
      hint: "中断后自动发送的内容。" },
    { key: "continueTextMaxTokens", label: "超限时继续文本", type: "text",
      hint: "达到输出 token 上限时发送的内容。" },
    { key: "continueTextSilent", label: "无输出时继续文本", type: "text",
      hint: "回合没有可见输出时发送的内容。" },
    { key: "continueTextLoop", label: "自主循环继续文本", type: "text",
      hint: "自主循环每次续跑发送的内容。" },
    { key: "continueTextInterrupted", label: "意外中断继续文本", type: "text",
      hint: "崩溃恢复或宿主重启中断后发送的内容。" },
    { key: "loopText", label: "循环提示文本", type: "text",
      hint: "循环守卫打断后发送的内容。" },
    { key: "guardPendingText", label: "护栏：结果未确认", type: "text",
      hint: "上一步工具可能未完成时追加；支持 {tool} 占位符。" },
    { key: "guardDoneText", label: "护栏：工具已完成", type: "text",
      hint: "上一步工具已成功时追加；支持 {tool} / {result} 占位符。" },
  ];
  const SETTINGS_FIELD_BY_KEY = {};
  for (const f of SETTINGS_FIELDS) SETTINGS_FIELD_BY_KEY[f.key] = f;

  let settingsUiActive = false;
  let settingsDraft = null;
  let settingsDirty = false;

  const escHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function settingsPage() {
    return safe(() => document.querySelector('[data-testid="settings-page"]'), null);
  }

  function ensureSettingsStyle() {
    const prev = document.getElementById(SETTINGS_STYLE_ID);
    if (prev && prev.getAttribute("data-zpilot-settings-style") === SETTINGS_STYLE_V) return;
    safe(() => {
      if (prev) prev.remove();
      const el = document.createElement("style");
      el.id = SETTINGS_STYLE_ID;
      el.setAttribute("data-zpilot-settings-style", SETTINGS_STYLE_V);
      el.textContent = `
[data-zpilot-settings-nav][data-active='1']{
  background:var(--color-surface-hover,rgba(127,127,127,.14))!important;
  color:var(--color-foreground,#1b1f24)!important;
}
[data-zpilot-settings-active='1'] [data-settings-section-nav][aria-current='page']{
  background:transparent!important;
  color:var(--color-remote-foreground-muted,#5b6470)!important;
}
[data-zpilot-settings-panel]{
  --zps-bg:var(--color-background,#fff);--zps-fg:var(--color-foreground,#1b1f24);
  --zps-muted:var(--color-foreground-subtle,#5b6470);--zps-border:var(--color-border,rgba(127,127,127,.24));
  --zps-surface:var(--color-surface,rgba(127,127,127,.06));--zps-primary:#2563eb;
  position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;overflow:hidden;
  background:var(--zps-bg);color:var(--zps-fg);font-size:13px;line-height:1.45;
}
.dark [data-zpilot-settings-panel],html.dark [data-zpilot-settings-panel],body.dark [data-zpilot-settings-panel]{
  --zps-bg:var(--color-background,#1e1e1e);--zps-fg:var(--color-foreground,#e8e8e8);
  --zps-muted:var(--color-foreground-subtle,#9a9a9a);--zps-border:var(--color-border,rgba(127,127,127,.30));
  --zps-surface:var(--color-surface,rgba(127,127,127,.10));--zps-primary:#60a5fa;
}
@media (prefers-color-scheme: dark){
  :root:not(.light):not([data-theme='light']) [data-zpilot-settings-panel]{
    --zps-bg:var(--color-background,#1e1e1e);--zps-fg:var(--color-foreground,#e8e8e8);
    --zps-muted:var(--color-foreground-subtle,#9a9a9a);--zps-border:var(--color-border,rgba(127,127,127,.30));
    --zps-surface:var(--color-surface,rgba(127,127,127,.10));--zps-primary:#60a5fa;
  }
}
[data-zpilot-settings-panel] .zps-head{
  display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  padding:18px 84px 14px 28px;border-bottom:1px solid var(--zps-border);flex:0 0 auto;
}
[data-zpilot-settings-panel] .zps-title{font-size:16px;font-weight:600;letter-spacing:.01em}
[data-zpilot-settings-panel] .zps-subtitle{margin-top:3px;color:var(--zps-muted);font-size:12px}
[data-zpilot-settings-panel] .zps-close{
  flex:0 0 auto;width:28px;height:28px;border:0;border-radius:8px;background:transparent;
  color:var(--zps-muted);font-size:20px;line-height:1;cursor:pointer;
}
[data-zpilot-settings-panel] .zps-close:hover{background:var(--zps-surface);color:var(--zps-fg)}
[data-zpilot-settings-panel] .zps-current{
  display:flex;align-items:center;gap:8px;margin:14px 28px 0;padding:10px 12px;
  border:1px solid var(--zps-border);border-radius:10px;background:var(--zps-surface);font-size:12px;
}
[data-zpilot-settings-panel] .zps-current b{font-weight:600}
[data-zpilot-settings-panel] .zps-body{flex:1 1 auto;overflow:auto;padding:8px 28px 22px}
[data-zpilot-settings-panel] .zps-section{padding-top:18px}
[data-zpilot-settings-panel] .zps-section-title{
  font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
  color:var(--zps-muted);padding-bottom:6px;
}
[data-zpilot-settings-panel] .zps-row{
  display:flex;align-items:center;justify-content:space-between;gap:20px;
  padding:10px 0;border-bottom:1px solid var(--zps-border);
}
[data-zpilot-settings-panel] .zps-row:last-child{border-bottom:0}
[data-zpilot-settings-panel] .zps-row-text{min-width:0;flex:1 1 auto}
[data-zpilot-settings-panel] .zps-row-label{font-weight:500}
[data-zpilot-settings-panel] .zps-row-hint{margin-top:2px;color:var(--zps-muted);font-size:11.5px}
[data-zpilot-settings-panel] .zps-row-control{flex:0 0 auto;display:flex;align-items:center}
[data-zpilot-settings-panel] .zps-input{
  width:260px;max-width:42vw;height:30px;padding:0 9px;border-radius:8px;
  border:1px solid var(--zps-border);background:var(--zps-bg);color:var(--zps-fg);
  font:inherit;outline:none;
}
[data-zpilot-settings-panel] .zps-input:focus{border-color:var(--zps-primary);box-shadow:0 0 0 2px rgba(37,99,235,.18)}
[data-zpilot-settings-panel] .zps-select{width:180px}
[data-zpilot-settings-panel] .zps-switch{position:relative;display:inline-block;width:34px;height:18px}
[data-zpilot-settings-panel] .zps-switch input{opacity:0;width:0;height:0;position:absolute}
[data-zpilot-settings-panel] .zps-slider{
  position:absolute;inset:0;border-radius:999px;background:var(--zps-border);cursor:pointer;
  transition:background-color .16s ease;
}
[data-zpilot-settings-panel] .zps-slider:before{
  content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s ease;
}
[data-zpilot-settings-panel] .zps-switch input:checked + .zps-slider{background:var(--zps-primary)}
[data-zpilot-settings-panel] .zps-switch input:checked + .zps-slider:before{transform:translateX(16px)}
[data-zpilot-settings-panel] .zps-foot{
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:12px 28px;border-top:1px solid var(--zps-border);background:var(--zps-bg);flex:0 0 auto;
}
[data-zpilot-settings-panel] .zps-status{color:var(--zps-muted);font-size:12px}
[data-zpilot-settings-panel] .zps-actions{display:flex;gap:8px}
[data-zpilot-settings-panel] .zps-btn{
  height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--zps-border);
  background:var(--zps-bg);color:var(--zps-fg);font:inherit;font-size:12.5px;cursor:pointer;
}
[data-zpilot-settings-panel] .zps-btn:hover{background:var(--zps-surface)}
[data-zpilot-settings-panel] .zps-btn-primary{
  border-color:var(--zps-primary);background:var(--zps-primary);color:#fff;
}
[data-zpilot-settings-panel] .zps-btn-primary:hover{filter:brightness(1.06)}
@media (max-width:640px){
  [data-zpilot-settings-panel] .zps-head{padding-right:28px}
  [data-zpilot-settings-panel] .zps-row{flex-direction:column;align-items:flex-start;gap:6px}
  [data-zpilot-settings-panel] .zps-input{width:100%;max-width:none}
}
`;
      document.head.appendChild(el);
    });
  }

  function buildSettingsNavItem(nav) {
    const navRoot = nav.querySelector(":scope > div") || nav;
    let group = navRoot.querySelector("[data-zpilot-settings-group]");
    if (!group) {
      group = document.createElement("div");
      group.setAttribute("data-zpilot-settings-group", "1");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "扩展");
      group.className = "space-y-1 max-lg:border-t max-lg:border-border max-lg:pt-3";
      const heading = document.createElement("div");
      heading.className = "px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only";
      heading.textContent = "扩展";
      group.appendChild(heading);
      navRoot.appendChild(group);
    }

    const existing = nav.querySelector("[data-zpilot-settings-nav]");
    if (existing && existing.isConnected) {
      if (existing.parentElement !== group) group.appendChild(existing);
      return existing;
    }

    const sample = nav.querySelector("[data-settings-section-nav]");
    const item = sample ? sample.cloneNode(true) : document.createElement("button");
    item.setAttribute("data-zpilot-settings-nav", "1");
    item.setAttribute("data-settings-section-nav", "pilot");
    item.setAttribute("data-testid", "settings-section-nav-pilot");
    item.setAttribute("type", "button");
    item.setAttribute("aria-label", "ZCode 工具箱");
    item.setAttribute("title", "ZCode Pilot · 自动继续");
    item.removeAttribute("aria-current");
    item.removeAttribute("disabled");
    item.removeAttribute("aria-disabled");
    item.disabled = false;
    item.dataset.active = settingsUiActive ? "1" : "0";

    if (!sample) {
      item.className = "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors " +
        "text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground " +
        "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0";
      item.innerHTML =
        '<span class="flex size-4 shrink-0 items-center justify-center text-current">' + SETTINGS_ICON + '</span>' +
        '<span class="min-w-0 flex-1 max-lg:sr-only"><span class="truncate text-ui-base text-foreground">ZCode 工具箱</span></span>';
    } else {
      item.classList.remove("bg-surface-hover", "text-foreground");
      item.classList.add("text-remote-foreground-muted");
      const label = item.querySelector("span.truncate") || item.querySelector("span.text-ui-base");
      if (label) label.textContent = "ZCode 工具箱";
      const icon = item.querySelector("span.flex.size-4");
      if (icon) icon.innerHTML = SETTINGS_ICON;
    }

    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateSettings();
    }, true);

    group.appendChild(item);
    return item;
  }

  function ensureSettingsUi() {
    const page = settingsPage();
    if (!page) {
      if (settingsUiActive) deactivateSettings();
      return;
    }
    ensureSettingsStyle();
    const nav = page.querySelector("aside nav") || page.querySelector("nav[aria-label]");
    if (nav) {
      if (!nav.__zpilotSettingsBound) {
        nav.__zpilotSettingsBound = true;
        nav.addEventListener("click", (e) => {
          const nativeItem = e.target && e.target.closest
            ? e.target.closest("[data-settings-section-nav]")
            : null;
          if (nativeItem && !nativeItem.hasAttribute("data-zpilot-settings-nav") && settingsUiActive) {
            deactivateSettings();
          }
        }, true);
      }
      buildSettingsNavItem(nav);
    }
    if (settingsUiActive) ensureSettingsPanel(page);
  }

  function activateSettings() {
    const page = settingsPage();
    if (!page) return;
    settingsUiActive = true;
    settingsDirty = false;
    settingsDraft = normalizeSettings(settings);
    page.setAttribute("data-zpilot-settings-active", "1");
    const item = page.querySelector("[data-zpilot-settings-nav]");
    if (item) { item.dataset.active = "1"; item.setAttribute("aria-current", "page"); }
    ensureSettingsPanel(page);
    diag.settingsTab = "active";
  }

  function deactivateSettings() {
    settingsUiActive = false;
    settingsDirty = false;
    settingsDraft = null;
    const page = settingsPage();
    if (page) page.removeAttribute("data-zpilot-settings-active");
    const panel = document.querySelector("[data-zpilot-settings-panel]");
    if (panel) panel.remove();
    const item = document.querySelector("[data-zpilot-settings-nav]");
    if (item) { item.dataset.active = "0"; item.removeAttribute("aria-current"); }
    diag.settingsTab = "inactive";
  }

  function ensureSettingsPanel(page) {
    const frame = page.querySelector("[data-settings-panel-frame]");
    if (!frame) return;
    let panel = frame.querySelector("[data-zpilot-settings-panel]");
    if (!panel) {
      panel = document.createElement("div");
      panel.setAttribute("data-zpilot-settings-panel", "1");
      panel.className = "zps-panel";
      frame.appendChild(panel);
    }
    if (!panel.__zpsBound) {
      panel.__zpsBound = true;
      panel.addEventListener("click", onSettingsPanelClick);
      panel.addEventListener("input", onSettingsPanelInput);
      panel.addEventListener("change", onSettingsPanelInput);
    }
    if (!panel.__zpsRendered) renderSettingsPanel(panel);
  }

  function settingsRowHtml(field) {
    const value = settingsDraft ? settingsDraft[field.key] : settings[field.key];
    let control;
    if (field.type === "bool") {
      control = '<label class="zps-switch"><input type="checkbox" data-zps-field="' + field.key + '"' +
        (value ? " checked" : "") + '><span class="zps-slider"></span></label>';
    } else if (field.type === "select") {
      control = '<select class="zps-input zps-select" data-zps-field="' + field.key + '">' +
        field.options.map((opt) => '<option value="' + escHtml(opt[0]) + '"' +
          (String(value) === opt[0] ? " selected" : "") + ">" + escHtml(opt[1]) + "</option>").join("") +
        "</select>";
    } else {
      control = '<input class="zps-input" type="' + field.type + '" data-zps-field="' + field.key +
        '" value="' + escHtml(value) + '"' +
        (field.min != null ? ' min="' + field.min + '"' : "") +
        (field.step != null ? ' step="' + field.step + '"' : "") + ">";
    }
    return '<div class="zps-row"><div class="zps-row-text">' +
      '<div class="zps-row-label">' + escHtml(field.label) + "</div>" +
      (field.hint ? '<div class="zps-row-hint">' + escHtml(field.hint) + "</div>" : "") +
      '</div><div class="zps-row-control">' + control + "</div></div>";
  }

  function renderSettingsPanel(panel) {
    if (!panel) panel = document.querySelector("[data-zpilot-settings-panel]");
    if (!panel) return;
    if (!settingsDraft) settingsDraft = normalizeSettings(settings);
    const sid = sessionId();
    const mode = sid ? effectiveMode(sid) : null;
    const n = sid ? consecutiveOf(sid) : null;
    const modeName = mode === "loop" ? "自主循环" : mode === "recover" ? "仅故障恢复"
      : mode === "off" ? "关闭" : "未识别当前会话";
    const section = (title, keys) => '<div class="zps-section"><div class="zps-section-title">' +
      escHtml(title) + "</div>" + keys.map((k) => settingsRowHtml(SETTINGS_FIELD_BY_KEY[k])).join("") +
      "</div>";
    panel.innerHTML =
      '<div class="zps-head"><div><div class="zps-title">ZCode 工具箱 · 自动继续</div>' +
      '<div class="zps-subtitle">总开关在插件配置页；输入框开关只影响当前会话，这里配置默认策略。</div></div>' +
      '<button type="button" class="zps-close" data-zps-action="close" aria-label="关闭">×</button></div>' +
      '<div class="zps-current"><span>当前会话</span><b>' + escHtml(modeName) + "</b>" +
      (n != null ? '<span class="zps-dot">·</span><span>连续 ' + n + "/" +
        escHtml(settings.maxConsecutive) + "</span>" : "") + "</div>" +
      '<div class="zps-body">' +
      section("会话与恢复", ["defaultMode", "resumeSilentTurns"]) +
      section("安全保护", ["guardTools", "loopGuard"]) +
      section("重试节奏", ["graceMs", "cooldownMs", "maxConsecutive"]) +
      section("继续文本", ["continueText", "continueTextMaxTokens", "continueTextSilent",
        "continueTextLoop", "continueTextInterrupted", "loopText",
        "guardPendingText", "guardDoneText"]) +
      "</div>" +
      '<div class="zps-foot"><span class="zps-status" data-zps-status>' +
      (settingsDirty ? "有未保存的更改" : "已保存") + "</span>" +
      '<div class="zps-actions"><button type="button" class="zps-btn" data-zps-action="reset">恢复默认</button>' +
      '<button type="button" class="zps-btn zps-btn-primary" data-zps-action="save">保存</button></div></div>';
    panel.__zpsRendered = true;
  }

  function setSettingsStatus(text) {
    const el = document.querySelector("[data-zps-status]");
    if (el) el.textContent = text;
  }

  function onSettingsPanelInput(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-zps-field]") : null;
    if (!el || !settingsDraft) return;
    const key = el.getAttribute("data-zps-field");
    if (!(key in DEFAULT_SETTINGS)) return;
    let value;
    if (el.type === "checkbox") value = !!el.checked;
    else if (el.type === "number") value = el.value.trim() === "" ? DEFAULT_SETTINGS[key] : Number(el.value);
    else value = el.value;
    settingsDraft[key] = value;
    settingsDirty = true;
    setSettingsStatus("有未保存的更改");
  }

  async function saveSettings() {
    if (!settingsDraft) return;
    const next = {};
    for (const field of SETTINGS_FIELDS) {
      let value = settingsDraft[field.key];
      if (field.type === "number") {
        const n = Number(value);
        if (!isFinite(n) || n < (field.min || 0)) {
          setSettingsStatus("请输入有效数字（" + field.label + "）");
          return;
        }
        value = Math.floor(n);
      } else if (field.type === "bool") {
        value = !!value;
      } else if (field.type === "text") {
        value = String(value == null ? "" : value).trim();
        if (!value) value = DEFAULT_SETTINGS[field.key];
      }
      next[field.key] = value;
    }
    if (next.maxConsecutive < 1) next.maxConsecutive = 1;
    if (next.defaultMode !== "recover" && next.defaultMode !== "loop") next.defaultMode = "recover";
    setSettingsStatus("保存中…");
    const back = await patchState({ settings: next });
    if (!back) { setSettingsStatus("保存失败，请重试"); return; }
    settings = normalizeSettings((back && back.settings) || next);
    settingsDraft = normalizeSettings(settings);
    settingsDirty = false;
    renderSettingsPanel(document.querySelector("[data-zpilot-settings-panel]"));
    setSettingsStatus("已保存");
    diag.settingsSave = { at: Date.now() };
  }

  function onSettingsPanelClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest("[data-zps-action]") : null;
    if (!btn) return;
    const action = btn.getAttribute("data-zps-action");
    if (action === "close") {
      deactivateSettings();
    } else if (action === "reset") {
      settingsDraft = normalizeSettings(DEFAULT_SETTINGS);
      settingsDirty = true;
      renderSettingsPanel(document.querySelector("[data-zpilot-settings-panel]"));
      setSettingsStatus("已恢复默认值，点击保存生效");
    } else if (action === "save") {
      saveSettings();
    }
  }

  // ============================ 五级写回（崩溃恢复专用） ============================
  // 契约 §2.3.4 要求「复用本仓库已验证的五级方案」。策略：
  //   ① 首选**直接复用**增强脚本暴露的 `window.__zenhanceDiag.writeText`（零重复，真复用）；
  //   ② 增强脚本未注入时，使用下面这份**逐字照抄**自 zcode-enhance-prompt.js 的同款实现
  //      （React Fiber editorApiRef.setText → Lexical parseEditorState/setEditorState →
  //        合成 paste → execCommand('insertText') → 原生 setter + InputEvent 链）。
  const DOCK_SELECTORS = [
    "[data-v4-composer-dock='true']",
    "[data-v4-composer-dock]",
    "[data-testid='v4-composer']",
  ];
  const COMPOSER_INPUT_SELECTORS = [
    "[data-lexical-editor='true']",
    "[data-testid='v4-composer-input']",
    "[data-testid*='composer-input']",
    "textarea[data-testid]",
    "form textarea",
    "textarea",
    "[contenteditable='true']",
  ];

  function findDock() {
    for (const sel of DOCK_SELECTORS) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (err) { continue; }
      if (!els.length) continue;
      els = els.filter((e) => !isInsideSidePane(e));
      if (!els.length) continue;
      const mainEls = els.filter(isInsideMainConversation);
      const pool = mainEls.length ? mainEls : els;
      const vis = pool.filter((e) => e.offsetParent != null);
      const candidates = vis.length ? vis : pool;
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const dTop = rb.top - ra.top;
        if (Math.abs(dTop) > 20) return dTop;
        return ra.left - rb.left;
      });
      return candidates[0];
    }
    return null;
  }

  function findInput() {
    // ① 严格模式：只在 dock 内找输入框（绝不去消息区误抓元素）
    const dock = findDock();
    if (dock) {
      for (const sel of COMPOSER_INPUT_SELECTORS) {
        let els = [];
        try { els = Array.from(dock.querySelectorAll(sel)); } catch (err) { continue; }
        if (!els.length) continue;
        const vis = els.filter((e) => e.offsetParent != null);
        const pool = vis.length ? vis : els;
        pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        return pool[0];
      }
    }
    // ② 兼容模式：dock 不存在才退回全局，仅认带明确 composer 语义的选择器
    for (const sel of COMPOSER_INPUT_SELECTORS) {
      if (sel === "textarea" || sel === "[contenteditable='true']" || sel === "form textarea") continue;
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (err) { continue; }
      els = els.filter((e) => !isInsideSidePane(e));
      if (!els.length) continue;
      const mainEls = els.filter(isInsideMainConversation);
      const pool = mainEls.length ? mainEls : els;
      const vis = pool.filter((e) => e.offsetParent != null);
      const candidates = vis.length ? vis : pool;
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const dTop = rb.top - ra.top;
        if (Math.abs(dTop) > 20) return dTop;
        return ra.left - rb.left;
      });
      return candidates[0];
    }
    return null;
  }

  function resolveEditorTarget(el) {
    if (!el) return null;
    try {
      if (el.hasAttribute && (el.hasAttribute("data-lexical-editor") || el.getAttribute("contenteditable") === "true")) {
        return el;
      }
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el;
      const inner = el.querySelector && el.querySelector("[data-lexical-editor='true'], [contenteditable='true'], textarea, input");
      if (inner) return inner;
    } catch (_) {}
    return el;
  }

  function findEditorApiFromFiber(el) {
    if (!el) return null;
    try {
      let curr = null;
      for (const k of Object.keys(el)) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) { curr = el[k]; break; }
      }
      let depth = 0;
      while (curr && depth < 20) {
        const props = curr.memoizedProps;
        if (props) {
          const api = props.editorApiRef?.current || props.inputApiRef?.current || props.editorApi;
          if (api && typeof api.setText === "function") return api;
        }
        curr = curr.return;
        depth++;
      }
    } catch (_) {}
    return null;
  }

  function findLexicalEditor(el) {
    if (!el) return null;
    try {
      if (el.__lexicalEditor) return el.__lexicalEditor;
      const closest = el.closest && el.closest("[data-lexical-editor='true'], [contenteditable='true']");
      if (closest && closest.__lexicalEditor) return closest.__lexicalEditor;
      const inner = el.querySelector && el.querySelector("[data-lexical-editor='true'], [contenteditable='true']");
      if (inner && inner.__lexicalEditor) return inner.__lexicalEditor;
    } catch (_) {}
    return null;
  }

  function buildLexicalStateJson(text) {
    const lines = String(text || "").split("\n");
    const paragraphs = lines.map((line) => ({
      type: "paragraph",
      format: "",
      indent: 0,
      version: 1,
      direction: "ltr",
      textFormat: 0,
      textStyle: "",
      children: line ? [{
        type: "text",
        text: line,
        format: 0,
        detail: 0,
        mode: "normal",
        style: "",
        version: 1,
      }] : [],
    }));
    return {
      root: {
        type: "root",
        format: "",
        indent: 0,
        version: 1,
        direction: "ltr",
        children: paragraphs.length > 0 ? paragraphs : [{
          type: "paragraph",
          format: "",
          indent: 0,
          version: 1,
          direction: "ltr",
          textFormat: 0,
          textStyle: "",
          children: [],
        }],
      },
    };
  }

  function readText(el) {
    if (!el) return "";
    const target = resolveEditorTarget(el);
    if (!target) return "";
    const api = findEditorApiFromFiber(target);
    if (api) {
      try {
        if (typeof api.getMarkdown === "function") {
          const md = api.getMarkdown();
          if (typeof md === "string" && md.trim()) return md.replace(/\u200B/g, "");
        }
        if (typeof api.getText === "function") {
          const txt = api.getText();
          if (typeof txt === "string" && txt.trim()) return txt.replace(/\u200B/g, "");
        }
      } catch (_) {}
    }
    const isFormInput = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
    if (isFormInput && typeof target.value === "string") return target.value;
    const editor = findLexicalEditor(target);
    if (editor && typeof editor.getEditorState === "function") {
      try {
        const es = editor.getEditorState();
        if (es && typeof es.read === "function") {
          let textResult = null;
          es.read(() => {
            try {
              const root = typeof editor.getRootElement === "function" ? editor.getRootElement() : null;
              if (root && (root.innerText || root.textContent)) textResult = root.innerText || root.textContent;
            } catch (_) {}
          });
          if (typeof textResult === "string" && textResult.trim()) return textResult.replace(/\u200B/g, "");
        }
      } catch (_) {}
    }
    const txt = (typeof target.innerText === "string" && target.innerText.trim())
      ? target.innerText
      : (target.textContent || "");
    return txt.replace(/\u200B/g, "");
  }

  function verifyWritten(target, expectedText) {
    const cur = readText(target).trim();
    const exp = String(expectedText || "").trim();
    if (!exp) return !cur;
    if (cur === exp) return true;
    const prefix = exp.slice(0, Math.min(25, exp.length));
    if (prefix && cur.startsWith(prefix)) return true;
    if (Math.abs(cur.length - exp.length) <= Math.max(6, exp.length * 0.05)) {
      const head = exp.slice(0, 12);
      if (head && cur.includes(head)) return true;
    }
    return false;
  }

  /** 五级写回（逐字照抄 zcode-enhance-prompt.js 的 writeText，仅诊断字段名改为本脚本的 diag）。 */
  function writeTextLocal(el, text) {
    if (!el) return false;
    const target = resolveEditorTarget(el);
    if (!target) return false;

    try { target.focus(); } catch (_) {}

    // ★ 策略 1：React Fiber 直调官方暴露的 editorApiRef.setText
    const api = findEditorApiFromFiber(target);
    if (api && typeof api.setText === "function") {
      try {
        api.setText(text);
        try { api.focus?.(); } catch (_) {}
        if (verifyWritten(target, text)) { diag.writeMethod = "fiber-editor-api"; return true; }
      } catch (err) { /* 落到下级策略 */ }
    }

    // ★ 策略 2：Lexical 原生 parseEditorState + setEditorState
    const editor = findLexicalEditor(target);
    if (editor && typeof editor.parseEditorState === "function" && typeof editor.setEditorState === "function") {
      try {
        const jsonState = buildLexicalStateJson(text);
        const parsed = editor.parseEditorState(JSON.stringify(jsonState));
        editor.setEditorState(parsed);
        try { editor.focus(); } catch (_) {}
        if (verifyWritten(target, text)) { diag.writeMethod = "lexical-parse-state"; return true; }
      } catch (err) { /* 落到下级策略 */ }
    }

    // ★ 策略 3：标准剪贴板粘贴回退（合成 ClipboardEvent('paste')）
    try {
      if (typeof window !== "undefined" && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        if (typeof DataTransfer !== "undefined" && typeof ClipboardEvent !== "undefined") {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          const pasteEvt = new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          target.dispatchEvent(pasteEvt);
          if (verifyWritten(target, text)) { diag.writeMethod = "clipboard-paste"; return true; }
        }
      }
    } catch (_) {}

    // ★ 策略 4：document.execCommand('insertText') + 选区
    try {
      if (typeof target.select === "function") {
        target.select();
      } else if (typeof target.setSelectionRange === "function") {
        target.setSelectionRange(0, readText(target).length);
      } else if (typeof window !== "undefined" && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (document.execCommand && document.execCommand("insertText", false, text)) {
        if (verifyWritten(target, text)) { diag.writeMethod = "execCommand"; return true; }
      }
    } catch (_) {}

    // ★ 策略 5：原生 Setter 与 DOM 事件链
    try {
      const isTextArea = target.tagName === "TEXTAREA";
      const isInput = target.tagName === "INPUT";
      const proto = isTextArea
        ? (typeof HTMLTextAreaElement !== "undefined" ? HTMLTextAreaElement.prototype : null)
        : (isInput ? (typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : null) : null);
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(target, text);
      else if ("value" in target) target.value = text;
      else target.textContent = text;

      try { if (target._valueTracker) target._valueTracker.setValue(text); } catch (_) {}
      try {
        target.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, inputType: "insertText", data: text,
        }));
      } catch (_) {}
      try {
        target.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: text,
        }));
      } catch (_) {
        try { target.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
      }
      try { target.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}

      if (verifyWritten(target, text)) { diag.writeMethod = "setter-input-event"; return true; }
    } catch (_) {}

    // ★ 最终宽限校验
    if (verifyWritten(target, text)) { diag.writeMethod = "relaxed-pass"; return true; }
    return false;
  }

  /** 写回 composer：优先复用增强脚本暴露的实现（真复用），否则用上面的同款副本。 */
  function writeIntoComposer(el, text) {
    const shared = safe(() => {
      const d = window.__zenhanceDiag;
      return d && typeof d.writeText === "function" ? d.writeText : null;
    }, null);
    if (shared) {
      diag.writeSource = "zenhance-reuse";
      const ok = safe(() => shared(el, text), false);
      if (ok) return true;
    }
    diag.writeSource = "local-copy";
    return writeTextLocal(el, text);
  }

  // ============================ 发送（崩溃恢复专用） ============================
  // 契约 §2.3.4：点击 `[data-testid="v4-composer-send"]`（缺失时回退父按钮 / 表单提交）。
  // 注意：绝不点 `v4-stop`（那会打断本轮）。
  function clickSend() {
    return safe(() => {
      let btn = document.querySelector("[data-testid='v4-composer-send']");
      if (btn && isInsideSidePane(btn)) btn = null;
      if (!btn) {
        const dock = findDock();
        if (dock) {
          const sub = dock.querySelector("button[type='submit']");
          if (sub && !sub.disabled) btn = sub;
        }
      }
      if (btn && !btn.disabled) { btn.click(); return "click-send"; }
      // 回退：send 按钮缺失时，取其父按钮（契约 §2.3.4）
      if (btn && btn.parentElement && btn.parentElement.tagName === "BUTTON") {
        btn.parentElement.click();
        return "click-parent";
      }
      // 回退：表单提交
      const dock = findDock();
      const form = (dock && dock.querySelector("form")) ||
        document.querySelector("[data-testid='v4-composer'] form");
      if (form) {
        try { if (typeof form.requestSubmit === "function") { form.requestSubmit(); return "requestSubmit"; } } catch (_) {}
        try { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return "submit-event"; } catch (_) {}
      }
      return null;
    }, null);
  }

  // ============================ 崩溃恢复（唯一发送路径） ============================
  function activitySince(ts) {
    if (lastActivityAt > ts) return true;
    return safe(() => !!document.querySelector("[data-testid='v4-stop']"), false);
  }

  function pruneJournal() {
    const now = Date.now();
    let changed = false;
    for (const sid of Object.keys(journal)) {
      const e = journal[sid];
      const at = (e && (e.lastActivityAt || e.startedAt)) || 0;
      if (!e || now - at > JOURNAL_STALE_MS) { delete journal[sid]; changed = true; }
    }
    if (changed) { diag.journalPruned = true; persistJournal(); }
  }

  function recoverIfNeeded() {
    if (diag.recoverDone) return;
    if (!stateReady) return;
    const sid = sessionId();
    if (!sid) { diag.recoverSkip = "无会话 ID"; return; }
    if (!isArmedFor(sid)) { diag.recoverSkip = "当前会话未开启/全局暂停"; return; }
    const entry = journal[sid];
    if (!entry || typeof entry !== "object") { diag.recoverSkip = "无在途轮次"; return; }
    const at = entry.lastActivityAt || entry.startedAt || 0;
    if (Date.now() - at > JOURNAL_STALE_MS) {
      delete journal[sid]; persistJournal();
      diag.recoverSkip = "台账过期";
      return;
    }
    if (isStreaming()) { diag.recoverSkip = "当前会话仍在生成"; return; }
    // 该轮已经成功恢复过且没有新轮次接管（turnId 未变）→ 不再重复发送，避免重启循环
    if (entry.recoveredAt && (Number(entry.attempts) || 0) >= 1) { diag.recoverSkip = "该轮已恢复过"; return; }
    diag.recoverDone = true;
    enqueueRecover(sid, entry);
  }

  function attemptRecover(sid, entry) {
    // 契约 §2.2：cancelToken 作废 / 暂停 / 关闭后，不再执行任何本地发送
    if (!isArmedFor(sid)) { diag.recoverResult = "当前会话已关闭/全局暂停，放弃"; return; }
    // 台账已被新轮次接管（说明活动已发生）→ 放弃本次恢复，绝不覆盖新条目。
    // ★ 必须比 turnId 而不是比对象：状态文件是唯一权威，每次轮询都会把 journal
    //   整体换成 IPC 返回的副本（对象身份必变），比身份会把「同一轮」误判成
    //   「已被新轮次接管」→ 校验窗口后既不重试也不收尾，台账永久滞留。
    if (journal[sid] && journal[sid] !== entry && journal[sid].turnId !== entry.turnId) {
      diag.recoverResult = "已被新轮次接管";
      return;
    }
    const attempt = (Number(entry.attempts) || 0) + 1;
    entry.attempts = attempt;
    entry.lastAttemptAt = Date.now();
    journal[sid] = entry;
    persistJournal();
    diag.recoverAttempt = attempt;

    if (attempt > MAX_ATTEMPTS) {
      // 契约 §2.3.4：再失败只提示，不循环重试
      delete journal[sid];
      persistJournal();
      diag.recoverResult = "放弃（已达重试上限）";
      toast("自动继续：意外中断的会话恢复失败，已停止重试，请手动发送「继续」");
      return;
    }

    const text = String(entry.text || "").trim() || settings.continueTextInterrupted || RECOVER_TEXT;
    const input = findInput();
    if (!input) {
      diag.recoverResult = "找不到输入框";
      setTaskTimer(() => attemptRecover(sid, entry), 800);
      return;
    }
    const ok = writeIntoComposer(input, text);
    diag.recoverWrite = ok;
    if (!ok) {
      diag.recoverResult = "写回失败";
      setTaskTimer(() => attemptRecover(sid, entry), 800);
      return;
    }
    const sentAt = Date.now();
    const method = clickSend();
    diag.recoverSend = method;
    if (!method) {
      diag.recoverResult = "发送按钮缺失";
      setTaskTimer(() => attemptRecover(sid, entry), 800);
      return;
    }
    // 校验：1.5s 内出现新的流式活动才算成功
    setTaskTimer(() => {
      if (activitySince(sentAt)) {
        diag.recoverResult = "成功";
        // 只有台账仍归本轮时才写回（新一轮可能已把条目换掉；比 turnId，理由见上）
        if (journal[sid] && (journal[sid] === entry || journal[sid].turnId === entry.turnId)) {
          entry.recoveredAt = Date.now();
          journal[sid] = entry;
          persistJournal();
        }
        toast("自动继续：已恢复意外中断的会话");
      } else {
        if (attempt >= MAX_ATTEMPTS) {
          // 契约 §2.3.4：再失败只提示，不循环重试
          delete journal[sid];
          persistJournal();
          diag.recoverResult = "放弃（已达重试上限）";
          toast("自动继续：意外中断的会话恢复失败，已停止重试，请手动发送「继续」");
        } else {
          diag.recoverResult = "无流式响应";
          attemptRecover(sid, entry);
        }
      }
    }, VERIFY_MS);
  }

  // ============================ 主循环 ============================
  async function refreshState(initial) {
    const ok = await fetchState();
    if (!ok) {
      if (bridgeMissing) hideUi();     // 桥未注入（补丁未打）→ 安静降级
      return;
    }
    loadJournalMirror();
    if (initial) pruneJournal();
    // 暂停 / 关闭 → 停止一切本地动作（保留状态显示）
    if (!isArmed()) clearTaskTimers();
    ensureUi();
    if (initial) recoverIfNeeded();
  }

  function start() {
    ensureStyle();
    diag.bridgePresent = !!bridge();
    // 首次拉取（只读）
    refreshState(true);
    // 契约 §2.2：每 1500ms 轮询一次，document.hidden 时跳过
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      // 生成中：刷新 journal 心跳（节流到 3s，限制写盘）
      if (isStreaming()) {
        const sid = currentSessionId || sessionId();
        if (sid && journal[sid] && Date.now() - lastHeartbeatAt > HEARTBEAT_MS) {
          lastHeartbeatAt = Date.now();
          journal[sid].lastActivityAt = Date.now();
          persistJournal();
        }
      }
      refreshState(false);
    }, POLL_MS);
    // 契约 §2.2：visibilitychange 时立即拉取
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshState(false);
    });
    // 挂载点巡检：React 重渲染会把我们的节点搬走/删掉，低频重挂（不产生新挂载点冲突）
    attachTimer = setInterval(() => {
      if (document.hidden) return;
      if (bridgeMissing) return;
      ensureUi();
    }, ATTACH_MS);
    ensureUi();
    // 自检出口（不刷 console 错误，只留诊断对象）
    setTimeout(() => {
      diag.diagReady = true;
      diag.portInjected = !!diag.portHooked;
    }, 5000);
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  // 正常退出（非崩溃）时清掉「已收尾」的台账：
  //   生成中被关闭 → 保留（视为意外中断，下次启动恢复）；
  //   空闲时关闭 → 删除（避免上一轮漏收尾信号导致下次启动误发）。
  function onPageHide() {
    safe(() => {
      if (isStreaming()) return;
      const sid = currentSessionId || sessionId();
      if (sid && journal[sid]) { delete journal[sid]; persistJournal(); }
    });
  }
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);

  // 调试出口（热注入/排障用；均为只读或幂等操作）
  window.__zpilotApi = {
    refresh: () => refreshState(false),
    state: () => ({ ...st, sessions, journal, settings }),
    ui: () => ({ toggle: !!toggleEl, settingsTab: settingsUiActive }),
    recover: () => { diag.recoverDone = false; recoverIfNeeded(); },
    writeText: writeIntoComposer,
    clickSend,
    findInput,
  };
})();
