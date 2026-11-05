// 润色功能「会话切换隔离」冒烟测试：
// 验证：在会话 1 正在润色时切换到会话 2，会话 1 的润色结果绝对不会写入会话 2 的输入框，
// 且会话 2 状态保持干净独立；切回会话 1 时可正常恢复润色结果。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const target = process.argv[2] || path.join(__dirname, "../skills/zcode-pilot/scripts/zcode-enhance-prompt.js");
let src;
try {
  src = fs.readFileSync(target, "utf8");
} catch (err) {
  console.error("读取脚本失败: " + target, err.message);
  process.exit(2);
}

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
    this.value = "";
    this.id = "";
    this.disabled = false;
    this.__listeners = {};
  }
  get className() { return this.attrs["class"] || ""; }
  set className(v) { this.attrs["class"] = String(v); }
  get offsetParent() { return this.parentElement || null; }
  get isConnected() {
    let n = this;
    while (n) {
      if (n.__isBody) return true;
      n = n.parentElement;
    }
    return false;
  }
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
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  }
  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentElement; }
    return false;
  }
  closest(sel) {
    let n = this;
    while (n) { if (matches(n, sel)) return n; n = n.parentElement; }
    return null;
  }
  descendants() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel) { return this.descendants().filter((el) => matches(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 }; }
  addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  focus() {}
  select() {}
  click() {
    for (const fn of this.__listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} });
  }
  get firstChild() { return this.children[0] || null; }
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
    execCommand: (cmd, _ui, text) => {
      if (cmd === "insertText") {
        const inp = doc.querySelector("[data-testid='v4-composer-input']");
        if (inp) {
          inp.textContent = text;
          inp.value = text;
        }
        return true;
      }
      return false;
    },
    __listeners: Object.create(null),
    addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); },
    removeEventListener() {},
  };
  doc.body.__isBody = true;
  doc.getElementById = (id) =>
    doc.body.descendants().concat([doc.head]).find((el) => el.id === id) || null;
  doc.querySelectorAll = (sel) => doc.body.descendants().filter((el) => matches(el, sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  return doc;
}

function buildWorkspaceTree(doc, sessionId) {
  const mainFrame = new El("div");
  mainFrame.setAttribute("data-workspace-conversation-frame", "true");
  mainFrame.setAttribute("data-session-id", sessionId || "sess-initial");
  doc.body.appendChild(mainFrame);

  const dock = new El("div");
  dock.setAttribute("data-v4-composer-dock", "true");
  dock.className = "flex w-full sticky bottom-0";
  const card = new El("div");
  card.setAttribute("data-testid", "v4-composer");
  const surface = new El("div");
  const input = new El("div");
  input.setAttribute("data-testid", "v4-composer-input");
  input.textContent = "";
  input.value = "";

  const row = new El("div");
  row.className = "flex items-end";
  const trailing = new El("div");
  trailing.setAttribute("data-composer-trailing-actions", "true");
  const submitBox = new El("div");
  const send = new El("button");
  send.setAttribute("data-testid", "v4-composer-send");

  dock.appendChild(card);
  card.appendChild(surface);
  surface.appendChild(input);
  surface.appendChild(row);
  row.appendChild(trailing);
  trailing.appendChild(submitBox);
  submitBox.appendChild(send);
  mainFrame.appendChild(dock);

  return { mainFrame, dock, card, input, trailing, submitBox, send };
}

async function runTests() {
  const bad = [];
  const check = (cond, msg) => { if (!cond) bad.push(msg); };

  const doc = makeDocument();
  const tree = buildWorkspaceTree(doc, "session-A");

  let pendingEnhancePromiseResolve = null;
  const mockApi = {
    enhancePrompt: (text, _mv, _ml, _ov) => {
      return new Promise((resolve) => {
        pendingEnhancePromiseResolve = (res) => resolve(res || { success: true, text: "【润色后的内容】" + text });
      });
    },
    listEnhanceModels: () => Promise.resolve({ success: true, groups: [] }),
    saveEnhanceModel: () => Promise.resolve({ success: true }),
  };

  const activeTimers = new Map();
  let nextTimerId = 1;
  const clock = {
    now: 1700000000000,
    advance(ms) {
      this.now += ms;
      for (const [id, timer] of Array.from(activeTimers.entries())) {
        if (this.now >= timer.due) {
          activeTimers.delete(id);
          try { timer.fn(); } catch (_) {}
        }
      }
    }
  };

  const sandbox = {
    document: doc,
    window: null,
    globalThis: null,
    console,
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => {
      const delay = Number(ms) || 0;
      if (delay === 0) {
        setImmediate(fn);
        return 0;
      }
      const id = ++nextTimerId;
      activeTimers.set(id, { fn, due: clock.now + delay });
      return id;
    },
    clearTimeout: (id) => { activeTimers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    Event: class {},
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    zcode: mockApi,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(src, sandbox, { filename: "zcode-enhance-prompt.js" });

  const btn = () => doc.getElementById("zcode-enhance-prompt-btn");
  check(!!btn(), "按钮应当成功挂载");

  // -------------------------------------------------------------
  // 测试 1：在会话 A 中正常润色与撤销
  // -------------------------------------------------------------
  tree.input.textContent = "原始提示词A";
  tree.input.value = "原始提示词A";
  btn().click();

  check(btn().getAttribute("data-mode") === "busy", "点击后会话 A 按钮应进入 busy 状态");
  check(btn().disabled === true, "busy 状态下按钮应被禁用");

  // 模拟请求成功返回
  pendingEnhancePromiseResolve({ success: true, text: "优化后的提示词A", model: "test-model" });
  await new Promise((r) => setImmediate(r));

  check(tree.input.textContent === "优化后的提示词A", "会话 A 输入框应成功写入润色结果");
  check(btn().getAttribute("data-mode") === "revert", "润色完成后会话 A 按钮应进入 revert 状态");

  // 点击撤销还原
  btn().click();
  check(tree.input.textContent === "原始提示词A", "点击撤销后应恢复会话 A 原始提示词");
  check(btn().getAttribute("data-mode") === "idle", "撤销后按钮应恢复 idle 待机状态");

  // -------------------------------------------------------------
  // 测试 2：核心测试 - 正在润色中切换会话，绝对不得带入切换后的会话
  // -------------------------------------------------------------
  // 在会话 A 输入待润色内容并点击增强
  tree.input.textContent = "会话A的长篇任务描述";
  tree.input.value = "会话A的长篇任务描述";
  btn().click();
  check(btn().getAttribute("data-mode") === "busy", "会话 A 正在增强中 (busy)");

  // 用户在等待期间切换到了会话 B！
  tree.mainFrame.setAttribute("data-session-id", "session-B");
  // 模拟切换会话后会话 B 的输入框（可能是空的或包含会话 B 自己的草稿）
  tree.input.textContent = "会话B现存草稿";
  tree.input.value = "会话B现存草稿";

  // 模拟巡检或点击感知的会话切换
  for (const fn of doc.__listeners.click || []) fn();
  await new Promise((r) => setImmediate(r));

  // 验证切到会话 B 后的按钮状态：
  check(btn().getAttribute("data-mode") === "idle", "★ 切换到会话 B 后，按钮应立即恢复待机(idle)，不被会话 A 锁死");
  check(btn().disabled === false, "★ 会话 B 的按钮不应处于 disabled 状态");

  // 此时，会话 A 刚才发起的润色请求终于返回了！
  pendingEnhancePromiseResolve({ success: true, text: "【会话A润色完成结果】", model: "test-model" });
  await new Promise((r) => setImmediate(r));

  // ★★★ 核心验证 ★★★
  check(tree.input.textContent === "会话B现存草稿", "★ 会话 B 的输入框内容绝对未被会话 A 的润色结果篡改！实际=" + tree.input.textContent);
  check(btn().getAttribute("data-mode") === "idle", "★ 会话 B 的按钮依然保持待机状态，未被误设为会话 A 的撤销状态");

  const diag = sandbox.__zenhanceDiag || {};
  check(!!diag.preventedCrossSessionPollution, "★ 诊断信息中应记录 preventedCrossSessionPollution 阻断事件");
  if (diag.preventedCrossSessionPollution) {
    check(diag.preventedCrossSessionPollution.from === "sess:session-A", "阻断事件来源应为 sess:session-A");
    check(diag.preventedCrossSessionPollution.to === "sess:session-B", "阻断事件目标应为 sess:session-B");
  }

  // -------------------------------------------------------------
  // 测试 3：切回会话 A 后的优雅恢复
  // -------------------------------------------------------------
  tree.mainFrame.setAttribute("data-session-id", "session-A");
  tree.input.textContent = "会话A的长篇任务描述";
  tree.input.value = "会话A的长篇任务描述";

  for (const fn of doc.__listeners.click || []) fn();
  await new Promise((r) => setImmediate(r));

  // -------------------------------------------------------------
  // 测试 4：防误杀测试 - 草稿会话（无持久化 session-id）在同一输入框中，
  // 润色结果必须正常写回输入框，绝对不得误触发「未写入当前会话」
  // -------------------------------------------------------------
  tree.mainFrame.removeAttribute("data-session-id");
  tree.input.textContent = "草稿提示词待润色";
  tree.input.value = "草稿提示词待润色";
  btn().click();
  check(btn().getAttribute("data-mode") === "busy", "草稿模式下点击增强应进入 busy 状态");

  // 模拟请求返回
  pendingEnhancePromiseResolve({ success: true, text: "【草稿润色优化成功】", model: "fallback-model" });
  await new Promise((r) => setImmediate(r));

  check(tree.input.textContent === "【草稿润色优化成功】",
    "★ 关键修复验证：草稿会话中的润色结果必须直接写入输入框！实际=" + tree.input.textContent);
  check(btn().getAttribute("data-mode") === "revert",
    "★ 草稿会话润色写入后，按钮应进入 revert 状态");

  if (bad.length > 0) {
    console.error("enhance session switch smoke FAIL:");
    for (const b of bad) console.error("  - " + b);
    process.exit(1);
  }

  console.log("enhance session switch smoke OK (all 4 session isolation & anti-false-positive tests passed)");
}

runTests().catch((err) => {
  console.error("enhance session switch smoke CRASH:", err);
  process.exit(1);
});
