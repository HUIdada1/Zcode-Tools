// 专项测试：大模型响应体多层包装解包与各种返回格式的鲁棒性提取
const assert = require("assert");

function extract(b) {
  let root = null;
  try {
    root = JSON.parse(b);
  } catch (sseErr) {
    if (typeof b === "string" && (b.indexOf("data:") !== -1 || b.indexOf("data: ") !== -1)) {
      let sse = "";
      for (let line of b.split(String.fromCharCode(10))) {
        let tr = line.trim();
        if (tr.indexOf("data:") === 0 && tr.indexOf("[DONE]") === -1) {
          try {
            let c = JSON.parse(tr.slice(5).trim());
            let del = (c && c.choices && c.choices[0] && (c.choices[0].delta || c.choices[0].message) && (c.choices[0].delta || c.choices[0].message).content) || "";
            if (typeof del === "string") sse += del;
          } catch (_) {}
        }
      }
      if (sse.trim()) root = { choices: [{ message: { content: sse.trim() } }] };
    }
    if (!root) throw sseErr;
  }
  for (let d = 0; d < 3; d++) {
    if (root && typeof root === "object" && !Array.isArray(root)) {
      if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) root = root.data;
      else if (root.result && typeof root.result === "object" && !Array.isArray(root.result)) root = root.result;
      else if (root.response && typeof root.response === "object" && !Array.isArray(root.response)) root = root.response;
      else break;
    }
  }
  let out = "";
  if (root && Array.isArray(root.choices) && root.choices[0]) {
    let c0 = root.choices[0], m0 = c0.message || c0.delta || {};
    if (typeof m0.content === "string" && m0.content.trim()) out = m0.content;
    else if (Array.isArray(m0.content)) out = m0.content.map(c => typeof c === "string" ? c : ((c && typeof c.text === "string") ? c.text : "")).join("");
    if (!out && typeof c0.text === "string" && c0.text.trim()) out = c0.text;
    if (!out) {
      let think = m0.reasoning_content || m0.reasoning || m0.thought || m0.thinking || m0.reasoningText;
      if (typeof think === "string" && think.trim()) out = think.trim();
    }
  }
  if (!out && root && Array.isArray(root.content)) {
    let tb = [], thb = [];
    for (let item of root.content) {
      if (!item) continue;
      if (typeof item === "string") tb.push(item);
      else if (item.type === "text" && typeof item.text === "string") tb.push(item.text);
      else if (typeof item.text === "string" && !item.type) tb.push(item.text);
      else if (item.type === "thinking" || item.thinking) thb.push(String(item.thinking || ""));
    }
    out = tb.length ? tb.join("") : thb.join("");
  }
  if (!out && root) {
    if (typeof root.output_text === "string") out = root.output_text;
    else if (root.output && typeof root.output.text === "string") out = root.output.text;
    else if (Array.isArray(root.generations) && root.generations[0] && typeof root.generations[0].text === "string") out = root.generations[0].text;
    else if (typeof root.reply === "string") out = root.reply;
  }
  out = String(out || "").trim();
  if (out.indexOf("```") === 0) {
    let idx = out.indexOf(String.fromCharCode(10));
    if (idx > 0) {
      let last = out.lastIndexOf("```");
      if (last > idx) out = out.slice(idx + 1, last).trim();
    }
  }
  return out;
}

// 1. 测试 cline-pass 返回格式：{"data": {"choices": [...]}, "success": true}
{
  const resp = JSON.stringify({
    success: true,
    data: {
      choices: [{
        finish_reason: "stop",
        index: 0,
        message: { content: "这是来自 cline-pass 的润色结果" }
      }]
    }
  });
  const res = extract(resp);
  assert.strictEqual(res, "这是来自 cline-pass 的润色结果");
  console.log("[PASS] 1. cline-pass data 顶层解包测试通过");
}

// 2. 测试 result 顶层解包格式
{
  const resp = JSON.stringify({
    result: {
      choices: [{
        message: { content: "这是来自 result 解包的内容" }
      }]
    }
  });
  assert.strictEqual(extract(resp), "这是来自 result 解包的内容");
  console.log("[PASS] 2. result 顶层解包测试通过");
}

// 3. 测试 delta 流式字段返回
{
  const resp = JSON.stringify({
    choices: [{
      delta: { content: "这是来自 delta 的内容" }
    }]
  });
  assert.strictEqual(extract(resp), "这是来自 delta 的内容");
  console.log("[PASS] 3. delta 流式字段测试通过");
}

// 4. 测试 思考推理（Reasoning）兜底
{
  const resp = JSON.stringify({
    choices: [{
      message: {
        content: "",
        reasoning_content: "这是思考内容作为兜底"
      }
    }]
  });
  assert.strictEqual(extract(resp), "这是思考内容作为兜底");
  console.log("[PASS] 4. reasoning_content 兜底测试通过");
}

// 5. 测试 Anthropic thinking + text 混合 blocks
{
  const resp = JSON.stringify({
    content: [
      { type: "thinking", signature: "sig", thinking: "先思考一下..." },
      { type: "text", text: "最终正文文本" }
    ]
  });
  assert.strictEqual(extract(resp), "最终正文文本");
  console.log("[PASS] 5. Anthropic 思考+文本过滤测试通过（无 [object Object] 污染）");
}

// 6. 测试 自动剥离 ```markdown 代码块
{
  const resp = JSON.stringify({
    choices: [{
      message: {
        content: "```markdown\n这是被代码块包裹的正文\n```"
      }
    }]
  });
  assert.strictEqual(extract(resp), "这是被代码块包裹的正文");
  console.log("[PASS] 6. Markdown 代码块剥离测试通过");
}

// 7. 测试 SSE 流式格式容错
{
  const sseResp = [
    'data: {"choices":[{"delta":{"content":"分片1"}}]}',
    'data: {"choices":[{"delta":{"content":"分片2"}}]}',
    'data: [DONE]'
  ].join("\n");
  assert.strictEqual(extract(sseResp), "分片1分片2");
  console.log("[PASS] 7. SSE 流式格式容错测试通过");
}

console.log("\n全部响应体解包与提取专项测试通过！(7/7)");
