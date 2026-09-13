'use strict';

const $ = (selector) => document.querySelector(selector);
const chatEl = $('#chat');
const inputEl = $('#input');
const sendEl = $('#send');
const statusEl = $('#status');
const modeAsk = $('#modeAsk');
const modeAgent = $('#modeAgent');
const formEl = $('#inputForm');
const chipsEl = $('#chips');
const toastEl = $('#copyToast');
const modelPill = $('#modelPill');
const modelMenu = $('#modelMenu');
const clearButton = $('#clear');
let allowActions = true;
let activeRun = null;
let history = [];
let sessionKey = '';
let initialized = false;
let currentModelId = '';
let menuModels = [];
let persistQueue = Promise.resolve();
let autoStick = true;
let toastTimer;

marked.use({
  gfm: true,
  breaks: false,
  extensions: [{
    name: 'highlight',
    level: 'inline',
    start(source) { return source.indexOf('=='); },
    tokenizer(source) {
      const match = /^==(?=\S)([\s\S]*?\S)==/.exec(source);
      if (match) return { type: 'highlight', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) { return `<mark>${this.parser.parseInline(token.tokens)}</mark>`; },
  }],
});

function renderMarkdown(text) {
  const raw = marked.parse(String(text ?? ''));
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'picture', 'source', 'audio', 'video', 'iframe', 'object', 'embed', 'style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'srcset', 'formaction'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  }).replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, '</table></div>');
}

function hardenLinks(root) {
  for (const link of root.querySelectorAll('a')) {
    let url;
    try { url = new URL(link.getAttribute('href') || '', location.href); } catch { link.removeAttribute('href'); continue; }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) link.removeAttribute('href');
    else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
    }
  }
}

chatEl.addEventListener('scroll', () => {
  autoStick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
});

function scrollBottom(force = false) {
  if (force) autoStick = true;
  if (autoStick) chatEl.scrollTop = chatEl.scrollHeight;
}

function addMessage(role, text) {
  const element = document.createElement('div');
  element.className = `msg ${role}`;
  if (role === 'ai') {
    const markdown = document.createElement('div');
    markdown.className = 'md-content';
    markdown.innerHTML = renderMarkdown(text);
    hardenLinks(markdown);
    element.appendChild(markdown);
  } else {
    element.textContent = text;
  }
  chatEl.appendChild(element);
  scrollBottom(role !== 'sys');
  return element;
}

function addTools(round, actions) {
  const block = document.createElement('div');
  block.className = 'tools';
  const heading = document.createElement('div');
  heading.className = 'tools-head';
  heading.textContent = `第 ${round} 轮 · ${actions.length} 个操作`;
  block.appendChild(heading);
  const slots = [];
  for (const action of actions) {
    const row = document.createElement('div');
    row.className = 'tool pending';
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = action.action;
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    const sensitive = /password|密码|验证码|token|secret|银行卡|cvv/i.test(String(action.selector || ''));
    const value = sensitive ? '[已隐藏]' : action.value;
    detail.textContent = `${action.ref != null ? `@${action.ref}` : action.selector || ''}${value != null && value !== '' ? ` ← "${String(value).slice(0, 160)}"` : ''}`;
    const state = document.createElement('span');
    state.className = 'tool-state';
    state.textContent = '…';
    row.append(name, detail, state);
    block.appendChild(row);
    slots.push({ row, state });
  }
  chatEl.appendChild(block);
  scrollBottom();
  return slots;
}

function formatActionPreview(action, indent = '') {
  const target = action.ref != null ? `@${action.ref}` : action.selector || '';
  const value = action.value != null && action.value !== '' ? ` ← ${String(action.value).slice(0, 120)}` : '';
  if (action.action !== 'repeat') return `${indent}${action.action} ${target}${value}`.trimEnd();
  const header = `${indent}repeat ${action.times || 1} 次，周期 ${action.value ?? 1000}ms`;
  return [header, ...(action.actions || []).map((item) => formatActionPreview(item, `${indent}  `))].join('\n');
}

function addApproval(context, message) {
  for (const card of context.approvals.values()) resolveApprovalCard(card, false, '已失效');
  const card = document.createElement('section');
  card.className = 'approval';
  const title = document.createElement('strong');
  title.textContent = '需要你的确认';
  const reason = document.createElement('div');
  reason.textContent = message.reason || '即将执行高风险操作';
  const preview = document.createElement('pre');
  preview.textContent = (message.actions || []).map((action) => formatActionPreview(action)).join('\n');
  const buttons = document.createElement('div');
  buttons.className = 'approval-actions';
  const approve = document.createElement('button');
  approve.className = 'primary';
  approve.textContent = '允许本批操作';
  const cancel = document.createElement('button');
  cancel.textContent = '取消任务';
  buttons.append(approve, cancel);
  card.append(title, reason, preview, buttons);
  chatEl.appendChild(card);
  const entry = { card, buttons, approvalId: message.approvalId };
  context.approvals.set(message.approvalId, entry);
  approve.addEventListener('click', () => {
    if (activeRun !== context || context.finished) return;
    context.port?.postMessage({ t: 'approve', runId: context.runId, approvalId: message.approvalId, approved: true });
    resolveApprovalCard(entry, true, '已允许');
  });
  cancel.addEventListener('click', () => {
    if (activeRun !== context || context.finished) return;
    context.port?.postMessage({ t: 'approve', runId: context.runId, approvalId: message.approvalId, approved: false });
    resolveApprovalCard(entry, false, '已取消');
  });
  scrollBottom(true);
}

function resolveApprovalCard(entry, approved, label) {
  if (!entry || entry.card.classList.contains('resolved')) return;
  entry.card.classList.add('resolved');
  entry.buttons.replaceChildren(document.createTextNode(label || (approved ? '已允许' : '已取消')));
}

function setStatus(text) {
  statusEl.classList.toggle('show', !!text);
  statusEl.textContent = text || '';
}

function showToast(message) {
  toastEl.textContent = message || '已复制';
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

async function copyText(text, success) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(success);
  } catch {
    showToast('复制失败');
  }
}

document.addEventListener('click', (event) => {
  const pre = event.target.closest('pre');
  if (pre?.closest('.md-content')) { void copyText((pre.innerText || '').trim(), '代码块已复制'); return; }
  if (event.target.tagName === 'CODE' && event.target.closest('.md-content') && !event.target.closest('pre')) void copyText((event.target.innerText || '').trim(), '行内代码已复制');
});

function setControlsRunning(running) {
  sendEl.textContent = running ? '■' : '➤';
  sendEl.title = running ? '停止' : '发送';
  sendEl.setAttribute('aria-label', running ? '停止' : '发送');
  modeAsk.disabled = running;
  modeAgent.disabled = running;
  clearButton.disabled = running;
  modelPill.disabled = running;
  for (const chip of chipsEl.querySelectorAll('.chip:not(#modelPill)')) chip.disabled = running;
}

function setMode(value) {
  if (activeRun) return;
  allowActions = value;
  modeAsk.classList.toggle('on', !value);
  modeAgent.classList.toggle('on', value);
  modeAsk.setAttribute('aria-pressed', String(!value));
  modeAgent.setAttribute('aria-pressed', String(value));
}
modeAsk.addEventListener('click', () => setMode(false));
modeAgent.addEventListener('click', () => setMode(true));

function persist() {
  if (!sessionKey) return Promise.resolve();
  const snapshot = history.slice(-100).map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 20000) }));
  persistQueue = persistQueue.then(() => chrome.storage.session.set({ [sessionKey]: snapshot })).catch((error) => {
    addMessage('sys', `对话保存失败：${error.message}`);
  });
  return persistQueue;
}

async function initializeHistory(windowId) {
  sessionKey = `chat:${windowId}`;
  const stored = await chrome.storage.session.get([sessionKey, 'chat']);
  const saved = Array.isArray(stored[sessionKey]) ? stored[sessionKey] : Array.isArray(stored.chat) ? stored.chat : [];
  history = saved.filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-100);
  if (!stored[sessionKey] && Array.isArray(stored.chat)) {
    await chrome.storage.session.set({ [sessionKey]: history });
    await chrome.storage.session.remove('chat');
  }
  for (const item of history) addMessage(item.role === 'user' ? 'user' : 'ai', item.content);
}

function toggleMenu(open) {
  const next = open ?? !modelMenu.classList.contains('show');
  if (next && !activeRun) {
    const rect = modelPill.getBoundingClientRect();
    modelMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 240))}px`;
    modelMenu.style.top = `${rect.bottom + 6}px`;
    modelMenu.classList.add('show');
    modelPill.setAttribute('aria-expanded', 'true');
    modelMenu.querySelector('button')?.focus();
  } else {
    modelMenu.classList.remove('show');
    modelPill.setAttribute('aria-expanded', 'false');
  }
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function refreshModels() {
  const state = await runtimeMessage({ type: 'GET_SETTINGS' });
  if (!state?.ok) throw new Error(state?.error || '无法读取模型设置');
  menuModels = state.models || [];
  currentModelId = state.activeModelId || '';
  const current = menuModels.find((model) => model.id === currentModelId);
  modelPill.textContent = current ? `${current.name || '未命名模型'} ▾` : '＋ 配置模型';
  renderModelMenu();
  return current;
}

function renderModelMenu() {
  modelMenu.innerHTML = '';
  for (const model of menuModels) {
    const item = document.createElement('button');
    item.type = 'button';
    item.role = 'menuitemradio';
    item.className = `model-item${model.id === currentModelId ? ' on' : ''}`;
    item.setAttribute('aria-checked', String(model.id === currentModelId));
    item.textContent = model.name || '未命名模型';
    item.addEventListener('click', async () => {
      try {
        const response = await runtimeMessage({ type: 'UPDATE_SETTINGS', operation: 'setActive', id: model.id });
        if (!response?.ok) throw new Error(response?.error || '切换失败');
        await refreshModels();
        toggleMenu(false);
        addMessage('sys', `已切换模型：${model.name || '未命名模型'}`);
      } catch (error) { addMessage('sys', `切换模型失败：${error.message}`); }
    });
    modelMenu.appendChild(item);
  }
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.role = 'menuitem';
  manage.className = 'model-item manage';
  manage.textContent = '管理模型…';
  manage.addEventListener('click', () => { toggleMenu(false); chrome.runtime.openOptionsPage(); });
  modelMenu.appendChild(manage);
}

modelPill.setAttribute('aria-haspopup', 'menu');
modelPill.setAttribute('aria-expanded', 'false');
modelPill.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(); });
document.addEventListener('click', (event) => { if (!modelMenu.contains(event.target) && event.target !== modelPill) toggleMenu(false); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modelMenu.classList.contains('show')) { toggleMenu(false); modelPill.focus(); }
});

$('#gear').addEventListener('click', () => chrome.runtime.openOptionsPage());
clearButton.addEventListener('click', async () => {
  if (activeRun) return;
  history = [];
  chatEl.innerHTML = '';
  try { await chrome.storage.session.remove(sessionKey); addMessage('sys', '已新建对话'); }
  catch (error) { addMessage('sys', `新建失败：${error.message}`); }
});

const CHIPS = [
  { label: '做题', mode: true, question: '自动完成当前页面的所有题目：认真读题（含图片题）后逐题作答，多选题选择全部正确选项；全部答完后停下向我汇报，未经我确认不要提交。' },
  { label: '翻译', mode: false, question: '把当前页面的主要内容完整翻译成英文，保持原有结构和 Markdown 格式。' },
  { label: '总结', mode: false, question: '用简洁清晰的 Markdown 总结当前页面，先给一句话结论，再列要点。' },
  { label: '解释', mode: false, question: '这个页面讲了什么？请用通俗易懂的语言解释。' },
];
for (const chip of CHIPS) {
  const button = document.createElement('button');
  button.className = 'chip';
  button.type = 'button';
  button.textContent = chip.label;
  button.addEventListener('click', () => {
    if (activeRun) return;
    setMode(chip.mode);
    inputEl.value = chip.question;
    autosize();
    void send();
  });
  chipsEl.appendChild(button);
}

function finishRun(context, outcome, error = '') {
  if (!context || context.finished) return;
  context.finished = true;
  clearInterval(context.heartbeat);
  for (const controller of context.modelControllers.values()) controller.abort();
  context.modelControllers.clear();
  for (const approval of context.approvals.values()) resolveApprovalCard(approval, false, '已失效');
  context.approvals.clear();
  try { context.port?.disconnect(); } catch {}
  if (activeRun !== context) return;
  activeRun = null;
  setControlsRunning(false);
  setStatus('');
  if (error) addMessage('sys', error);
  else if (outcome === 'cancelled') addMessage('sys', '任务已停止');
  else if (outcome === 'limit') addMessage('sys', '任务达到最大轮数后停止');
  else if (outcome === 'stalled') addMessage('sys', '任务因连续重复或无进展而安全停止');
}

async function handleModelRequest(context, message) {
  if (context.finished || activeRun !== context) return;
  const controller = new AbortController();
  context.modelControllers.set(message.requestId, controller);
  try {
    const text = await globalThis.ViasCore.callModel(message.cfg, message.messages, { signal: controller.signal, timeoutMs: 180000, retries: 2 });
    if (!context.finished) context.port.postMessage({ t: 'model_response', runId: context.runId, requestId: message.requestId, text });
  } catch (error) {
    if (!context.finished) context.port.postMessage({ t: 'model_response', runId: context.runId, requestId: message.requestId, error: error.name === 'AbortError' ? '模型请求已取消' : error.message });
  } finally {
    context.modelControllers.delete(message.requestId);
  }
}

function stopRun() {
  const context = activeRun;
  if (!context || context.stopRequested) return;
  context.stopRequested = true;
  setStatus('正在安全停止…');
  for (const controller of context.modelControllers.values()) controller.abort();
  if (context.port) {
    try { context.port.postMessage({ t: 'cancel', runId: context.runId }); } catch { finishRun(context, 'interrupted', '连接已中断，任务已停止'); }
  } else {
    finishRun(context, 'cancelled');
  }
}

async function send() {
  const question = inputEl.value.trim();
  if (!initialized || !question || activeRun) return;
  const context = {
    runId: crypto.randomUUID(),
    port: null,
    heartbeat: null,
    modelControllers: new Map(),
    approvals: new Map(),
    toolsByRound: new Map(),
    finished: false,
    stopRequested: false,
  };
  activeRun = context;
  setControlsRunning(true);
  setStatus('准备任务…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeRun !== context || context.stopRequested) { finishRun(context, 'cancelled'); return; }
    if (!tab?.id || /^(edge|chrome|extension|about|file):/i.test(tab.url || '')) throw new Error('当前页面不可读取，请切换到普通 http(s) 网页');
    inputEl.value = '';
    autosize();
    addMessage('user', question);
    history.push({ role: 'user', content: question });
    void persist();
    scrollBottom(true);

    const port = chrome.runtime.connect({ name: 'agent' });
    context.port = port;
    port.onMessage.addListener((message) => {
      if (message.runId && message.runId !== context.runId) return;
      if (activeRun !== context || context.finished) return;
      if (message.t === 'status') setStatus(message.text);
      else if (message.t === 'say') {
        addMessage('ai', message.text);
        history.push({ role: 'assistant', content: message.text });
        void persist();
      } else if (message.t === 'actions') {
        context.toolsByRound.set(message.round, addTools(message.round, message.actions || []));
      } else if (message.t === 'result') {
        const slot = context.toolsByRound.get(message.round)?.[message.index];
        if (slot) {
          slot.row.classList.remove('pending');
          slot.row.classList.add(message.ok ? 'ok' : 'fail');
          slot.state.textContent = message.ok ? (message.state?.replace('当前值=', '') || '完成') : '失败';
          slot.row.title = message.msg || message.code || '';
        }
      } else if (message.t === 'model_request') {
        void handleModelRequest(context, message);
      } else if (message.t === 'model_cancel') {
        context.modelControllers.get(message.requestId)?.abort();
      } else if (message.t === 'approval') {
        addApproval(context, message);
      } else if (message.t === 'error') {
        finishRun(context, 'interrupted', message.message || '任务启动失败');
      } else if (message.t === 'done') {
        finishRun(context, message.outcome || 'completed', message.error || '');
      }
      scrollBottom();
    });
    port.onDisconnect.addListener(() => {
      if (!context.finished) finishRun(context, 'interrupted', '后台连接中断，任务已安全停止；请检查页面状态后再决定是否重试');
    });
    context.heartbeat = setInterval(() => {
      try { port.postMessage({ t: 'ping', runId: context.runId }); } catch {}
    }, 15000);
    const conversation = history.slice(0, -1).map((item) => ({ role: item.role, content: String(item.content).slice(0, 20000) }));
    port.postMessage({ t: 'RUN', runId: context.runId, tabId: tab.id, question, allowActions, maxSteps: allowActions ? 50 : 1, history: conversation });
  } catch (error) {
    finishRun(context, 'interrupted', error.message);
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  if (activeRun) stopRun();
  else void send();
});
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
});

function autosize() {
  inputEl.style.height = '0px';
  const height = inputEl.scrollHeight;
  if (height > 48) {
    inputEl.style.height = `${Math.min(height, 132) - 16}px`;
    inputEl.style.overflowY = height > 132 ? 'auto' : 'hidden';
  } else {
    inputEl.style.height = '22px';
    inputEl.style.overflowY = 'hidden';
  }
}
inputEl.addEventListener('input', autosize);

window.addEventListener('pagehide', () => {
  if (activeRun) {
    try { activeRun.port?.postMessage({ t: 'cancel', runId: activeRun.runId }); } catch {}
    for (const controller of activeRun.modelControllers.values()) controller.abort();
    try { activeRun.port?.disconnect(); } catch {}
  }
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local' && !activeRun) refreshModels().catch(() => {});
});

(async () => {
  setControlsRunning(true);
  try {
    const currentWindow = await chrome.windows.getCurrent();
    await initializeHistory(currentWindow.id);
    const current = await refreshModels();
    if (!current) addMessage('sys', '尚未配置模型：点击上方「＋ 配置模型」添加 API 地址、Key 和模型名。');
    if (!chatEl.children.length) addMessage('sys', 'Vias 已就绪\n「执行」可操作当前页面，「问答」只读取页面。复杂任务会持续观察并自动执行页面操作（已开启完全访问权限，全部自动允许）。');
    initialized = true;
  } catch (error) {
    addMessage('sys', `初始化失败：${error.message}`);
  } finally {
    setControlsRunning(false);
  }
})();
