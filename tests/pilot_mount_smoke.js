// 「自动继续」渲染层控制面回归测试：用最小 DOM 桩复刻主会话 + composer 结构，
// 把 zcode-pilot.js 真跑一遍，逐条核对契约 §5 的落点与 §2.2 的状态同步。
//
// 为什么必须行为级验证（`node --check` 与肉眼 review 都抓不到）：
//   ① 开关落点是**索引相关**的 —— 「插在模式切换右侧」错一位就是插到它左边/父行末尾，
//      静态断言只看到代码里有 afterend，看不出最终 DOM 里它排在第几个；
//   ② 状态显示只有一处（输入框开关本身）——会话区顶部状态条已按用户要求移除，插回去就是「被误认成官方控件、挡住标题行」的回归；
//   ③ cancelToken 变化要真的清空待发队列 —— 漏清就是「用户已在配置页关闭保存，
//     客户端却又自己发了一轮」，这是最危险的一种静默失效；
//   ④ 桥缺失时必须**安静降级**：不能抛异常（会打断整个 renderer 启动），
//      也不能刷一屏错误；
//   ⑤ 开关只能落在工具栏行里，绝不侵入 zcode-tps.js 的状态栏节点；
//   ⑥ 崩溃恢复的「同一轮」判定只能比 turnId、不能比对象身份 —— 状态文件是唯一权威，
//      每轮轮询都会把 journal 整体换成 IPC 返回的副本；比身份会把同一轮误判成
//      「已被新轮次接管」：既不重试也不收尾，台账永久滞留、下次启动误发「继续」。
//      场景 3c 是不 bump cancelToken 的对照组，用来证明 3b 的「已取消」不是
//      定时器桩失灵造成的假通过。
//
// 用法：node tests/pilot_mount_smoke.js <zcode-pilot.js 路径>
// 退出码 0 = 通过；非 0 时逐条打印失败原因。
const fs = require("fs");
const vm = require("vm");

const target = process.argv[2];
if (!target) {
  console.error("用法：node tests/pilot_mount_smoke.js <zcode-pilot.js 的路径>");
  console.error("例如：node tests/pilot_mount_smoke.js skills/zcode-pilot/scripts/zcode-pilot.js");
  process.exit(2);
}
let src;
try {
  src = fs.readFileSync(target, "utf8");
} catch (err) {
  console.error("读不到被测脚本：" + target + "\n  " + err.message);
  process.exit(2);
}

// ---------------------------------------------------------------- 最小 DOM
function parseSelector(sel) {
  return String(sel).split(",").map((part) => {
    const c = { tag: null, id: null, attrs: [], classes: [] };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\[([\w-]+)(?:([*^$]?=)["']?([^"'\]]*)["']?)?\]|\.([\w-]+)/g;
    let m;
    while ((m = re.exec(part))) {
      if (m[1]) c.tag = m[1].toLowerCase();
      else if (m[2]) c.id = m[2];
      else if (m[3]) c.attrs.push({ name: m[3].toLowerCase(), op: m[4] || null, value: m[5] == null ? "" : m[5] });
      else if (m[6]) c.classes.push(m[6]);
    }
    return c;
  });
}

function matchCompound(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) {
    if (!(" " + (el.attrs["class"] || "") + " ").includes(" " + cls + " ")) return false;
  }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v == null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*=" && !String(v).includes(a.value)) return false;
    if (a.op === "^=" && !String(v).startsWith(a.value)) return false;
    if (a.op === "$=" && !String(v).endsWith(a.value)) return false;
  }
  return true;
}

function matches(el, sel) {
  return parseSelector(sel).some((c) => matchCompound(el, c));
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.attrs = Object.create(null);
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: "", setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.textContent = "";
    this.innerHTML = "";
    this.id = "";
    this.title = "";
    this.disabled = false;
    this.__value = "";
    this.__clicks = 0;
    this.__hidden = false;
    this.__rect = { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
    this.__listeners = {};
  }
  get className() { return this.attrs["class"] || ""; }
  set className(v) { this.attrs["class"] = String(v); }
  // 输入框文本：脚本的原生 setter 回退会直接写 __value，读回也必须走这里
  get value() { return this.__value; }
  set value(v) { this.__value = String(v); }
  get isConnected() {
    let n = this;
    while (n) { if (n.__isBody) return true; n = n.parentElement; }
    return false;
  }
  // ★ 被测脚本靠 nextSibling 决定「插在模式切换右侧」的确切位置，桩必须实现真语义
  get nextSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  // ★ 漂移判定（isRightOfTrigger）读的是 previousElementSibling：桩不给它就等于永远判不出「已在右侧」
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i - 1] || null;
  }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[String(k).toLowerCase()] = String(v); }
  getAttribute(k) {
    const key = String(k).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }
  hasAttribute(k) { return this.getAttribute(k) != null; }
  removeAttribute(k) { delete this.attrs[String(k).toLowerCase()]; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    const i = c.parentElement ? c.parentElement.children.indexOf(c) : -1;
    if (i >= 0) c.parentElement.children.splice(i, 1);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c);
    c.parentElement = this;
    return c;
  }
  insertAdjacentElement(pos, el) {
    // ★ 真语义：先把 el 从它当前父节点摘走，否则反复巡检会让同一个节点在
    //   children 里出现 N 次，测试就会误报成「脚本重复造开关」。
    if (el.parentElement) el.remove();
    if (pos === "afterend" && this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      this.parentElement.children.splice(i + 1, 0, el);
      el.parentElement = this.parentElement;
    } else if (pos === "beforeend") this.appendChild(el);
    else if (pos === "afterbegin") this.insertBefore(el, this.children[0] || null);
    else if (pos === "beforebegin" && this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      this.parentElement.children.splice(i, 0, el);
      el.parentElement = this.parentElement;
    }
    return el;
  }
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  }
  contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentElement; } return null; }
  descendants() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel) { return this.descendants().filter((el) => matches(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return Object.assign({}, this.__rect); }
  getClientRects() { return [this.getBoundingClientRect()]; }
  addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) {
    const type = (ev && ev.type) || (ev && ev.constructor && ev.constructor.name) || "unknown";
    for (const fn of (this.__listeners[type] || []).slice()) { try { fn(ev); } catch (e) { dispatchErrors.push(type + ": " + e.message); } }
    return true;
  }
  focus() { this.__focused = (this.__focused || 0) + 1; }
  blur() {}
  select() { this.__selected = true; }
  setSelectionRange() { this.__selected = true; }
  click() { this.__clicks++; for (const fn of this.__listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); }
}

function makeDocument() {
  const doc = {
    hidden: false,
    head: new El("head"),
    body: new El("body"),
    createElement: (t) => new El(t),
    createElementNS: (_ns, t) => new El(t),
    createRange: () => ({ selectNodeContents() {} }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    execCommand: () => false,
    __listeners: Object.create(null),
    addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = this.__listeners[t]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
  };
  doc.body.__isBody = true;
  doc.getElementById = (id) =>
    doc.body.descendants().concat([doc.head]).find((el) => el.id === id) || null;
  doc.querySelectorAll = (sel) => doc.body.descendants().filter((el) => matches(el, sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  return doc;
}

// ---------------------------------------------------------------- 搭真实结构
// 主会话：
//   div[data-workspace-conversation-frame][data-session-id=s-1]
//     ├─ div[data-testid=v4-session-pane]
//     │   ├─ div[data-ztps-bar=true]        ← TPS 状态栏先占了 sticky 位
//     │   └─ div（消息列表）
//     └─ div[data-v4-composer-dock]
//         └─ div[data-testid=v4-composer]
//             ├─ textarea[data-testid=v4-composer-input]   ← 崩溃恢复写回目标
//             └─ div（工具栏行）
//                 ├─ div[data-testid=chat-mode-select-trigger]  ← 模式切换
//                 ├─ span（别的控件，用来验证开关没插到它后面）
//                 └─ button[data-testid=v4-composer-send]
function buildTree(doc) {
  const mk = (tag, attrs, cls) => {
    const el = new El(tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    if (cls) el.className = cls;
    return el;
  };
  const frame = mk("div", { "data-workspace-conversation-frame": "true", "data-session-id": "s-1" });
  const pane = mk("div", { "data-testid": "v4-session-pane" });
  const tpsBar = mk("div", { "data-ztps-bar": "true" });
  const msgs = mk("div", { "data-testid": "v4-message-list" });
  pane.appendChild(tpsBar);
  pane.appendChild(msgs);
  frame.appendChild(pane);

  const dock = mk("div", { "data-v4-composer-dock": "true" });
  const card = mk("div", { "data-testid": "v4-composer" });
  const input = mk("textarea", { "data-testid": "v4-composer-input" });
  const row = mk("div", null, "group/toolbar flex items-end gap-3");
  const mode = mk("div", { "data-testid": "chat-mode-select-trigger" });
  const other = mk("span", { "data-testid": "some-other-control" });
  const send = mk("button", { "data-testid": "v4-composer-send" });
  row.appendChild(mode);
  row.appendChild(other);
  row.appendChild(send);
  dock.appendChild(card);
  card.appendChild(input);
  card.appendChild(row);
  frame.appendChild(dock);
  doc.body.appendChild(frame);
  return { frame, pane, tpsBar, msgs, dock, card, input, row, mode, other, send, mk };
}

// ---------------------------------------------------------------- 跑脚本
const bad = [];
const dispatchErrors = [];
const check = (cond, msg) => { if (!cond) bad.push(msg); };
const tickAsync = () => new Promise((r) => setImmediate(r));
const fire = (el, type, ev) => { for (const fn of (el.__listeners[type] || []).slice()) fn(ev); };

function boot(doc, bridgeState, opts) {
  const o = opts || {};
  const timers = { intervals: [], timeouts: new Map(), nextId: 1 };
  const clock = { now: 1700000000000 };
  const calls = { patches: [], reads: 0 };
  let state = Object.assign({
    version: 1, enabled: true, runtime: true, paused: false, cancelToken: 0,
    lastContinueAt: 0, sessions: { "s-1": { consecutive: 2, lastAt: 0 } }, journal: {},
  }, bridgeState || {});

  // 可控时钟：脚本既用 Date.now() 也用 new Date().toISOString()，必须两者都支持
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(args.length ? args[0] : clock.now); }
    static now() { return clock.now; }
  }

  // 原生 value setter 桩：策略 5「原生 Setter + InputEvent 链」必须能从原型上拿到它
  const valueProto = {};
  Object.defineProperty(valueProto, "value", {
    configurable: true,
    get() { return this.__value; },
    set(v) { this.__value = String(v); },
  });

  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    Date: FakeDate,
    setTimeout: (fn) => { const id = timers.nextId++; timers.timeouts.set(id, fn); return id; },
    clearTimeout: (id) => { timers.timeouts.delete(id); },
    setInterval: (fn) => { const id = timers.nextId + 100000; timers.nextId++; timers.intervals.push(fn); return id; },
    clearInterval: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    Event: class { constructor(type) { this.type = type; this.bubbles = false; } },
    // 宿主 API：vm 新上下文自带 JS 内建对象，但不带这些浏览器/Node 才有的全局
    TextDecoder: require("util").TextDecoder,
    TextEncoder: require("util").TextEncoder,
    HTMLTextAreaElement: { prototype: valueProto },
    HTMLInputElement: { prototype: valueProto },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    localStorage: (() => {
      const mem = Object.create(null);
      return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); },
               removeItem: (k) => { delete mem[k]; } };
    })(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__listeners = Object.create(null);
  sandbox.addEventListener = function (t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); };
  sandbox.removeEventListener = function () {};

  if (!o.noBridge) {
    sandbox.zcode = {
      pilotState: async (patch) => {
        if (patch === undefined) { calls.reads++; return JSON.parse(JSON.stringify(state)); }
        calls.patches.push(JSON.parse(JSON.stringify(patch)));
        // 复刻主进程 handler 的关键语义：sessionMode 写进该会话的 sessions[id].mode，
        // settings 按对象合并；其余字段顶层合并。
        const p = JSON.parse(JSON.stringify(patch));
        if (p.sessionMode && typeof p.sessionMode === "object") {
          const id = String(p.sessionMode.id || "").trim();
          const mode = String(p.sessionMode.mode || "");
          if (id && ["default", "off", "recover", "loop"].includes(mode)) {
            state.sessions = Object.assign({}, state.sessions);
            state.sessions[id] = Object.assign({}, state.sessions[id] || {}, { mode });
          }
          delete p.sessionMode;
        }
        if (p.settings && typeof p.settings === "object") {
          state.settings = Object.assign({}, state.settings || {}, p.settings);
          delete p.settings;
        }
        state = Object.assign({}, state, p);
        return JSON.parse(JSON.stringify(state));
      },
    };
  }
  vm.runInNewContext(src, sandbox, { filename: "zcode-pilot.js" });
  return {
    sandbox, clock, calls, timers,
    setState: (patch) => { state = Object.assign({}, state, patch); },
    tick: () => { for (const fn of timers.intervals.slice()) { try { fn(); } catch (e) { bad.push("定时器抛异常: " + e.message); } } },
    // ★ 排空「已排队的继续」：clearTimeout 掉的必须真的不再执行
    runTimers: (rounds) => {
      const n = rounds || 1;
      for (let i = 0; i < n; i++) {
        const pend = Array.from(timers.timeouts.values());
        timers.timeouts.clear();
        for (const fn of pend) { try { fn(); } catch (e) { bad.push("延时任务抛异常: " + e.message); } }
      }
    },
    pendingTimers: () => timers.timeouts.size,
  };
}

const TOGGLE = "[data-zpilot-toggle]";
// 会话区顶部状态框已移除；保留选择器只为防回退断言（再出现即失败）
const STATUS = "[data-zpilot-status]";

async function main() {
  // ============ 场景 1：正常注入（桥在） ============
  const doc = makeDocument();
  const t = buildTree(doc);
  const h = boot(doc, {}, {});
  await tickAsync();
  h.tick();
  await tickAsync();

  const toggle = doc.querySelector(TOGGLE);
  check(!!toggle, "桥存在时输入框开关没挂上（diag=" + JSON.stringify(h.sandbox.__zpilotDiag.toggleHiddenReason || h.sandbox.__zpilotDiag.toggleError) + "）");
  check(h.sandbox.__zpilotDiag.bridgePresent === true, "diag.bridgePresent 应为 true");
  check(!h.sandbox.__zpilotDiag.portStarted, "绝不允许 portStarted（会吃掉应用 Initialize 握手）");

  if (toggle) {
    // ① 落点：必须紧跟在「模式切换」右侧，而不是 some-other-control 之后 / 行尾
    check(toggle.parentElement === t.row, "开关应落在模式切换所在工具栏行，实际 parent=" + toggle.parentElement.getAttribute("data-testid"));
    check(t.mode.nextSibling === toggle,
      "★ 开关必须插在「模式切换」**右侧紧邻位**，实际 row 顺序=" + t.row.children.map((c) => c.getAttribute("data-testid") || c.tagName).join(">"));
    check(t.row.children.indexOf(toggle) === t.row.children.indexOf(t.mode) + 1, "开关索引必须是模式切换 +1");
    // ② 状态：enabled/runtime 真、paused 假 → on
    check(toggle.getAttribute("data-state") === "on", "初始 data-state 应为 on，实际=" + toggle.getAttribute("data-state"));
    check(toggle.getAttribute("data-runtime") === "1", "runtime=true 时 data-runtime 应为 1");
    check(toggle.getAttribute("aria-checked") === "true", "aria-checked 应跟随 runtime");
  }
  // ③ 会话区不得再出现我们的状态框；pane 首子节点仍归 TPS；开关不得嵌进 TPS 节点
  check(doc.querySelectorAll(STATUS).length === 0, "会话区顶部状态框已移除，不得再插回");
  check(t.pane.children.indexOf(t.tpsBar) === 0, "TPS 状态栏必须仍是 pane 首子节点");
  if (toggle) check(!toggle.closest("[data-ztps-bar]"), "开关不得嵌进 TPS 状态栏节点内");

  // ⑥ 点一下开关 → 必须经桥写 runtime，且两处状态同帧翻转
  if (toggle) {
    const before = h.calls.patches.length;
    toggle.click();
    await tickAsync();
    h.tick();
    await tickAsync();
    check(h.calls.patches.length > before, "点击开关没有经 pilotState(patch) 写状态（静默失效）");
    const patch = h.calls.patches[h.calls.patches.length - 1] || {};
    check(patch.sessionMode && patch.sessionMode.id === "s-1" && patch.sessionMode.mode === "off",
      "点击应只切换当前会话的 mode，实际 patch=" + JSON.stringify(patch));
    const t2 = doc.querySelector(TOGGLE);
    check(t2 && t2.getAttribute("data-runtime") === "0", "写回后开关 data-runtime 应为 0");
    check(t2 && t2.getAttribute("data-state") === "off", "当前会话 mode=off 应显示 off，实际=" + (t2 && t2.getAttribute("data-state")));
  }

  // ============ 场景 2a：配置页关闭保存 → 显示「已关闭」 ============
  // 契约 §2.2 关闭保存写的是 enabled=false + paused=true；界面必须优先说「关闭」，
  // 因为对用户而言这是「整个能力不生效」，比「暂停」更强。
  const doc2 = makeDocument();
  buildTree(doc2);
  const h2 = boot(doc2, { enabled: false, paused: true, runtime: true }, {});
  await tickAsync();
  h2.tick();
  await tickAsync();
  const tg2 = doc2.querySelector(TOGGLE);
  check(!!tg2, "关闭态也应显示开关（让用户看得见为什么不自动继续）");
  check(tg2 && tg2.getAttribute("data-state") === "off", "关闭保存后 data-state 应为 off，实际=" + (tg2 && tg2.getAttribute("data-state")));
  check(h2.sandbox.__zpilotDiag.ui && h2.sandbox.__zpilotDiag.ui.armed === false,
    "enabled=false 时 armed 必须为 false（不再自动继续）");

  // ============ 场景 2b：全局暂停（开关仍开，但 paused） ============
  const doc2b = makeDocument();
  buildTree(doc2b);
  const h2b = boot(doc2b, { enabled: true, paused: true, runtime: true }, {});
  await tickAsync();
  h2b.tick();
  await tickAsync();
  const tg2b = doc2b.querySelector(TOGGLE);
  check(tg2b && tg2b.getAttribute("data-state") === "paused", "paused 时 data-state 应为 paused，实际=" + (tg2b && tg2b.getAttribute("data-state")));
  check(tg2b && tg2b.getAttribute("data-runtime") === "1", "暂停≠关闭：runtime 仍为开，data-runtime 应为 1");
  check(h2b.sandbox.__zpilotDiag.ui && h2b.sandbox.__zpilotDiag.ui.armed === false,
    "paused 时 armed 必须为 false（暂停不是关闭，但仍不得自动继续）");

  // ============ 场景 3a：意外中断恢复 —— journal 有未收尾轮次 → 写回并发送 ============
  const JOURNAL = { "s-1": { turnId: "t1", startedAt: 1700000000000, lastActivityAt: 1700000000000, text: "继续" } };
  const docA = makeDocument();
  const tA = buildTree(docA);
  const hA = boot(docA, { journal: JOURNAL }, {});
  await tickAsync();
  hA.tick();
  await tickAsync();
  const dA = hA.sandbox.__zpilotDiag;
  check(dA.recoverAttempt === 1, "崩溃恢复必须自动尝试 1 次，diag.recoverResult=" + dA.recoverResult + " skip=" + dA.recoverSkip);
  check(dA.recoverWrite === true, "五级写回没成功：method=" + dA.writeMethod + " result=" + dA.recoverResult);
  check(tA.input.value === "继续", "续跑文本没写进输入框，实际=" + JSON.stringify(tA.input.value));
  check(dA.recoverSend === "click-send" && tA.send.__clicks === 1,
    "必须点 v4-composer-send 完成发送，diag.recoverSend=" + dA.recoverSend + " 点击次数=" + tA.send.__clicks);
  check(hA.pendingTimers() >= 1 && dA.diagReady !== true, "发送后应留下 1.5s 流式校验定时器（契约 §2.3.4），实际排队=" + hA.pendingTimers());
  // 校验窗口内没有新流式活动 → 只重试 1 次，再失败就放弃（绝不死循环狂发）
  hA.runTimers(1);
  await tickAsync();
  hA.runTimers(1);
  await tickAsync();
  check(dA.recoverAttempt === 2, "无流式响应时只允许重试 1 次，实际 attempt=" + dA.recoverAttempt);
  check(tA.send.__clicks === 2, "重试那一次应再次发送，实际点击=" + tA.send.__clicks);
  hA.runTimers(2);
  await tickAsync();
  check(/上限|放弃/.test(String(dA.recoverResult)), "达重试上限后必须停手，实际 recoverResult=" + dA.recoverResult);
  check(dA.recoverAttempt === 2, "放弃后不得再有第 3 次尝试，实际 attempt=" + dA.recoverAttempt);

  // ============ 场景 3b：cancelToken 变化 → 作废所有已排队的继续 ============
  // 输入框还没挂载 → 脚本会排一个 800ms 重试（= 真正的「已排队继续」）。
  // 用户在配置页关闭保存后，这个重试绝不能再把「继续」自己发出去。
  const docB = makeDocument();
  const tB = buildTree(docB);
  tB.input.remove();
  const hB = boot(docB, { journal: { "s-1": Object.assign({}, JOURNAL["s-1"]) } }, {});
  await tickAsync();
  hB.tick();
  await tickAsync();
  const dB = hB.sandbox.__zpilotDiag;
  const pendB = hB.pendingTimers();
  check(dB.recoverAttempt === 1 && pendB >= 1,
    "前置条件没成立：应有 1 次尝试 + 至少 1 个排队重试（attempt=" + dB.recoverAttempt + " 排队=" + pendB + "）");
  hB.setState({ cancelToken: 1, enabled: false, paused: true });
  hB.tick();
  await tickAsync();
  check(!!dB.cancelTokenBumped, "cancelToken 变化必须被识别（否则已排队的继续会照发）");
  check(dB.cancelTokenBumped && dB.cancelTokenBumped.to === 1, "diag.cancelTokenBumped 应记录 from/to");
  check(hB.pendingTimers() < pendB, "cancelToken 变化必须清掉排队中的重试定时器，实际 " + pendB + "→" + hB.pendingTimers());
  const attemptBefore = dB.recoverAttempt;
  hB.runTimers(2);
  await tickAsync();
  check(dB.recoverAttempt === attemptBefore, "已作废的排队继续绝不能再次执行发送，实际 attempt " + attemptBefore + "→" + dB.recoverAttempt);

  // ============ 场景 3c：对照组 —— 不 bump 时排队重试必须真的会跑 ============
  // 没有这一条，3b 的「没再执行」可能只是我的定时器桩失灵造成的假通过。
  const docC = makeDocument();
  const tC = buildTree(docC);
  tC.input.remove();
  const hC = boot(docC, { journal: { "s-1": Object.assign({}, JOURNAL["s-1"]) } }, {});
  await tickAsync();
  hC.tick();
  await tickAsync();
  const dC = hC.sandbox.__zpilotDiag;
  check(hC.pendingTimers() >= 1, "对照组：排队定时器必须可执行");
  hC.runTimers(1);
  await tickAsync();
  check(dC.diagReady === true, "对照组失灵：runTimers 没有真的执行排队任务");
  check(dC.recoverAttempt === 2, "对照组必须证明重试会跑（否则 3b 的「已取消」是假通过），实际 attempt=" + dC.recoverAttempt);

  // ============ 场景 4：桥缺失 → 安静降级 ============
  const doc4 = makeDocument();
  buildTree(doc4);
  let threw = null;
  try {
    const h4 = boot(doc4, null, { noBridge: true });
    await tickAsync();
    h4.tick();
    await tickAsync();
    check(!doc4.querySelector(TOGGLE), "桥缺失时不该造出开关（点了也没用，还会误导用户）");
    check(!doc4.querySelector(STATUS), "桥缺失时不该造出任何状态节点");
    check(h4.sandbox.__zpilotDiag.bridgePresent === false, "diag 应记录桥缺失，便于排障");
  } catch (err) { threw = err; }
  check(!threw, "桥缺失时抛异常会打断 renderer 启动：" + (threw && threw.message));

  // ============ 场景 5：幂等 + 重渲染自愈 ============
  const doc5 = makeDocument();
  const t5 = buildTree(doc5);
  const h5 = boot(doc5, {}, {});
  await tickAsync();
  h5.tick();
  await tickAsync();
  const refToggle = doc5.querySelector(TOGGLE);
  for (let i = 0; i < 5; i++) { h5.tick(); await tickAsync(); }
  check(doc5.querySelectorAll(TOGGLE).length === 1, "反复巡检不得重复造开关，实际=" + doc5.querySelectorAll(TOGGLE).length);
  check(doc5.querySelector(TOGGLE) === refToggle, "幂等巡检不应重建开关节点");
  check(doc5.querySelectorAll(STATUS).length === 0, "巡检绝不该造出会话区状态框");
  // React 重渲染把开关从 DOM 里摘掉 → 下一次巡检必须自愈搬回模式切换右侧
  refToggle.remove();
  h5.tick();
  await tickAsync();
  const back = doc5.querySelector(TOGGLE);
  check(!!back && back.parentElement === t5.row && t5.mode.nextSibling === back,
    "被重渲染摘掉后应自愈搬回「模式切换」右侧，实际=" + (back && back.parentElement && back.parentElement.getAttribute("data-testid")));

  // ============ 场景 6：无模式切换锚点 → 退化到工具栏行尾，绝不插到行首 ============
  const doc6 = makeDocument();
  const t6 = buildTree(doc6);
  t6.mode.remove();
  const h6 = boot(doc6, {}, {});
  await tickAsync();
  h6.tick();
  await tickAsync();
  const tg6 = doc6.querySelector(TOGGLE);
  check(!!tg6, "无模式切换锚点时应退化挂到工具栏行（契约 §5「无则退化到其父行末尾」）");
  check(!!tg6 && t6.row.children[t6.row.children.length - 1] === tg6,
    "退化态必须落在**行尾**（插行首 = 跑到输入框左侧）");

  // ============ 场景 7：锚点后到 → 必须从行尾搬回「模式切换」右侧 ============
  // 实测缺陷（2026-10-29 CDP 取证）：React 先渲染工具栏行、后挂 chat-mode-select-trigger，
  // 旧实现只在「节点未连接」时才找落点，把行尾当成了终态 → diag.toggleWhere 永久停在
  // toolbar-end，开关跑到输入框最右侧而不是模式切换右边。这一条锁死「漂移必须被纠正」。
  const doc7 = makeDocument();
  const t7 = buildTree(doc7);
  const mode7 = t7.mode;
  mode7.remove();                        // 首轮巡检时锚点还不存在
  const h7 = boot(doc7, {}, {});
  await tickAsync();
  h7.tick();
  await tickAsync();
  const tg7 = doc7.querySelector(TOGGLE);
  check(!!tg7 && t7.row.children[t7.row.children.length - 1] === tg7,
    "前置条件没成立：无锚点时应退化到工具栏行尾，where=" + h7.sandbox.__zpilotDiag.toggleWhere);
  check(h7.sandbox.__zpilotDiag.toggleWhere === "toolbar-end(待搬回)",
    "退化态必须标记待搬回，实际=" + h7.sandbox.__zpilotDiag.toggleWhere);
  t7.row.insertBefore(mode7, t7.other);  // 锚点后到（React 补挂）
  h7.tick();
  await tickAsync();
  check(doc7.querySelector(TOGGLE) === tg7, "搬回不得重建节点（重建会丢内联状态与焦点）");
  check(t7.mode.nextSibling === tg7,
    "★ 锚点后到后必须搬回「模式切换」右侧，实际 row 顺序=" +
    t7.row.children.map((c) => c.getAttribute("data-testid") || c.tagName).join(">"));
  check(h7.sandbox.__zpilotDiag.toggleWhere === "after-trigger",
    "搬回后 diag.toggleWhere 应为 after-trigger，实际=" + h7.sandbox.__zpilotDiag.toggleWhere);

  if (bad.length) {
    console.error("pilot mount smoke FAILED（" + bad.length + " 项）：");
    for (const m of bad) console.error("  ✗ " + m);
    process.exit(1);
  }
  console.log("pilot mount smoke OK");
}

main().then(() => {}).catch((err) => {
  console.error("pilot mount smoke 自身异常：" + (err && err.stack || err));
  process.exit(1);
});
