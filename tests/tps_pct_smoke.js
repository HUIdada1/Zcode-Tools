// TPS 双框状态栏格式化与结构冒烟测试。
//
// 为什么需要它：状态栏从「一整条胶囊」改成「左性能 / 右用量 两个可点击框」后，
// 真正容易悄悄回归的是三件肉眼很难发现的事：
//   ① 缓存命中率退回成浮点长尾（97.26% 而不是设计稿的 97%）；
//   ② 明细面板把 Token 写成 k/M 缩写（应为 20,684,917 这样的全量数字）；
//   ③ 两个框又合并回一条胶囊，或面板入口只剩一个。
// 这里锁住格式化的真实行为与渲染路径的关键字符串。
//
// 用法：node tests/tps_pct_smoke.js skills/zcode-pilot/scripts/zcode-tps.js
// 退出码 0 = 通过；1 = 有断言失败；2 = 用法/读取错误。
const fs = require("fs");

const target = process.argv[2];
if (!target) {
  console.error("用法：node tests/tps_pct_smoke.js <zcode-tps.js 的路径>");
  console.error("例如：node tests/tps_pct_smoke.js skills/zcode-pilot/scripts/zcode-tps.js");
  process.exit(2);
}
let src;
try {
  src = fs.readFileSync(target, "utf8");
} catch (err) {
  console.error("读不到被测脚本：" + target);
  console.error("  " + err.message);
  process.exit(2);
}

const failures = [];
const check = (ok, label, extra) => {
  if (ok) return;
  failures.push(label + (extra ? "  —— " + extra : ""));
};

// ---------- 从源码里抠出纯函数并真跑一遍 ----------
// 用花括号配对而不是正则：函数体后续若加分支/嵌套，正则抠法会静默截断。
function extractFn(name) {
  const head = "const " + name + " = ";
  const i = src.indexOf(head);
  if (i < 0) return null;
  const braceStart = src.indexOf("{", i + head.length);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let j = braceStart; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(i + head.length, j + 1).trim();
    }
  }
  return null;
}

function loadFn(name) {
  const fnSrc = extractFn(name);
  check(!!fnSrc, "源码里找不到 `const " + name + " = ...`（函数被改名或删除了？）");
  if (!fnSrc) return null;
  try {
    // eslint-disable-next-line no-eval
    return eval("(" + fnSrc + ")");
  } catch (err) {
    check(false, name + " 源码无法求值", err.message);
    return null;
  }
}

const fmtPctInt = loadFn("fmtPctInt");
const fmtFull = loadFn("fmtFull");
const fmtSpanCN = loadFn("fmtSpanCN");
const fmtLatCN = loadFn("fmtLatCN");

// ① 命中率：整数百分比，四舍五入（设计稿口径 97%，不是 97.26%）
if (typeof fmtPctInt === "function") {
  const cases = [
    [97.26, "97", "常规取整"],
    [97.5, "98", "四舍五入进位"],
    [96.4, "96", "舍去"],
    [99.6, "100", "进位到 100"],
    [0, "0", "零"],
    [100, "100", "满命中"],
    ["84.5", "85", "兼容字符串入参"],
  ];
  for (const [input, want, why] of cases) {
    const got = fmtPctInt(input);
    check(got === want, "fmtPctInt(" + input + ") 期望 " + want + " 实得 " + got, why);
    check(/^\d+$/.test(got), "fmtPctInt(" + input + ") 输出不是整数格式", got);
  }
  for (const bad of [NaN, Infinity, -Infinity, undefined, null]) {
    const got = fmtPctInt(bad);
    check(/^\d+$/.test(got), "fmtPctInt(" + String(bad) + ") 输出不可渲染", String(got));
  }
}

// ② Token 明细：全量数字 + 千分位（20,684,917 tok）
if (typeof fmtFull === "function") {
  const cases = [
    [20684917, "20,684,917"],
    [563443, "563,443"],
    [20026706, "20,026,706"],
    [94768, "94,768"],
    [1000, "1,000"],
    [999, "999"],
    [0, "0"],
  ];
  for (const [input, want] of cases) {
    const got = fmtFull(input);
    check(got === want, "fmtFull(" + input + ") 期望 " + want + " 实得 " + got);
  }
  check(fmtFull(-5) === "0", "fmtFull 负数应归零", fmtFull(-5));
}

// ③ 时长：中文时分秒（49分3秒 / 8分53秒），TTFT 十秒内保留一位小数（8.3秒）
if (typeof fmtSpanCN === "function") {
  const cases = [
    [2943000, "49分3秒"],
    [533000, "8分53秒"],
    [8300, "8秒"],
    [0, "0秒"],
  ];
  for (const [input, want] of cases) {
    const got = fmtSpanCN(input);
    check(got === want, "fmtSpanCN(" + input + ") 期望 " + want + " 实得 " + got);
  }
}
if (typeof fmtLatCN === "function") {
  const cases = [
    [8300, "8.3秒"],
    [8330, "8.3秒"],
    [65000, "1分5秒"],
    [0, "0秒"],
  ];
  for (const [input, want] of cases) {
    const got = fmtLatCN(input);
    check(got === want, "fmtLatCN(" + input + ") 期望 " + want + " 实得 " + got);
  }
}

// ---------- 渲染路径：两个框 + 两个面板入口 ----------
check(/makeChip\("stats"/.test(src), "缺少左框（性能）创建逻辑");
check(/makeChip\("tokens"/.test(src), "缺少右框（用量）创建逻辑");
check(/`\$\{agg\.rounds\}轮\$\{agg\.steps\}步`/.test(src), "左框没有渲染「N轮M步」");
check(/fmtTps\(tps\)\}tok\/s/.test(src), "左框没有渲染 tok/s");
check(/缓存命中 \$\{fmtPctInt\(hitPct\)\}%/.test(src), "右框没有渲染缓存命中率");
check(/fmtTok\(totalTok\)\} tok/.test(src), "右框没有渲染会话总 Token");
check(/popHeader\("lat", "会话统计"/.test(src), "左框点击面板标题不是「会话统计」");
check(/popHeader\("total", "Token 用量"/.test(src), "右框点击面板标题不是「Token 用量」");
for (const label of ["模型用时", "工具调用用时", "首 token 平均（TTFT）", "输出速度（TPS）",
                     "未缓存输入", "缓存读取", "输出"]) {
  check(src.includes('"' + label + '"'), "明细面板缺少字段：" + label);
}
check(/function togglePop/.test(src), "两个框没有共用点击开合逻辑");
check(/pointerdown/.test(src) && /Escape/.test(src), "面板缺少点击外部 / Esc 收起");

// 旧结构必须彻底退场，避免新旧样式叠加
check(!/ztps-pill/.test(src), "源码仍残留旧胶囊样式 .ztps-pill");
check(!/ztps-seg/.test(src), "源码仍残留旧分段结构 .ztps-seg");

// ---------- 汇报 ----------
if (failures.length) {
  console.error("FAIL " + failures.length + " 项：");
  failures.forEach((f, i) => console.error("  " + (i + 1) + ". " + f));
  process.exit(1);
}
console.log("OK 双框状态栏冒烟通过（格式化口径 + 两框/两面板结构）");
