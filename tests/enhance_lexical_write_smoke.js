// 润色功能「Lexical 富文本与多级写入/自检闭环」冒烟测试：
// 验证：
//   1. Lexical 官方受控状态通道 (parseEditorState + setEditorState) 可正常解析多行文本并落盘；
//   2. React Fiber 链路下的 editorApiRef.setText 可直接被探针发现并直调；
//   3. 模拟 ClipboardEvent('paste') 剪贴板事件可在富文本节点上生效；
//   4. 传统原生 textarea / input 双向受控读写依然 100% 保持兼容；
//   5. 假成功拦截：若底层静默失效，自检机制能识别并未通过，杜绝虚假提示。
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

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.attrs = Object.create(null);
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: "" };
    this.textContent = "";
    this.value = "";
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
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at >= 0) this.children.splice(at, 0, c); else this.children.push(c);
    c.parentElement = this;
    return c;
  }
  querySelector(sel) {
    const pool = [];
    function walk(n) {
      for (const ch of n.children) {
        if (matches(ch, sel)) pool.push(ch);
        walk(ch);
      }
    }
    walk(this);
    return pool[0] || null;
  }
  querySelectorAll(sel) {
    const pool = [];
    function walk(n) {
      for (const ch of n.children) {
        if (matches(ch, sel)) pool.push(ch);
        walk(ch);
      }
    }
    walk(this);
    return pool;
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  addEventListener(t, fn) {
    this.__listeners[t] = this.__listeners[t] || [];
    this.__listeners[t].push(fn);
  }
  dispatchEvent(evt) {
    const list = this.__listeners[evt.type] || [];
    for (const fn of list) fn(evt);
    return true;
  }
  focus() {}
  select() {}
  getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30 }; }
}

function makeEnv() {
  const doc = {
    head: new MockElement("head"),
    body: new MockElement("body"),
    documentElement: new MockElement("html"),
    getElementById(id) { return null; },
    createElement(t) { return new MockElement(t); },
    createElementNS(ns, t) { return new MockElement(t); },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    createRange() {
      return {
        selectNodeContents() {},
      };
    },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true; },
  };
  doc.body.__isBody = true;

  const win = {
    document: doc,
    window: null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    getSelection() {
      return {
        removeAllRanges() {},
        addRange() {},
      };
    },
    DataTransfer: class {
      constructor() { this.data = {}; }
      setData(k, v) { this.data[k] = v; }
      getData(k) { return this.data[k] || ""; }
    },
    ClipboardEvent: class {
      constructor(type, init) {
        this.type = type;
        this.clipboardData = init && init.clipboardData;
      }
    },
    InputEvent: class {
      constructor(type, init) {
        this.type = type;
        this.data = init && init.data;
      }
    },
    Event: class {
      constructor(type) { this.type = type; }
    },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    HTMLElement: MockElement,
    performance: { now: () => Date.now() },
    console: console,
  };
  win.window = win;
  return { doc, win };
}

async function runTests() {
  console.log("==> 开始执行 Lexical 富文本与多级写入自检冒烟测试...");

  // 测试 1：Lexical 原生 parseEditorState + setEditorState 写入
  {
    const { doc, win } = makeEnv();
    let currentParsedState = null;

    const mockLexicalEditor = {
      parseEditorState(jsonStr) {
        const obj = JSON.parse(jsonStr);
        return { __isEditorState: true, raw: obj };
      },
      setEditorState(parsed) {
        currentParsedState = parsed;
        const paras = (parsed.raw && parsed.raw.root && parsed.raw.root.children) || [];
        const lines = paras.map(p => (p.children || []).map(t => t.text).join(""));
        targetEl.textContent = lines.join("\n");
      },
      getEditorState() {
        return {
          read(fn) { fn(); },
        };
      },
      getRootElement() {
        return targetEl;
      },
      focus() {}
    };

    const targetEl = new MockElement("div");
    targetEl.setAttribute("data-lexical-editor", "true");
    targetEl.setAttribute("contenteditable", "true");
    targetEl.__lexicalEditor = mockLexicalEditor;
    doc.body.appendChild(targetEl);

    // 加载脚本
    const ctx = vm.createContext(win);
    vm.runInContext(src, ctx);

    // 触发 writeText
    // 通过 window.__zenhanceDiag 或全局环境
    const ok = win.document.body.querySelector("[data-lexical-editor='true']");
    if (!ok) throw new Error("测试 1 失败：未能通过选择器找到 Lexical 节点");

    // 模拟写入多行增强文本
    const testText = "这是增强后的第一行提示词\n这是增强后的第二行提示词";
    // 从 ctx 执行内部 writeText 测试
    const writeResult = vm.runInContext(`
      (function() {
        const el = document.querySelector("[data-lexical-editor='true']");
        return window.__zenhanceDiag.writeText(el, ${JSON.stringify(testText)});
      })()
    `, ctx);

    if (!writeResult) throw new Error("测试 1 失败：writeText 在 Lexical 环境下返回 false");
    const diag = vm.runInContext("window.__zenhanceDiag", ctx);
    if (diag.lastWriteMethod !== "lexical-parse-state") {
      throw new Error("测试 1 失败：预期 lastWriteMethod 为 lexical-parse-state，实际为 " + diag.lastWriteMethod);
    }
    if (!targetEl.textContent.includes("第二行提示词")) {
      throw new Error("测试 1 失败：DOM 内容未正确更新");
    }
    console.log("  [PASS] 测试 1：Lexical parseEditorState + setEditorState 受控写入成功");
  }

  // 测试 2：React Fiber 直调 editorApiRef.setText
  {
    const { doc, win } = makeEnv();
    const targetEl = new MockElement("div");
    targetEl.setAttribute("data-lexical-editor", "true");
    targetEl.setAttribute("contenteditable", "true");

    let setTextCalledWith = null;
    let apiText = "";

    const mockEditorApi = {
      setText(t) {
        setTextCalledWith = t;
        apiText = t;
        targetEl.textContent = t;
      },
      getText() {
        return apiText;
      },
      getMarkdown() {
        return apiText;
      },
      focus() {}
    };

    // 挂载 Fiber
    targetEl.__reactFiber$test = {
      memoizedProps: {
        editorApiRef: { current: mockEditorApi }
      },
      return: null
    };

    doc.body.appendChild(targetEl);

    const ctx = vm.createContext(win);
    vm.runInContext(src, ctx);

    const testText = "Fiber 直调增强提示词：优化背景设定与分步计划";
    const writeResult = vm.runInContext(`
      (function() {
        const el = document.querySelector("[data-lexical-editor='true']");
        return window.__zenhanceDiag.writeText(el, ${JSON.stringify(testText)});
      })()
    `, ctx);

    if (!writeResult) throw new Error("测试 2 失败：writeText 在 Fiber 暴露环境下返回 false");
    const diag = vm.runInContext("window.__zenhanceDiag", ctx);
    if (diag.lastWriteMethod !== "fiber-editor-api") {
      throw new Error("测试 2 失败：预期 lastWriteMethod 为 fiber-editor-api，实际为 " + diag.lastWriteMethod);
    }
    if (setTextCalledWith !== testText) {
      throw new Error("测试 2 失败：Fiber setText 接收到的入参不匹配");
    }
    console.log("  [PASS] 测试 2：React Fiber 直调 editorApiRef.setText 成功");
  }

  // 测试 3：合成 ClipboardEvent('paste') 降级链路
  {
    const { doc, win } = makeEnv();
    const targetEl = new MockElement("div");
    targetEl.setAttribute("contenteditable", "true");

    targetEl.addEventListener("paste", (e) => {
      const pasteText = e.clipboardData && e.clipboardData.getData("text/plain");
      if (pasteText) {
        targetEl.textContent = pasteText;
      }
    });

    doc.body.appendChild(targetEl);

    const ctx = vm.createContext(win);
    // 禁用 execCommand
    doc.execCommand = () => false;
    vm.runInContext(src, ctx);

    const testText = "剪贴板粘贴降级测试文本";
    const writeResult = vm.runInContext(`
      (function() {
        const el = document.querySelector("[contenteditable='true']");
        return window.__zenhanceDiag.writeText(el, ${JSON.stringify(testText)});
      })()
    `, ctx);

    if (!writeResult) throw new Error("测试 3 失败：writeText 剪贴板降级返回 false");
    const diag = vm.runInContext("window.__zenhanceDiag", ctx);
    if (diag.lastWriteMethod !== "clipboard-paste") {
      throw new Error("测试 3 失败：预期 lastWriteMethod 为 clipboard-paste，实际为 " + diag.lastWriteMethod);
    }
    if (targetEl.textContent !== testText) {
      throw new Error("测试 3 失败：targetEl 未接收到粘贴内容");
    }
    console.log("  [PASS] 测试 3：合成 ClipboardEvent('paste') 降级链路验证成功");
  }

  // 测试 4：传统 textarea 原生受控 Setter 兼容
  {
    const { doc, win } = makeEnv();
    const targetEl = new MockElement("textarea");
    targetEl.setAttribute("data-testid", "v4-composer-input");

    doc.body.appendChild(targetEl);

    const ctx = vm.createContext(win);
    doc.execCommand = () => false; // 禁用 execCommand 验证原生 setter
    vm.runInContext(src, ctx);

    const testText = "传统 Textarea 原生受控写入测试";
    const writeResult = vm.runInContext(`
      (function() {
        const el = document.querySelector("textarea");
        return window.__zenhanceDiag.writeText(el, ${JSON.stringify(testText)});
      })()
    `, ctx);

    if (!writeResult) throw new Error("测试 4 失败：传统 textarea 写入返回 false");
    if (targetEl.value !== testText && targetEl.textContent !== testText) {
      throw new Error("测试 4 失败：textarea 文本未更新");
    }
    console.log("  [PASS] 测试 4：传统 textarea 原生受控写入保持 100% 兼容");
  }

  // 测试 5：假成功拦截（底层修改无效时，绝不误报成功）
  {
    const { doc, win } = makeEnv();
    const targetEl = new MockElement("div");
    targetEl.setAttribute("contenteditable", "true");
    targetEl.textContent = "原始未修改文本";

    // 模拟恶意环境：execCommand 返回 true，但 DOM 丝毫未变且不更新
    doc.execCommand = () => true;

    doc.body.appendChild(targetEl);

    const ctx = vm.createContext(win);
    vm.runInContext(src, ctx);

    // 重写 textContent setter 模拟只读/被锁死
    Object.defineProperty(targetEl, "textContent", {
      get() { return "原始未修改文本"; },
      set(v) { /* 故意静默吞掉，不生效 */ }
    });

    const testText = "应当失败的写入文本";
    const writeResult = vm.runInContext(`
      (function() {
        const el = document.querySelector("[contenteditable='true']");
        return window.__zenhanceDiag.writeText(el, ${JSON.stringify(testText)});
      })()
    `, ctx);

    if (writeResult !== false) {
      throw new Error("测试 5 失败：当底层内容未更新时，writeText 依然返回了 true，假成功拦截失效！");
    }
    console.log("  [PASS] 测试 5：假成功拦截机制生效（未真正更新文本时严格返回 false）");
  }

  console.log("\nLexical 富文本多级写入冒烟测试全部通过！(5/5)");
}

runTests().catch((err) => {
  console.error("\nLexical 冒烟测试失败：", err);
  process.exit(1);
});
