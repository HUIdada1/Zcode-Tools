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

// ---------- 2026-11 视觉改造：绿色双框 / 毛玻璃明细 / 自动收起 ----------
check(/--ztps-green-strong/.test(src), "缺少双框统一的绿色令牌 --ztps-green-strong");
check(/\.ztps-chip-main\{color:var\(--ztps-green-strong\)/.test(src), "左/右主值没有统一绿色");
check(/\.ztps-chip-sub\{color:var\(--ztps-green-soft\)/.test(src), "左/右次级值没有统一绿色");
check(/fmtTok\(totalTok\)[\s\S]{0,160}\{ dot: true \}/.test(src),
  "右侧 Token 框没有和左侧一样的状态点");
// 2026-11-13 CDP 两轮实测定案：composer dock 是 position:sticky;bottom:0，挂在 overflow-y:auto
// 的 .v4-timeline 里。① transform 不参与布局高度 → 往上滚被裁 6px（“遮挡一半”）；② 留在时间线内
// 只调 margin → 永远被裁在时间线底边，距窗体底还隔父容器 pb-4+窗体共 23px（“太高/悬空”）。
// 正解：挂到 v4-timeline 之外作 flex 兄弟 + 负 margin-bottom 拉进父容器底部 padding 区（贴底）。
check(/v4-timeline/.test(src) && /marginBottom: \(-padB\)/.test(src),
  "宿主必须挂到滚动容器 v4-timeline 之外并用负 margin-bottom 贴底，否则永远悬空");
check(!/transform:\s*"translateY/.test(src),
  "宿主禁止用 transform 位移：sticky dock 下它会越过滚动容器底边被 overflow 裁掉");
check(/position: "relative", zIndex: "5"/.test(src),
  "宿主需压过同层节点，否则滚过的正文会透视遮挡胶囊");
check(/--ztps-canvas/.test(src) && /background-color:var\(--ztps-canvas\);/.test(src),
  "chip 需要不透明画布底色垫在绿色渐变下（防透视遮挡）");
check(/backdrop-filter:blur\(24px\)/.test(src), "明细面板缺少毛玻璃 backdrop-filter");
check(/POP_AUTO_CLOSE_MS/.test(src) && /armPopTimer/.test(src),
  "明细面板缺少无操作自动收起");
// 官方 turnHeader 时长缺失时的本地兜底：长轮次不能整屏「—」
check(/genMs/.test(src) && /toolWaitMs/.test(src),
  "缺少模型/工具用时的本地计时兜底（genMs / toolWaitMs）");
check(/modelApprox/.test(src) && /"≈"/.test(src),
  "估算口径必须在面板上用「≈」标注");
check(/visibilitychange/.test(src), "页面隐藏时明细面板应收起");
check(!/\[role='menu'\]\.w-48/.test(src) && !/width:20rem!important/.test(src),
  "模型弹窗加宽覆盖仍残留在 TPS 样式里");

// ---------- 汇报 ----------
if (failures.length) {
  console.error("FAIL " + failures.length + " 项：");
  failures.forEach((f, i) => console.error("  " + (i + 1) + ". " + f));
  process.exit(1);
}
console.log("OK 双框状态栏冒烟通过（格式化口径 + 两框/两面板结构）");
