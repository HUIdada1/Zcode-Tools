// 模型拉取按钮 / 选择弹窗的视觉回归（静态源码契约）。
//
// 为什么需要：这两个 UI 是纯 CSS + innerHTML 注入，`node --check` 只能证明 JS 能解析，
// 抓不到「样式块少一个花括号整段失效」「按钮又退回旧蓝色」「弹窗又变成实心白底」。
// 这里锁定毛玻璃令牌、结构类名与图标包裹层，防止后续改动把视觉改回旧版。
//
// 用法：node tests/puller_glass_smoke.js skills/zcode-pilot/scripts/zcode-model-puller.js
const fs = require("fs");

const target = process.argv[2];
if (!target) {
  console.error("用法：node tests/puller_glass_smoke.js <zcode-model-puller.js 的路径>");
  process.exit(2);
}
let src;
try {
  src = fs.readFileSync(target, "utf8");
} catch (err) {
  console.error("读不到被测脚本：" + target + "\n  " + err.message);
  process.exit(2);
}

const bad = [];
const check = (cond, msg) => { if (!cond) bad.push(msg); };

const start = src.indexOf("glass.textContent = `");
const end = src.indexOf("`;\n  document.head.appendChild(glass);", start);
check(start >= 0 && end > start, "找不到毛玻璃样式块 glass.textContent");
const css = start >= 0 && end > start ? src.slice(start, end) : "";

check((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length,
  "毛玻璃样式花括号不平衡（整段 CSS 会失效）");
check(css.includes("backdrop-filter:blur(28px)"), "弹窗缺少 backdrop-filter 毛玻璃");
check(css.includes("--zpg-accent:#10b981") || css.includes("--zpg-accent:#34d399"),
  "缺少 emerald 视觉令牌");
check(css.includes(".zcp-pull-icon-wrap"), "按钮缺少内嵌圆形图标包裹层");
check(css.includes(".zcp-pull-heading-main"), "弹窗标题缺少主/副标题结构");
check(css.includes("@media (prefers-color-scheme:dark)"), "缺少系统暗色兜底");
check(!/#2563eb|#3b82f6/.test(css), "毛玻璃覆盖层里仍残留旧蓝色");

check(/class="zcp-pull-icon-wrap"/.test(src), "按钮 innerHTML 没有使用圆形图标包裹层");
check((src.match(/class="zcp-pull-icon-wrap"/g) || []).length >= 3,
  "按钮初始 / loading / finally 三处 innerHTML 都应使用同一图标包裹层");
check(src.includes("自动拉取模型"), "按钮文案丢失");
check(src.includes("zcp-pull-heading-main"), "弹窗标题主文案容器丢失");
check(src.includes("选择要同步的模型"), "弹窗标题丢失");

if (bad.length) {
  console.error("puller glass smoke FAILED（" + bad.length + " 项）：");
  for (const m of bad) console.error("  ✗ " + m);
  process.exit(1);
}
console.log("puller glass smoke OK");
