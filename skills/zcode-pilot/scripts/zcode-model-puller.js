/**
 * MIT License — Copyright (c) HHQ-666（完整许可声明见仓库根目录 NOTICE.md）
 * 由 zcp_patcher.py --model-puller 注入到 out/renderer/；配套的 preload 桥与 main IPC handler
 * 在 patcher 内置（锚点：exposeInMainWorld("zcode",{ / SaveMcpToUserDirectory）。
 */
/**
 * ZCode 自定义模型供应商 - 自动拉取模型列表插件 (开源旗舰版)
 * 1. 极致现代视觉：精致高级渐变质感按钮（自适应深浅主题、悬停微光与物理动效）
 * 2. 100% 精准识别：config 已有模型标注「已添加」并不勾选，新模型标注「新模型」并默认勾选（以 config.json 为唯一事实源）
 * 2.1 确认写入：勾选的模型一律（重）写条目，不因 config 已存在而跳过——修复「界面删除后
 *     弹窗仍标已添加、再次添加却写不进列表」的幽灵状态；同 baseURL 的多个供应商条目全部同步
 * 3. 完美交互：滚动位置丝毫不动，搜索就地过滤
 * 4. 自动原生刷新：保存后自动触发官方刷新与组件重新装载，新模型卡片秒级呈现
 * 5. 跨进程安全 IPC 桥梁：原生无 CORS 限制、极速安全持久化
 */
(() => {
  if (window.__ZCP_PULLER_LOADED__) return;
  window.__ZCP_PULLER_LOADED__ = true;

  console.log("[ZCode-Model-Puller] 开源旗舰版插件已装载");

  // 样式系统
  const style = document.createElement("style");
  style.id = "zcode-model-puller-style-pro";
  style.textContent = `
    :root {
      --zpull-bg: #ffffff;
      --zpull-fg: #18181b;
      --zpull-fg-muted: #71717a;
      --zpull-border: #e4e4e7;
      --zpull-border-subtle: #f4f4f5;
      --zpull-input-bg: #ffffff;
      --zpull-input-border: #d4d4d8;
      --zpull-list-bg: #fcfcfd;
      --zpull-item-hover: #f4f4f5;
      --zpull-header-bg: #fafafa;
      --zpull-footer-bg: #fafafa;
      --zpull-shadow: 0 20px 40px rgba(0, 0, 0, 0.12);
      --zpull-btn-cancel-bg: #f4f4f5;
      --zpull-btn-cancel-border: #e4e4e7;
      --zpull-btn-cancel-fg: #27272a;
      --zpull-btn-cancel-hover: #e4e4e7;
      --zpull-badge-exists-bg: #f4f4f5;
      --zpull-badge-exists-fg: #71717a;
      --zpull-badge-exists-border: #e4e4e7;
      --zpull-badge-new-bg: #ecfdf5;
      --zpull-badge-new-fg: #059669;
      --zpull-badge-new-border: #a7f3d0;

      /* 浅色模式按钮高级质感 */
      --zpull-trigger-bg: linear-gradient(135deg, #f0f7ff 0%, #e0effe 100%);
      --zpull-trigger-fg: #1d4ed8;
      --zpull-trigger-border: rgba(59, 130, 246, 0.32);
      --zpull-trigger-hover-bg: linear-gradient(135deg, #e0effe 0%, #bae6fd 100%);
      --zpull-trigger-hover-shadow: 0 4px 12px rgba(37, 99, 235, 0.18);
    }

    .dark, html.dark, body.dark {
      --zpull-bg: #1c1c1e;
      --zpull-fg: #f0f0f0;
      --zpull-fg-muted: #a1a1aa;
      --zpull-border: rgba(255, 255, 255, 0.14);
      --zpull-border-subtle: rgba(255, 255, 255, 0.06);
      --zpull-input-bg: #141416;
      --zpull-input-border: rgba(255, 255, 255, 0.15);
      --zpull-list-bg: #151517;
      --zpull-item-hover: rgba(255, 255, 255, 0.05);
      --zpull-header-bg: #19191b;
      --zpull-footer-bg: #19191b;
      --zpull-shadow: 0 24px 48px rgba(0, 0, 0, 0.6);
      --zpull-btn-cancel-bg: rgba(255, 255, 255, 0.08);
      --zpull-btn-cancel-border: rgba(255, 255, 255, 0.1);
      --zpull-btn-cancel-fg: #eee;
      --zpull-btn-cancel-hover: rgba(255, 255, 255, 0.14);
      --zpull-badge-exists-bg: rgba(107, 114, 128, 0.2);
      --zpull-badge-exists-fg: #9ca3af;
      --zpull-badge-exists-border: rgba(107, 114, 128, 0.25);
      --zpull-badge-new-bg: rgba(16, 185, 129, 0.15);
      --zpull-badge-new-fg: #10b981;
      --zpull-badge-new-border: rgba(16, 185, 129, 0.3);

      /* 暗黑模式按钮高级质感 */
      --zpull-trigger-bg: linear-gradient(135deg, rgba(37, 99, 235, 0.2) 0%, rgba(30, 58, 138, 0.28) 100%);
      --zpull-trigger-fg: #60a5fa;
      --zpull-trigger-border: rgba(96, 165, 250, 0.38);
      --zpull-trigger-hover-bg: linear-gradient(135deg, rgba(37, 99, 235, 0.3) 0%, rgba(30, 58, 138, 0.42) 100%);
      --zpull-trigger-hover-shadow: 0 4px 16px rgba(59, 130, 246, 0.3);
    }

    /* 现代高级感触发按钮样式 */
    #zcode-auto-pull-models-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-left: 8px;
      margin-top: 4px;
      height: 36px;
      padding: 0 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      background: var(--zpull-trigger-bg);
      color: var(--zpull-trigger-fg);
      border: 1px solid var(--zpull-trigger-border);
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
    }
    #zcode-auto-pull-models-btn:hover {
      background: var(--zpull-trigger-hover-bg);
      box-shadow: var(--zpull-trigger-hover-shadow);
      transform: translateY(-1px);
    }
    #zcode-auto-pull-models-btn:active {
      transform: translateY(0);
    }
    #zcode-auto-pull-models-btn.loading {
      opacity: 0.75;
      cursor: wait;
      pointer-events: none;
    }
    .zcp-pull-bolt-icon {
      width: 15px;
      height: 15px;
      fill: currentColor;
      transition: transform 0.2s;
    }
    #zcode-auto-pull-models-btn:hover .zcp-pull-bolt-icon {
      transform: scale(1.15);
    }

    @keyframes zcodeSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .zcode-spin-icon {
      animation: zcodeSpin 1s linear infinite;
    }

    /* 弹窗遮罩 */
    .zcp-pull-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(5px);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: zcodeFadeIn 0.15s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    @keyframes zcodeFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .zcp-pull-modal {
      width: 580px;
      max-width: 92vw;
      max-height: 85vh;
      background: var(--zpull-bg);
      color: var(--zpull-fg);
      border: 1px solid var(--zpull-border);
      border-radius: 14px;
      box-shadow: var(--zpull-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: zcodeScaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes zcodeScaleIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
    .zcp-pull-header {
      padding: 16px 20px;
      background: var(--zpull-header-bg);
      border-bottom: 1px solid var(--zpull-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .zcp-pull-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--zpull-fg);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .zcp-pull-close {
      background: transparent;
      border: none;
      color: var(--zpull-fg-muted);
      cursor: pointer;
      font-size: 18px;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .zcp-pull-close:hover {
      background: var(--zpull-item-hover);
      color: var(--zpull-fg);
    }
    .zcp-pull-body {
      padding: 16px 20px;
      overflow-y: hidden;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .zcp-pull-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .zcp-pull-search {
      flex: 1;
      background: var(--zpull-input-bg);
      border: 1px solid var(--zpull-input-border);
      border-radius: 8px;
      padding: 7px 12px;
      color: var(--zpull-fg);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    .zcp-pull-search:focus {
      border-color: #3b82f6;
    }
    .zcp-pull-btn-group {
      display: flex;
      gap: 6px;
    }
    .zcp-pull-mini-btn {
      background: var(--zpull-btn-cancel-bg);
      border: 1px solid var(--zpull-btn-cancel-border);
      color: var(--zpull-fg);
      font-size: 12px;
      padding: 5px 10px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .zcp-pull-mini-btn:hover {
      background: var(--zpull-btn-cancel-hover);
    }
    .zcp-pull-list {
      flex: 1;
      max-height: 380px;
      overflow-y: auto;
      border: 1px solid var(--zpull-border);
      border-radius: 8px;
      background: var(--zpull-list-bg);
    }
    .zcp-pull-item {
      display: flex;
      align-items: center;
      padding: 9px 12px;
      cursor: pointer;
      user-select: none;
      transition: background 0.1s;
      border-bottom: 1px solid var(--zpull-border-subtle);
    }
    .zcp-pull-item:last-child {
      border-bottom: none;
    }
    .zcp-pull-item:hover {
      background: var(--zpull-item-hover);
    }
    .zcp-pull-item input[type="checkbox"] {
      margin-right: 12px;
      accent-color: #2563eb;
      width: 16px;
      height: 16px;
      cursor: pointer;
      pointer-events: none;
    }
    .zcp-pull-item-name {
      flex: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: var(--zpull-fg);
    }
    .zcp-pull-badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 500;
    }
    .zcp-pull-badge-new {
      background: var(--zpull-badge-new-bg);
      color: var(--zpull-badge-new-fg);
      border: 1px solid var(--zpull-badge-new-border);
    }
    .zcp-pull-badge-exists {
      background: var(--zpull-badge-exists-bg);
      color: var(--zpull-badge-exists-fg);
      border: 1px solid var(--zpull-badge-exists-border);
    }
    .zcp-pull-footer {
      padding: 14px 20px;
      background: var(--zpull-footer-bg);
      border-top: 1px solid var(--zpull-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .zcp-pull-count-info {
      font-size: 13px;
      color: var(--zpull-fg-muted);
    }
    .zcp-pull-footer-btns {
      display: flex;
      gap: 10px;
    }
    .zcp-pull-btn-cancel {
      padding: 7px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      background: var(--zpull-btn-cancel-bg);
      border: 1px solid var(--zpull-btn-cancel-border);
      color: var(--zpull-btn-cancel-fg);
      cursor: pointer;
      transition: all 0.15s;
    }
    .zcp-pull-btn-cancel:hover {
      background: var(--zpull-btn-cancel-hover);
    }
    .zcp-pull-btn-submit {
      padding: 7px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      background: #2563eb;
      border: 1px solid rgba(59, 130, 246, 0.5);
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
    }
    .zcp-pull-btn-submit:hover {
      background: #1d4ed8;
    }
    .zcp-pull-btn-submit:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .zcode-custom-toast {
      position: fixed;
      top: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000000;
      background: var(--zpull-bg);
      color: var(--zpull-fg);
      padding: 10px 20px;
      border-radius: 10px;
      border: 1px solid var(--zpull-border);
      box-shadow: var(--zpull-shadow);
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: zcodeToastPop 0.25s ease-out;
    }
    @keyframes zcodeToastPop {
      from { opacity: 0; transform: translate(-50%, -10px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
  `;
  document.head.appendChild(style);

  // ============ 视觉覆盖层：毛玻璃 / 绿色科技感 / 高级质感 ============
  // 追加在旧样式之后，用同选择器覆盖颜色、圆角、阴影与动效；结构类名保持不变，
  // 避免影响拉取/搜索/勾选/保存逻辑。
  const glass = document.createElement("style");
  glass.id = "zcode-model-puller-glass-v1";
  glass.textContent = `
    :root{
      --zpg-ink:#0f172a;--zpg-muted:#64748b;--zpg-soft:#94a3b8;
      --zpg-accent:#10b981;--zpg-accent-2:#059669;--zpg-accent-ink:#065f46;
      --zpg-surface:rgba(16,185,129,.10);--zpg-surface-2:rgba(16,185,129,.16);
      --zpg-line:rgba(16,185,129,.16);--zpg-line-2:rgba(16,185,129,.26);
      --zpg-glass:linear-gradient(155deg,rgba(255,255,255,.94) 0%,rgba(236,253,245,.88) 55%,rgba(255,255,255,.92) 100%);
      --zpg-glass-soft:linear-gradient(180deg,rgba(255,255,255,.78),rgba(240,253,247,.66));
      --zpg-shadow:0 28px 70px rgba(15,23,42,.20),0 6px 18px rgba(15,23,42,.08),inset 0 1px 0 rgba(255,255,255,.85);
      --zpg-focus:0 0 0 3px rgba(16,185,129,.18);
      --zpg-mono:ui-monospace,SFMono-Regular,Consolas,monospace;
      --zpg-sans:-apple-system,BlinkMacSystemFont,"Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      --zpg-ease:cubic-bezier(.22,1,.36,1);
    }
    .dark,html.dark,body.dark{
      --zpg-ink:#ecfdf5;--zpg-muted:rgba(236,253,245,.62);--zpg-soft:rgba(236,253,245,.42);
      --zpg-accent:#34d399;--zpg-accent-2:#10b981;--zpg-accent-ink:#d1fae5;
      --zpg-surface:rgba(52,211,153,.10);--zpg-surface-2:rgba(52,211,153,.16);
      --zpg-line:rgba(52,211,153,.14);--zpg-line-2:rgba(52,211,153,.24);
      --zpg-glass:linear-gradient(155deg,rgba(20,30,26,.94) 0%,rgba(8,16,13,.96) 55%,rgba(12,22,18,.94) 100%);
      --zpg-glass-soft:linear-gradient(180deg,rgba(18,28,24,.72),rgba(8,16,13,.62));
      --zpg-shadow:0 32px 80px rgba(0,0,0,.66),0 6px 18px rgba(0,0,0,.40),inset 0 1px 0 rgba(255,255,255,.10);
      --zpg-focus:0 0 0 3px rgba(52,211,153,.20);
    }
    @media (prefers-color-scheme:dark){
      :root:not(.light):not([data-theme='light']){
        --zpg-ink:#ecfdf5;--zpg-muted:rgba(236,253,245,.62);--zpg-soft:rgba(236,253,245,.42);
        --zpg-accent:#34d399;--zpg-accent-2:#10b981;--zpg-accent-ink:#d1fae5;
        --zpg-surface:rgba(52,211,153,.10);--zpg-surface-2:rgba(52,211,153,.16);
        --zpg-line:rgba(52,211,153,.14);--zpg-line-2:rgba(52,211,153,.24);
        --zpg-glass:linear-gradient(155deg,rgba(20,30,26,.94) 0%,rgba(8,16,13,.96) 55%,rgba(12,22,18,.94) 100%);
        --zpg-glass-soft:linear-gradient(180deg,rgba(18,28,24,.72),rgba(8,16,13,.62));
        --zpg-shadow:0 32px 80px rgba(0,0,0,.66),0 6px 18px rgba(0,0,0,.40),inset 0 1px 0 rgba(255,255,255,.10);
        --zpg-focus:0 0 0 3px rgba(52,211,153,.20);
      }
    }

    /* ---------- 触发按钮：玻璃胶囊 + 内外双层质感 ---------- */
    #zcode-auto-pull-models-btn{
      display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 13px 0 6px;
      margin-left:8px;margin-top:4px;border-radius:999px;
      border:1px solid var(--zpg-line-2);
      background:linear-gradient(180deg,var(--zpg-surface-2),var(--zpg-surface));
      color:var(--zpg-accent-ink);
      font-family:var(--zpg-sans);font-size:12.5px;font-weight:650;letter-spacing:.01em;line-height:1;
      cursor:pointer;user-select:none;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.32),0 2px 10px rgba(16,185,129,.10);
      transition:transform .22s var(--zpg-ease),box-shadow .22s var(--zpg-ease),background .22s var(--zpg-ease),color .22s var(--zpg-ease);
    }
    #zcode-auto-pull-models-btn:hover{
      transform:translateY(-1px);
      background:linear-gradient(180deg,rgba(16,185,129,.24),rgba(16,185,129,.14));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.40),0 8px 22px rgba(16,185,129,.20);
    }
    #zcode-auto-pull-models-btn:active{transform:translateY(0) scale(.99)}
    #zcode-auto-pull-models-btn:focus-visible{outline:none;box-shadow:var(--zpg-focus),inset 0 1px 0 rgba(255,255,255,.35)}
    #zcode-auto-pull-models-btn.loading{opacity:.72;cursor:wait;pointer-events:none}
    .zcp-pull-icon-wrap{
      width:22px;height:22px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;
      background:rgba(16,185,129,.18);box-shadow:inset 0 0 0 1px rgba(16,185,129,.28);
      transition:transform .22s var(--zpg-ease),background .22s var(--zpg-ease);
    }
    #zcode-auto-pull-models-btn:hover .zcp-pull-icon-wrap{transform:scale(1.06);background:rgba(16,185,129,.24)}
    .zcp-pull-bolt-icon{width:13px;height:13px;fill:currentColor}
    @keyframes zcodeSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
    .zcode-spin-icon{animation:zcodeSpin .9s linear infinite}

    /* ---------- 遮罩：深色玻璃，聚焦弹窗 ---------- */
    .zcp-pull-modal-overlay{
      position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;
      background:rgba(3,8,6,.52);
      -webkit-backdrop-filter:blur(18px) saturate(145%);backdrop-filter:blur(18px) saturate(145%);
      animation:zcodeFadeIn .22s var(--zpg-ease);
      font-family:var(--zpg-sans);
    }
    @keyframes zcodeFadeIn{from{opacity:0}to{opacity:1}}

    /* ---------- 弹窗：双框玻璃 + 环境绿光 ---------- */
    .zcp-pull-modal{
      position:relative;width:600px;max-width:92vw;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;
      border-radius:20px;border:1px solid var(--zpg-line-2);
      background:var(--zpg-glass);color:var(--zpg-ink);
      box-shadow:var(--zpg-shadow);
      -webkit-backdrop-filter:blur(28px) saturate(165%);backdrop-filter:blur(28px) saturate(165%);
      animation:zcodeScaleIn .26s var(--zpg-ease);
    }
    .zcp-pull-modal::before{
      content:"";position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(120% 80% at 0% 0%,rgba(16,185,129,.16),transparent 56%);
    }
    @keyframes zcodeScaleIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
    .zcp-pull-header{
      position:relative;z-index:1;padding:18px 20px 14px;display:flex;align-items:center;justify-content:space-between;gap:14px;
      border-bottom:1px solid var(--zpg-line);background:transparent;
    }
    .zcp-pull-title{display:flex;align-items:center;gap:11px;min-width:0;color:var(--zpg-ink);font-size:15px;font-weight:650;letter-spacing:.01em}
    .zcp-pull-title .zcp-pull-icon-wrap{width:30px;height:30px;flex:0 0 auto;background:rgba(16,185,129,.16);box-shadow:inset 0 0 0 1px rgba(16,185,129,.26)}
    .zcp-pull-title .zcp-pull-bolt-icon{width:16px;height:16px}
    .zcp-pull-heading{display:flex;flex-direction:column;gap:3px;min-width:0}
    .zcp-pull-heading-main{font-size:15px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .zcp-pull-sub{font-size:11px;font-weight:500;color:var(--zpg-muted);letter-spacing:.02em}
    .zcp-pull-close{
      flex:0 0 auto;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;
      background:rgba(127,127,127,.08);border:1px solid transparent;border-radius:999px;
      color:var(--zpg-muted);font-size:15px;line-height:1;cursor:pointer;
      transition:background .2s var(--zpg-ease),color .2s var(--zpg-ease),transform .2s var(--zpg-ease),box-shadow .2s var(--zpg-ease);
    }
    .zcp-pull-close:hover{background:var(--zpg-surface);color:var(--zpg-accent-ink);box-shadow:inset 0 0 0 1px var(--zpg-line-2);transform:rotate(90deg)}
    .zcp-pull-body{position:relative;z-index:1;padding:16px 20px;overflow:hidden;flex:1;display:flex;flex-direction:column;gap:12px}
    .zcp-pull-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .zcp-pull-search{
      flex:1;min-width:0;box-sizing:border-box;background:var(--zpg-glass-soft);border:1px solid var(--zpg-line);border-radius:12px;
      padding:9px 13px;color:var(--zpg-ink);font-family:var(--zpg-sans);font-size:13px;outline:none;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.28);
      transition:border-color .2s var(--zpg-ease),box-shadow .2s var(--zpg-ease),background .2s var(--zpg-ease);
    }
    .zcp-pull-search::placeholder{color:var(--zpg-soft)}
    .zcp-pull-search:focus{border-color:var(--zpg-accent);box-shadow:var(--zpg-focus),inset 0 1px 0 rgba(255,255,255,.32)}
    .zcp-pull-btn-group{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    .zcp-pull-mini-btn{
      background:rgba(127,127,127,.08);border:1px solid var(--zpg-line);border-radius:999px;
      color:var(--zpg-ink);font-family:var(--zpg-sans);font-size:11.5px;font-weight:550;padding:6px 11px;
      cursor:pointer;white-space:nowrap;
      transition:background .2s var(--zpg-ease),color .2s var(--zpg-ease),transform .2s var(--zpg-ease),box-shadow .2s var(--zpg-ease);
    }
    .zcp-pull-mini-btn:hover{background:var(--zpg-surface);color:var(--zpg-accent-ink);box-shadow:inset 0 0 0 1px var(--zpg-line-2)}
    .zcp-pull-mini-btn:active{transform:scale(.98)}
    .zcp-pull-list{
      flex:1;max-height:380px;overflow-y:auto;overscroll-behavior:contain;
      border:1px solid var(--zpg-line);border-radius:14px;background:var(--zpg-glass-soft);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.22);
    }
    .zcp-pull-list::-webkit-scrollbar{width:8px}
    .zcp-pull-list::-webkit-scrollbar-thumb{background:rgba(16,185,129,.26);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
    .zcp-pull-list::-webkit-scrollbar-track{background:transparent}
    .zcp-pull-item{
      display:flex;align-items:center;padding:10px 13px;cursor:pointer;user-select:none;
      border-bottom:1px solid var(--zpg-line);
      transition:background .18s var(--zpg-ease),transform .18s var(--zpg-ease);
    }
    .zcp-pull-item:last-child{border-bottom:none}
    .zcp-pull-item:hover{background:var(--zpg-surface);transform:translateX(1px)}
    .zcp-pull-item input[type="checkbox"]{margin-right:12px;accent-color:var(--zpg-accent);width:16px;height:16px;cursor:pointer;pointer-events:none}
    .zcp-pull-item-name{flex:1;min-width:0;font-family:var(--zpg-mono);font-size:12.5px;color:var(--zpg-ink);letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .zcp-pull-badge{font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:999px;letter-spacing:.02em;white-space:nowrap}
    .zcp-pull-badge-new{background:rgba(16,185,129,.14);color:var(--zpg-accent-ink);box-shadow:inset 0 0 0 1px var(--zpg-line-2)}
    .zcp-pull-badge-exists{background:rgba(127,127,127,.10);color:var(--zpg-muted);box-shadow:inset 0 0 0 1px rgba(127,127,127,.14)}
    .zcp-pull-footer{
      position:relative;z-index:1;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;
      border-top:1px solid var(--zpg-line);background:transparent;
    }
    .zcp-pull-count-info{font-size:12px;color:var(--zpg-muted);letter-spacing:.01em}
    .zcp-pull-count-info strong{color:var(--zpg-accent-ink);font-weight:650}
    .zcp-pull-footer-btns{display:flex;gap:9px}
    .zcp-pull-btn-cancel{
      padding:8px 17px;border-radius:999px;font-family:var(--zpg-sans);font-size:12.5px;font-weight:600;
      background:rgba(127,127,127,.08);border:1px solid var(--zpg-line);color:var(--zpg-ink);cursor:pointer;
      transition:background .2s var(--zpg-ease),color .2s var(--zpg-ease),transform .2s var(--zpg-ease);
    }
    .zcp-pull-btn-cancel:hover{background:var(--zpg-surface);color:var(--zpg-accent-ink);transform:translateY(-1px)}
    .zcp-pull-btn-submit{
      padding:8px 18px;border-radius:999px;font-family:var(--zpg-sans);font-size:12.5px;font-weight:650;
      display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:#fff;
      background:linear-gradient(180deg,var(--zpg-accent),var(--zpg-accent-2));
      border:1px solid rgba(255,255,255,.22);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 18px rgba(16,185,129,.24);
      transition:transform .2s var(--zpg-ease),box-shadow .2s var(--zpg-ease),filter .2s var(--zpg-ease);
    }
    .zcp-pull-btn-submit:hover{transform:translateY(-1px);filter:brightness(1.04);box-shadow:inset 0 1px 0 rgba(255,255,255,.40),0 10px 24px rgba(16,185,129,.30)}
    .zcp-pull-btn-submit:active{transform:translateY(0) scale(.99)}
    .zcp-pull-btn-submit:focus-visible{outline:none;box-shadow:var(--zpg-focus),0 6px 18px rgba(16,185,129,.24)}
    .zcp-pull-btn-submit:disabled{opacity:.45;cursor:not-allowed;transform:none;filter:none;box-shadow:none}
    .zcode-custom-toast{
      position:fixed;top:26px;left:50%;transform:translateX(-50%);z-index:1000000;
      background:var(--zpg-glass);color:var(--zpg-ink);padding:11px 18px;border-radius:999px;
      border:1px solid var(--zpg-line-2);box-shadow:var(--zpg-shadow);
      -webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);
      font-family:var(--zpg-sans);font-size:13px;font-weight:550;display:flex;align-items:center;gap:8px;
      animation:zcodeToastPop .26s var(--zpg-ease);
    }
    @keyframes zcodeToastPop{from{opacity:0;transform:translate(-50%,-10px) scale(.98)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
    @media (prefers-reduced-motion:reduce){
      #zcode-auto-pull-models-btn,.zcp-pull-modal,.zcp-pull-modal-overlay,.zcode-custom-toast{animation:none!important;transition:none!important}
      #zcode-auto-pull-models-btn:hover,.zcp-pull-close:hover,.zcp-pull-item:hover{transform:none}
    }
  `;
  document.head.appendChild(glass);

  function showToast(message, duration = 3000) {
    const existing = document.querySelector(".zcode-custom-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "zcode-custom-toast";
    toast.textContent = message;   // 纯文本：消息含供应商名/错误详情，不能当 HTML 解析
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = "opacity 0.2s, transform 0.2s";
      toast.style.opacity = "0";
      toast.style.transform = "translate(-50%, -10px)";
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  function getZCodeApi() {
    return window.zcode;
  }

  async function readZCodeConfig() {
    const api = getZCodeApi();
    if (api?.readConfigFile) {
      const res = await api.readConfigFile();
      return res.data;
    }
    return null;
  }

  async function writeZCodeConfig(data) {
    const api = getZCodeApi();
    if (api?.writeConfigFile) {
      const res = await api.writeConfigFile(data);
      return res.success;
    }
    return false;
  }

  function getCurrentProviderName(contextEl) {
    const container = contextEl?.closest?.('[data-model-provider-detail-scroll="true"]') ||
                      contextEl?.closest?.('.space-y-3')?.parentElement ||
                      document.querySelector('[data-model-provider-detail-scroll="true"]');
    if (container) {
      const header = container.querySelector('[data-testid="model-provider-header"]');
      if (header) {
        const inp = header.querySelector("input");
        if (inp && inp.value.trim()) return inp.value.trim();
        const textEl = header.querySelector(".text-foreground, [class*='font-semibold']");
        if (textEl && textEl.textContent.trim()) return textEl.textContent.trim();
      }
    }
    const root = container || document;
    for (const inp of root.querySelectorAll("input")) {
      if (inp.type === "password") continue;
      const val = (inp.value || "").trim();
      if (val && !val.startsWith("http") && !val.startsWith("sk-") && !val.includes("/")) {
        return val;
      }
    }
    return "";
  }

  function getFormCredentials(contextEl) {
    let baseUrl = "";
    let apiKey = "";

    // 严格以触发按钮为锚点向上锁定当前供应商详情容器，避免跨面板/全局 DOM 污染
    const container = contextEl?.closest?.('[data-model-provider-detail-scroll="true"]') ||
                      contextEl?.closest?.('.space-y-3')?.parentElement ||
                      document.querySelector('[data-model-provider-detail-scroll="true"]') ||
                      document;

    // 策略 1：基于 Label 语义精准定位当前面板输入框
    const labels = Array.from(container.querySelectorAll("label"));
    for (const label of labels) {
      const text = (label.textContent || "").trim().toLowerCase();
      const formItem = label.closest("div");
      const input = formItem?.querySelector("input") ||
                    (label.htmlFor ? container.querySelector(`#${CSS.escape(label.htmlFor)}`) : null);
      if (!input) continue;
      const val = (input.value || "").trim();

      if (!baseUrl && (text.includes("base url") || text.includes("端点") || text.includes("接口地址") || text === "url")) {
        baseUrl = val;
      } else if (!apiKey && (text.includes("api key") || text.includes("密钥") || text === "key" || text.includes("token"))) {
        apiKey = val;
      }
    }

    // 策略 2：基于当前容器内输入框自身特征（占位符与类型）兜底
    if (!baseUrl || !apiKey) {
      const inputs = Array.from(container.querySelectorAll("input"));
      for (const input of inputs) {
        const val = (input.value || "").trim();
        const placeholder = (input.placeholder || "").toLowerCase();

        const isKeyLike = input.type === "password" ||
                          placeholder.includes("key") ||
                          placeholder.includes("密钥") ||
                          placeholder.includes("sk-");

        if (!apiKey && isKeyLike) {
          if (val) apiKey = val;
        }

        const isUrlLike = !isKeyLike && (
          placeholder.includes("example.com") ||
          placeholder.includes("http") ||
          placeholder.includes("v1") ||
          val.startsWith("http")
        );

        if (!baseUrl && input.type !== "password" && isUrlLike) {
          if (val) baseUrl = val;
        }
      }
    }

    return { baseUrl, apiKey };
  }


  // 自动创建供应商时判定 kind（API 协议）：表单「API 格式」下拉 > URL 特征 > 现有供应商 > 通用默认
  // 3.11.2 实测下拉三选项：Anthropic Messages (/v1/messages) / Chat Completions (/chat/completions) / Responses (/responses)
  function detectFormKind() {
    const nodes = document.querySelectorAll(
      '[role="combobox"], select, button[aria-haspopup], [data-radix-collection-item]'
    );
    for (const n of nodes) {
      const low = (
        (n.textContent || "") + " " +
        (n.getAttribute("aria-label") || "") + " " +
        (n.title || "")
      ).toLowerCase();
      if (low.includes("v1/messages") || low.includes("anthropic")) return "anthropic";
      if (low.includes("chat/completions") || low.includes("chat completions")) return "openai-compatible";
      if (low.includes("/responses") || low.includes("responses (")) return "openai";
      if (low.includes("兼容") || low.includes("compatible") || low.includes("openai")) return "openai-compatible";
    }
    return null;
  }

  function inferKindFromUrl(url) {
    const u = (url || "").toLowerCase();
    if (u.includes("anthropic")) return "anthropic";
    if (/\/v1\/?$/.test(u)) return "openai-compatible";
    return null;
  }

  // 精准识别已添加的模型:以 config.json 为唯一事实源(该供应商 models 键即真实状态)。
  // 不再扫描页面输入框——删除模型后页面残留值会误标「已添加」。
  async function getExistingModels(baseUrl) {
    const existing = new Set();
    try {
      const cfg = await readZCodeConfig();
      if (cfg?.provider) {
        const norm = (u) => (u || "").replace(/\/+$/, "").replace(/\/v1$/, "");
        const cleanBase = norm(baseUrl);
        for (const [pid, pdata] of Object.entries(cfg.provider)) {
          const pBase = norm(pdata.options?.baseURL);
          if (pBase === cleanBase && pdata.models) {
            Object.keys(pdata.models).forEach((m) => {
              existing.add(m.trim());
              existing.add(m.trim().toLowerCase());   // 网关返回与本地大小写不一致时也能命中
            });
          }
        }
      }
    } catch (e) {
      console.warn("[ZCode-Model-Puller] 读取配置识别已添加模型出错:", e);
    }

    console.log("[ZCode-Model-Puller] config 已添加模型:", Array.from(existing));
    return existing;
  }

  /**
   * 核心突破：百分之百自动触发官方原生刷新
   * 直接联动页面上部的原生刷新按钮与左侧导航，促使 React 立即重新加载模型
   */
  function triggerZCodeUIRefresh() {
    console.log("[ZCode-Model-Puller] 触发原生自动刷新...");

    // 1. 优先点击页面右上方的官方原生刷新按钮
    // 特征：位于“管理自定义模型供应商...”文案同一横向容器右侧
    let refreshClicked = false;
    const descParagraph = Array.from(document.querySelectorAll("p")).find(
      (p) => p.textContent.includes("管理自定义模型供应商") || p.textContent.includes("配置后可在聊天时选择使用")
    );
    if (descParagraph && descParagraph.parentElement) {
      const btn = descParagraph.parentElement.querySelector("button");
      if (btn) {
        console.log("[ZCode-Model-Puller] 点击官方主刷新按钮");
        btn.click();
        refreshClicked = true;
      }
    }

    // 2. 兜底尝试查找右上角带有刷新旋转图标的按钮
    if (!refreshClicked) {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const b of buttons) {
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const title = (b.getAttribute("title") || "").toLowerCase();
        const rect = b.getBoundingClientRect();
        if (
          (aria.includes("刷新") || aria.includes("refresh") || title.includes("刷新") || title.includes("refresh")) ||
          (rect.top < 180 && rect.right > window.innerWidth - 200 && b.querySelector("svg"))
        ) {
          b.click();
          refreshClicked = true;
          break;
        }
      }
    }

    // 3. 伴随轻点当前选中的供应商项，触发组件重新渲染
    setTimeout(() => {
      const pName = getCurrentProviderName();
      if (pName) {
        const sideItems = Array.from(
          document.querySelectorAll("div[class*='rounded'], button, div[class*='cursor-pointer']")
        );
        for (const item of sideItems) {
          const rect = item.getBoundingClientRect();
          if (rect.left < 360 && item.textContent.includes(pName)) {
            item.click();
            break;
          }
        }
      }
    }, 150);
  }

  // 模型选择弹窗
  async function openModelSelectModal(models, baseUrl, apiKey, metas, contextEl) {
    const existingModels = await getExistingModels(baseUrl);

    const stateMap = new Map();
    let newCount = 0;
    for (const id of models) {
      const exists = existingModels.has(id) || existingModels.has((id || "").toLowerCase());
      const selected = !exists; // 仅新模型默认勾选
      stateMap.set(id, { exists, selected });
      if (!exists) newCount++;
    }

    const overlay = document.createElement("div");
    overlay.className = "zcp-pull-modal-overlay";

    overlay.innerHTML = `
      <div class="zcp-pull-modal" role="dialog" aria-modal="true" aria-label="选择要同步的模型">
        <div class="zcp-pull-header">
          <div class="zcp-pull-title">
            <span class="zcp-pull-icon-wrap">
              <svg class="zcp-pull-bolt-icon" viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
            </span>
            <span class="zcp-pull-heading">
              <span class="zcp-pull-heading-main">选择要同步的模型</span>
              <span class="zcp-pull-sub">共 ${models.length} 个 · 待添加 ${newCount} 个</span>
            </span>
          </div>
          <button class="zcp-pull-close" id="zcode-modal-close-btn" title="关闭" aria-label="关闭">✕</button>
        </div>
        <div class="zcp-pull-body">
          <div class="zcp-pull-toolbar">
            <input type="text" class="zcp-pull-search" id="zcode-modal-search" placeholder="搜索模型名称..." />
            <div class="zcp-pull-btn-group">
              <button class="zcp-pull-mini-btn" id="zcode-select-all">全选</button>
              <button class="zcp-pull-mini-btn" id="zcode-select-none">清空</button>
              <button class="zcp-pull-mini-btn" id="zcode-select-new">仅选新模型 (${newCount})</button>
            </div>
          </div>
          <div class="zcp-pull-list" id="zcode-modal-list"></div>
        </div>
        <div class="zcp-pull-footer">
          <div class="zcp-pull-count-info" id="zcp-pull-count-info">
            已选中 <strong id="zcode-selected-num">${newCount}</strong> / ${models.length} 个模型
          </div>
          <div class="zcp-pull-footer-btns">
            <button class="zcp-pull-btn-cancel" id="zcode-modal-cancel">取消</button>
            <button class="zcp-pull-btn-submit" id="zcode-modal-confirm" ${
              newCount === 0 ? "disabled" : ""
            }>
              <span>确认添加并保存 (<span id="zcode-btn-selected-num">${newCount}</span>)</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // 列表项一律用 DOM API 构建：模型名来自远端 /models 响应，拼 innerHTML 会形成注入面
    // （名字里带 " 或 & 时还会破坏属性、导致勾选与搜索错位）。这里只走 textContent /
    // setAttribute，保证远端数据永远被当作纯文本。
    const listEl = overlay.querySelector("#zcode-modal-list");
    for (const id of models) {
      const info = stateMap.get(id);
      const item = document.createElement("div");
      item.className = "zcp-pull-item";
      item.setAttribute("data-id", id);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!info.selected;
      cb.setAttribute("data-id", id);
      const nameEl = document.createElement("span");
      nameEl.className = "zcp-pull-item-name";
      nameEl.textContent = id;
      const badge = document.createElement("span");
      badge.className = "zcp-pull-badge " +
        (info.exists ? "zcp-pull-badge-exists" : "zcp-pull-badge-new");
      badge.textContent = info.exists ? "已添加" : "新模型";
      item.append(cb, nameEl, badge);
      listEl.appendChild(item);
    }

    function updateCountsOnly() {
      let selCount = 0;
      for (const [_, info] of stateMap) {
        if (info.selected) selCount++;
      }
      const numSpan = overlay.querySelector("#zcode-selected-num");
      const btnNumSpan = overlay.querySelector("#zcode-btn-selected-num");
      const confirmBtn = overlay.querySelector("#zcode-modal-confirm");

      if (numSpan) numSpan.textContent = selCount;
      if (btnNumSpan) btnNumSpan.textContent = selCount;
      if (confirmBtn) confirmBtn.disabled = selCount === 0;
    }

    const listContainer = overlay.querySelector("#zcode-modal-list");
    listContainer.addEventListener("click", (e) => {
      const itemEl = e.target.closest(".zcp-pull-item");
      if (!itemEl) return;
      const id = itemEl.getAttribute("data-id");
      const info = stateMap.get(id);
      if (info) {
        info.selected = !info.selected;
        const checkbox = itemEl.querySelector("input[type='checkbox']");
        if (checkbox) checkbox.checked = info.selected;
        updateCountsOnly();
      }
    });

    const searchInput = overlay.querySelector("#zcode-modal-search");
    searchInput.oninput = (e) => {
      const kw = e.target.value.toLowerCase().trim();
      const items = listContainer.querySelectorAll(".zcp-pull-item");
      items.forEach((it) => {
        const id = it.getAttribute("data-id").toLowerCase();
        it.style.display = id.includes(kw) ? "flex" : "none";
      });
    };

    overlay.querySelector("#zcode-select-all").onclick = () => {
      for (const [id, info] of stateMap) {
        info.selected = true;
      }
      listContainer.querySelectorAll("input[type='checkbox']").forEach((cb) => (cb.checked = true));
      updateCountsOnly();
    };

    overlay.querySelector("#zcode-select-none").onclick = () => {
      for (const [id, info] of stateMap) {
        info.selected = false;
      }
      listContainer.querySelectorAll("input[type='checkbox']").forEach((cb) => (cb.checked = false));
      updateCountsOnly();
    };

    overlay.querySelector("#zcode-select-new").onclick = () => {
      for (const [id, info] of stateMap) {
        info.selected = !info.exists;
      }
      listContainer.querySelectorAll(".zcp-pull-item").forEach((it) => {
        const id = it.getAttribute("data-id");
        const cb = it.querySelector("input[type='checkbox']");
        const info = stateMap.get(id);
        if (cb && info) cb.checked = info.selected;
      });
      updateCountsOnly();
    };

    const closeModal = () => overlay.remove();
    overlay.querySelector("#zcode-modal-close-btn").onclick = closeModal;
    overlay.querySelector("#zcode-modal-cancel").onclick = closeModal;

    const confirmBtn = overlay.querySelector("#zcode-modal-confirm");
    confirmBtn.onclick = async () => {
      const toAdd = [];
      for (const [id, info] of stateMap) {
        if (info.selected) toAdd.push(id);
      }
      if (toAdd.length === 0) return;

      confirmBtn.disabled = true;
      confirmBtn.innerHTML = `<span>正在保存...</span>`;

      try {
        console.log("[ZCode-Model-Puller] 通过 IPC 读取配置文件...");
        const cfg = await readZCodeConfig();
        if (!cfg || !cfg.provider) {
          throw new Error("未能获取到 ZCode 配置数据");
        }

        const providers = cfg.provider;
        let targetPid = null;
        let p = null;
        let createdProvider = null;
        const targets = [];

        // 与 getExistingModels 完全一致的规范化（去尾斜杠 + 去尾部 /v1）：
        // 「已添加」判定和实际写入必须落在同一批供应商上，否则会出现
        // 弹窗标已添加、确认后却写进另一个（或新建的）供应商的幽灵状态
        const normBase = (u) => (u || "").replace(/\/+$/, "").replace(/\/v1$/, "");
        const cleanBase = normBase(baseUrl);
        for (const [pid, pdata] of Object.entries(providers)) {
          if (normBase(pdata.options?.baseURL) === cleanBase) {
            targets.push(pdata);
            if (!p) {
              targetPid = pid;
              p = pdata;
            }
          }
        }

        // 仅在已有条目 Base URL 为空（未保存）或与当前一致时才复用名称匹配条目，
        // 绝不因默认同名“新供应商”而将模型写错到不同 Base URL 的已有供应商上
        if (!p) {
          const pName = getCurrentProviderName(contextEl);
          if (pName) {
            for (const [pid, pdata] of Object.entries(providers)) {
              const exBase = normBase(pdata.options?.baseURL);
              if (pdata.name === pName && (!exBase || exBase === cleanBase)) {
                targetPid = pid;
                p = pdata;
                targets.push(pdata);
                break;
              }
            }
          }
        }

        if (!p) {
          // 一步到位：供应商尚未落盘（正在新增、或改了 Base URL 未保存）时自动创建条目。
          // kind 判定：表单下拉检测 > URL 特征 > 现有自定义供应商 > openai-compatible
          const customList = Object.values(providers).filter(x => x && x.source === "custom");
          const donor = customList.find(x => x.options && typeof x.options.apiKeyRequired !== "undefined");
          let host = baseUrl;
          try { host = new URL(baseUrl).host; } catch (e) {}
          const newName = getCurrentProviderName(contextEl) || host;
          const kind =
            detectFormKind() ||
            inferKindFromUrl(baseUrl) ||
            (customList[0] || {}).kind ||
            "openai-compatible";
          const nid = window.crypto && crypto.randomUUID
            ? crypto.randomUUID()
            : "puller-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          targetPid = nid;
          p = {
            name: newName,
            kind: kind,
            source: "custom",
            options: Object.assign(
              { baseURL: baseUrl },
              apiKey ? { apiKey: apiKey } : {},
              donor ? { apiKeyRequired: donor.options.apiKeyRequired } : {}
            ),
            models: {},
          };
          providers[nid] = p;
          createdProvider = { name: newName, kind: kind };
          console.log("[ZCode-Model-Puller] 供应商不存在，已自动创建:", createdProvider);
        } else {
          if (!p.options) p.options = {};
          if (!p.options.baseURL || normBase(p.options.baseURL) !== cleanBase) {
            p.options.baseURL = baseUrl;
          }
          if (apiKey && !p.options.apiKey) {
            p.options.apiKey = apiKey;
          }
        }

        // 关键修复：勾选的模型一律重写条目，不再因 config 里已存在而跳过。
        // 界面删除模型后 config 与界面状态可能不同步（config 里残留旧条目），
        // 旧逻辑 continue 导致「再次添加」实际没写任何东西，列表永远刷不出来。
        const targetList = targets.length ? targets : [p];
        if (targets.length > 1) {
          console.log(`[ZCode-Model-Puller] 检测到 ${targets.length} 个同 baseURL 供应商条目，全部同步写入`);
        }
        let addedCount = 0;
        let refreshedCount = 0;
        for (const prov of targetList) {
          prov.models = prov.models || {};
          for (const mid of toAdd) {
            const existed = !!prov.models[mid];
            // 优先用 /v1/models 返回的真实元数据（context_length/max_output_tokens/
            // supported_efforts/default_effort，workbuddy2api 等网关透出），缺失时退回保守模板
            const m = (metas && metas[mid]) || {};
            let efforts = Array.isArray(m.efforts) && m.efforts.length
              ? m.efforts.map((x) => String(x).trim()).filter(Boolean)
              : ["off", "low", "high", "max"];
            if (!efforts.includes("off")) efforts = ["off", ...efforts];
            // 3.14.x 原生档位机制：optionSpecs.reasoningLevel（values 末位即默认档），
            // map 为 CEL 表达式，按档位生成 JSON 合并补丁直接打进请求体
            const optMap = prov.kind === "anthropic"
              ? "reasoningLevel=='off' ? {'thinking':{'type':'disabled'}} : {'thinking':{'type':'adaptive'},'output_config':{'effort':reasoningLevel}}"
              : "{'reasoning_effort':reasoningLevel}";
            prov.models[mid] = {
              limit: {
                context: m.context > 0 ? m.context : 1000000,
                output: m.output > 0 ? m.output : 128000,
              },
              modalities: { input: ["text", "image"], output: ["text"] },
              optionSpecs: { reasoningLevel: { values: efforts, map: optMap } },
              zcode: { modalitiesConfigured: true, modified: true },
            };
            if (existed) refreshedCount++;
            else addedCount++;
          }
        }

        console.log(
          `[ZCode-Model-Puller] 写入完成：新增 ${addedCount} 个，重写已存在 ${refreshedCount} 个 →`,
          targetList.map((x) => x.name)
        );
        const payload = Object.assign({}, cfg, {
          config: cfg,
          targetPid: targetPid,
          targetBaseUrl: baseUrl,
          __targetPid: targetPid,
          __targetBaseUrl: baseUrl,
        });
        const ok = await writeZCodeConfig(payload);
        if (!ok) {
          throw new Error("写入配置文件失败");
        }

        const summary = refreshedCount > 0
          ? `新增 ${addedCount} 个、重写已存在 ${refreshedCount} 个（自带思考档位）`
          : `成功添加 ${addedCount} 个模型（自带思考档位）`;
        showToast(
          createdProvider
            ? `🎉 已创建供应商「${createdProvider.name}」（${createdProvider.kind}），${summary}；如设置页未刷新请重新打开`
            : `🎉 ${summary}！已自动刷新列表`
        );
        closeModal();

        // 自动触发官方原生刷新，新模型卡片即刻展现在列表中！
        setTimeout(() => {
          triggerZCodeUIRefresh();
        }, 120);
      } catch (err) {
        console.error("[ZCode-Model-Puller] 保存失败:", err);
        showToast(`❌ 保存出错: ${err.message}`);
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `<span>确认添加并保存 (${toAdd.length})</span>`;
      }
    };

    document.body.appendChild(overlay);
  }

  // 查找当前真正处于可见状态的「添加模型」按钮
  function findActiveAddModelButton() {
    // 1. 优先按官方 data-testid 查找可见按钮
    const candidates = Array.from(document.querySelectorAll(
      'button[data-testid="model-provider-add-model-button"], button[data-testid="Goe"]'
    ));
    for (const b of candidates) {
      if (b.id !== "zcode-auto-pull-models-btn" && b.offsetParent != null) {
        return b;
      }
    }

    // 2. 文本特征兜底：查找供应商详情/弹窗/设置容器内包含“添加模型”或“Add Model”的按钮
    const container = document.querySelector(
      '[data-model-provider-detail-scroll="true"], [data-model-provider-split-panel="true"], [role="dialog"], [class*="provider"], [class*="settings"]'
    );
    if (container) {
      const btns = Array.from(container.querySelectorAll("button"));
      for (const b of btns) {
        if (b.id === "zcode-auto-pull-models-btn" || b.offsetParent == null) continue;
        const txt = (b.textContent || "").trim();
        if (txt.includes("添加模型") || txt.includes("Add Model") || txt.includes("Add model")) {
          return b;
        }
      }
    }
    return null;
  }

  // 注入高级质感按钮并保持与当前供应商视图强绑定自愈
  function checkAndInject() {
    const addModelBtn = findActiveAddModelButton();
    // 当前视图若不在模型供应商详情页（例如在聊天主界面），快速短路
    if (!addModelBtn) return;

    const parent = addModelBtn.parentElement;
    if (!parent) return;

    let pullBtn = document.getElementById("zcode-auto-pull-models-btn");
    // ★ 核心自愈：若拉取按钮已存在，但不是当前可见 addModelBtn 的相邻同级元素（例如残留于上一个供应商视图或被移动）
    if (pullBtn && pullBtn.parentElement !== parent) {
      pullBtn.remove();
      pullBtn = null;
    }

    if (pullBtn && pullBtn.isConnected) {
      return;
    }

    parent.style.display = "flex";
    parent.style.flexWrap = "wrap";
    parent.style.alignItems = "center";
    parent.style.gap = "8px";

    pullBtn = document.createElement("button");
    pullBtn.id = "zcode-auto-pull-models-btn";
    pullBtn.type = "button";
    pullBtn.setAttribute("title", "根据当前 Base URL 和 API Key 自动拉取所有可用模型");

    pullBtn.innerHTML = `
      <span class="zcp-pull-icon-wrap">
        <svg class="zcp-pull-bolt-icon" viewBox="0 0 24 24" aria-hidden="true">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
      </span>
      <span>自动拉取模型</span>
    `;

    pullBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const { baseUrl, apiKey } = getFormCredentials(pullBtn);
      console.log("[ZCode-Model-Puller] 点击拉取，凭据:", { baseUrl, hasKey: !!apiKey });

      if (!baseUrl) {
        showToast("⚠️ 请先在上方填写 Base URL");
        return;
      }

      pullBtn.classList.add("loading");
      pullBtn.innerHTML = `
        <span class="zcp-pull-icon-wrap">
          <svg class="zcode-spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px;" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
            <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
          </svg>
        </span>
        <span>正在拉取模型...</span>
      `;

      try {
        let result = null;
        const api = getZCodeApi();
        if (api?.fetchModelsFromUrl) {
          result = await api.fetchModelsFromUrl(baseUrl, apiKey);
        } else {
          try {
            const cleanUrl = baseUrl.replace(/\/+$/, "");
            const candidates = [
              cleanUrl.endsWith("/v1") ? `${cleanUrl}/models` : `${cleanUrl}/v1/models`,
              `${cleanUrl}/models`,
            ];
            if (cleanUrl.endsWith("/api")) candidates.unshift(`${cleanUrl}/v1/models`);

            for (const u of candidates) {
              try {
                const headers = { Accept: "application/json" };
                if (apiKey) {
                  headers["Authorization"] = `Bearer ${apiKey}`;
                  headers["x-api-key"] = apiKey;
                }
                const res = await fetch(u, { headers });
                if (res.ok) {
                  const data = await res.json();
                  const list = (data.data || data.models || data).map((m) =>
                    typeof m === "string" ? m : m.id || m.name
                  );
                  result = { success: true, models: list.filter(Boolean) };
                  break;
                }
              } catch (e) {}
            }
          } catch (fetchErr) {
            result = { success: false, error: fetchErr.message };
          }
        }

        if (result?.success && result.models?.length > 0) {
          await openModelSelectModal(result.models, baseUrl, apiKey, result.metas, pullBtn);
        } else {
          showToast(`❌ 拉取失败: ${result?.error || "未获取到模型，请检查地址和 Key"}`);
        }
      } catch (err) {
        showToast(`❌ 请求异常: ${err.message}`);
      } finally {
        pullBtn.classList.remove("loading");
        pullBtn.innerHTML = `
          <span class="zcp-pull-icon-wrap">
            <svg class="zcp-pull-bolt-icon" viewBox="0 0 24 24" aria-hidden="true">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
          </span>
          <span>自动拉取模型</span>
        `;
      }
    };

    addModelBtn.after(pullBtn);
  }

  // 监听点击与按键事件，零延迟自愈
  try {
    document.addEventListener("click", () => {
      setTimeout(checkAndInject, 50);
    }, { passive: true });
    document.addEventListener("keydown", () => {
      setTimeout(checkAndInject, 50);
    }, { passive: true });
  } catch (_) {}

  // 350ms 轮询兜底，在主聊天界面时单次属性查询瞬间短路，零开销
  setInterval(checkAndInject, 350);
  checkAndInject();
})();
