// Vias 页面感知与操作执行器。所有编号只在当前快照内有效。
(() => {
  'use strict';
  if (window.__viasPageAgentLoaded) return;
  window.__viasPageAgentLoaded = true;

  const TIMING = Object.freeze({ paint: 120, event: 80, settle: 220 });
  const ACTIONS = new Set(['click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'submitForm', 'scroll', 'navigate', 'wait', 'repeat', 'check', 'checkRadio']);
  const TARGET_ACTIONS = new Set(['click', 'dblclick', 'hover', 'fill', 'type', 'select', 'submitForm', 'check', 'checkRadio']);
  const INTERACTIVE_ROLES = new Set(['button', 'radio', 'checkbox', 'option', 'tab', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'link', 'textbox', 'combobox', 'slider']);
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'head', 'link', 'meta', 'template']);
  const SENSITIVE_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-|transaction-|webauthn)/i;
  // 纯 http 页面不是安全上下文，randomUUID 不可用；退化到时间戳+随机数，仅作快照命名空间
  const documentId = crypto.randomUUID?.() || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const refMap = new Map();
  const refFingerprints = new Map();
  const labelControls = new Map();
  const optionRecords = new Map();
  const RECOVERABLE_TARGET_ERRORS = new Set(['WAIT_TIMEOUT', 'TARGET_NOT_FOUND', 'STALE_TARGET', 'TARGET_HIDDEN', 'CHECK_NOT_APPLIED']);
  let navigationEpoch = 0;
  addEventListener('beforeunload', (event) => {
    if (event.isTrusted !== true) return;
    navigationEpoch++;
    if (activeOperation) activeOperation.navigationStarted = true;
  }, true);
  const targetIdentities = new WeakMap();
  let lastTargetIdentity = 0;
  const operationCache = new Map();
  const cancelledRuns = new Set();
  let snapshotEpoch = 0;
  let lastRef = 0; // Never reuse a ref within this document, including continuation windows.
  let currentSnapshotId = '';
  let currentSnapshotUrl = '';
  let frozenSnapshot = null;
  let mutationVersion = 0;
  let continuationVersion = 0;
  let currentSnapshotMutationVersion = -1;
  let extracting = false;
  let executing = false;
  let activeRunId = '';
  let activeOperation = null;

  const mutationObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type !== 'attributes' || ['id', 'role', 'type', 'name', 'class', 'style', 'hidden', 'disabled', 'readonly', 'href', 'value', 'aria-label', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-expanded'].includes(record.attributeName))) mutationVersion++;
  });
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id', 'role', 'type', 'name', 'class', 'style', 'hidden', 'disabled', 'readonly', 'href', 'value', 'aria-label', 'aria-hidden', 'aria-disabled', 'aria-checked', 'aria-expanded'] });
  const continuationObserver = new MutationObserver(() => { continuationVersion++; });
  continuationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  const continuationStamp = () => { if (continuationObserver.takeRecords().length) continuationVersion++; return continuationVersion; };
  document.addEventListener('input', () => { mutationVersion++; continuationVersion++; }, true);
  document.addEventListener('change', () => { mutationVersion++; continuationVersion++; }, true);
  addEventListener('popstate', () => { mutationVersion++; });
  addEventListener('hashchange', () => { mutationVersion++; });

  class CancelledError extends Error {
    constructor() { super('操作已取消'); this.name = 'CancelledError'; this.code = 'CANCELLED'; }
  }

  function errorResult(code, message) {
    return { ok: false, code, error: message, msg: message };
  }

  function safeSlice(value, max) {
    const text = String(value || '');
    if (text.length <= max) return text;
    let out = '';
    for (const char of text) {
      if (out.length + char.length > max) break;
      out += char;
    }
    return out;
  }

  function cleanText(value, max = 80) {
    return safeSlice(String(value || '').replace(/\s+/g, ' ').trim(), max);
  }

  // 只读取标签文字，不把标签内控件的正文或选项当成字段提示。
  function fieldHintText(root) {
    if (!root) return '';
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const role = (node.getAttribute('role') || '').toLowerCase();
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || node.isContentEditable || ['textbox', 'combobox'].includes(role)) return;
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return parts.join(' ');
  }

  function sensitiveHint(value) {
    const hint = String(value || '').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase().trim();
    return /密码|口令|验证码|校验码|安全码|身份证|银行卡|信用卡|借记卡|密钥|令牌/.test(hint)
      || /\b(?:password|passcode|passwd|otp|cvv|cvc|captcha)\b/.test(hint)
      || /\b(?:verification|verify|security|one\s*time|2fa|mfa)\s+code\b/.test(hint)
      || /\b(?:api|access|private|secret)\s+key\b/.test(hint)
      || /\b(?:access|refresh|auth|authentication|bearer)\s+token\b/.test(hint)
      || /\b(?:client|api)\s+secret\b/.test(hint)
      || /^(?:token|secret)$/.test(hint);
  }

  function isSensitive(el) {
    if (!(el instanceof Element)) return false;
    if ((el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password')
      || SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable && !['textbox', 'combobox'].includes(role)) return false;
    const hints = ['name', 'id', 'placeholder', 'aria-label', 'title'].map((attr) => el.getAttribute(attr) || '');
    const root = el.getRootNode();
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      if (id) hints.push(fieldHintText(root.getElementById?.(id) || document.getElementById(id)));
    }
    for (const label of el.labels || []) hints.push(fieldHintText(label));
    if (!el.labels?.length) hints.push(fieldHintText(el.closest('label')));
    return hints.some(sensitiveHint);
  }

  function navigationResult() {
    const operation = activeOperation;
    if (!operation) return null;
    const moved = location.href !== operation.startUrl;
    if (!moved && !operation.navigationStarted) return null;
    return {
      ok: true,
      code: moved ? 'NAVIGATED' : 'NAVIGATING',
      ...(moved || operation.navigationUrl ? { navigationUrl: moved ? location.href : operation.navigationUrl } : {}),
      msg: '页面正在或已经跳转，本批剩余操作已停止',
    };
  }

  function assertActive(runId) {
    if (!runId || cancelledRuns.has(runId) || (activeRunId && activeRunId !== runId)) throw new CancelledError();
    const navigation = activeOperation?.runId === runId && navigationResult();
    if (navigation) throw Object.assign(new Error(navigation.msg), navigation);
  }

  function sleep(ms, runId) {
    assertActive(runId);
    // wait 自行限制 30 秒；repeat 的合法周期可达 60 秒，不能在公共等待中截短。
    const duration = Math.min(60000, Math.max(0, Number(ms) || 0));
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        try { assertActive(runId); } catch (error) { reject(error); return; }
        const remaining = duration - (performance.now() - started);
        if (remaining <= 0) resolve();
        else setTimeout(tick, Math.min(100, remaining));
      };
      tick();
    });
  }

  function waitForStable(runId, maxWait = 3000, quiet = 350) {
    assertActive(runId);
    return new Promise((resolve, reject) => {
      if (!document.body) { resolve(); return; }
      let quietTimer;
      let deadline;
      let abortTimer;
      const observer = new MutationObserver(scheduleQuiet);
      function cleanup() {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(deadline);
        clearInterval(abortTimer);
      }
      function done() {
        cleanup();
        try { assertActive(runId); resolve(); } catch (error) { reject(error); }
      }
      function scheduleQuiet() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quiet);
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      deadline = setTimeout(done, maxWait);
      quietTimer = setTimeout(done, quiet);
      abortTimer = setInterval(() => {
        try { assertActive(runId); } catch (error) { cleanup(); reject(error); }
      }, 100);
    });
  }

  function rootsFrom(root) {
    const roots = [root];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) if (node.shadowRoot) roots.push(...rootsFrom(node.shadowRoot));
    return roots;
  }

  function queryDeep(selector) {
    for (const root of rootsFrom(document)) {
      const element = root.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function isHidden(el) {
    if (!(el instanceof Element)) return false;
    if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'tooltip' || el.hidden) return true;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
    if (style.display === 'contents') return false;
    if (el.checkVisibility) {
      try { return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch {}
    }
    return el.getClientRects().length === 0;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return el.type !== 'hidden';
    if (['select', 'textarea', 'button', 'summary'].includes(tag)) return true;
    if (tag === 'a') return !!(el.getAttribute('href') || cleanText(el.textContent));
    const role = (el.getAttribute('role') || '').toLowerCase();
    return INTERACTIVE_ROLES.has(role)
      || el.hasAttribute('onclick')
      || (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false');
  }

  function visibleText(node, max = 120, coveredText = null) {
    const parts = [];
    let length = 0;
    function visit(current) {
      if (!current || isSensitive(current) || length >= max) return;
      for (const child of current.childNodes || []) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = cleanText(child.textContent, max);
          if (text && text !== parts.at(-1)) {
            const offset = length + (parts.length ? 3 : 0);
            if (coveredText && offset < max) {
              coveredText.set(child, Math.max(coveredText.get(child) || 0, Math.min(text.length, max - offset)));
            }
            parts.push(text);
            length = offset + text.length;
          }
        } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName.toLowerCase()) && !isHidden(child)) {
          visit(child);
          if (child.shadowRoot) visit(child.shadowRoot);
        }
      }
    }
    visit(node);
    return safeSlice(parts.join(' · '), max);
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title');
    if (aria) return cleanText(aria, 60);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const text = labelledBy.split(/\s+/).map((id) => visibleText(root.getElementById?.(id) || document.getElementById(id), 60)).join(' ');
      if (cleanText(text)) return cleanText(text, 60);
    }
    if (el.labels?.length) return visibleText(el.labels[0], 60);
    const parent = el.closest('label');
    if (parent) return visibleText(parent, 60);
    return cleanText(el.placeholder || el.name || el.id, 60);
  }

  function choiceTarget(element) {
    const target = element.tagName === 'LABEL' ? targetForLabel(element) || element : element;
    return ['checkbox', 'radio', 'option'].includes(element.getAttribute('role'))
      || (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) ? target : null;
  }

  // 身份文字不随滚动、焦点或选中样式的可见性改变，也不含字段的可变值。
  function identityText(element) {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && !(node instanceof ShadowRoot)) return;
      if (node instanceof Element && (SKIP_TAGS.has(node.tagName.toLowerCase())
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || node.isContentEditable)) return;
      for (const child of node.childNodes) visit(child);
      if (node.shadowRoot) visit(node.shadowRoot);
    };
    visit(element);
    return cleanText(parts.join(' '), Infinity);
  }

  function optionPathOf(element) {
    const steps = [];
    let node = element;
    while (node && node !== document.body) {
      const parent = node.parentNode;
      if (!parent?.children) return null;
      const index = [...parent.children].indexOf(node);
      if (index < 0) return null;
      steps.push({ tag: node.tagName, role: node.getAttribute('role') || '', id: node.id, index });
      if (parent instanceof ShadowRoot) { steps.push({ shadow: true }); node = parent.host; }
      else node = parent;
    }
    return node === document.body ? steps.reverse() : null;
  }

  function optionAt(path) {
    if (!path?.length) return null;
    let node = document.body;
    for (const step of path) {
      if (step.shadow) { node = node?.shadowRoot; if (!node) return null; continue; }
      // index 是全部 children 的下标，不能在 tag/role 过滤后再取一次下标。
      const next = node?.children?.[step.index];
      if (!next || next.tagName !== step.tag || (next.getAttribute('role') || '') !== step.role || next.id !== step.id) return null;
      node = next;
    }
    return node instanceof Element ? node : null;
  }

  const CHOICE_SELECTOR = 'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"]';
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,legend';

  function optionContextText(element) {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return; }
      if (!(node instanceof Element)) return;
      const role = node.getAttribute('role');
      if (SKIP_TAGS.has(node.tagName.toLowerCase()) || ['INPUT', 'TEXTAREA', 'SELECT', 'OUTPUT', 'PROGRESS'].includes(node.tagName)
        || node.isContentEditable || node.hasAttribute('aria-live') || ['status', 'timer', 'progressbar', 'alert', 'log'].includes(role)
        || choiceTarget(node)) return;
      for (const child of node.childNodes) visit(child);
    };
    // 页级容器只取标题；进度等全局状态不能成为每一道题的身份。
    if (['MAIN', 'BODY', 'HTML'].includes(element.tagName)) {
      for (const heading of element.querySelectorAll(HEADING_SELECTOR)) parts.push(identityText(heading));
    } else visit(element);
    const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => element.getRootNode().getElementById?.(id)).filter(Boolean).map(identityText);
    return JSON.stringify([element.getAttribute('aria-label') || '', labelled, cleanText(parts.join(' '), Infinity)]);
  }

  function optionContext(element) {
    const scopes = [];
    let parent = element.parentElement || element.getRootNode().host;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      scopes.push({ element: parent, path: optionPathOf(parent), text: optionContextText(parent) });
      const container = parent.parentElement;
      const peer = container && [...container.children].some((sibling) => sibling !== parent
        && !choiceTarget(sibling) && sibling.querySelector(CHOICE_SELECTOR));
      // 沿任意层包装找到题干/语义分组或重复题块边界，不越界读入整张试卷状态。
      if (parent.matches('section,article,fieldset') || parent.querySelector(HEADING_SELECTOR) || peer) break;
      parent = parent.parentElement || parent.getRootNode().host;
    }
    return scopes;
  }

  function optionContextMatches(record) {
    return record.scopes.every((scope) => {
      const current = scope.element.isConnected ? scope.element : optionAt(scope.path);
      return current && optionContextText(current) === scope.text;
    });
  }

  function optionRecordOf(element) {
    const target = choiceTarget(element);
    if (!target) return null;
    return { path: optionPathOf(element), fingerprint: fingerprintOf(element), targetFingerprint: fingerprintOf(target), target,
      controlValue: target instanceof HTMLInputElement ? target.value : null,
      labelFor: element.getAttribute('for'), scopes: optionContext(element) };
  }

  function optionMatches(element, record) {
    const target = element && choiceTarget(element);
    return !!target && fingerprintOf(element) === record.fingerprint && fingerprintOf(target) === record.targetFingerprint
      && (target === record.target || !(target instanceof HTMLInputElement) || target.value === record.controlValue)
      && element.getAttribute('for') === record.labelFor && optionContextMatches(record);
  }

  function targetForLabel(label) {
    // label.control follows the label's own tree, including an enclosing Shadow root.
    return label instanceof HTMLLabelElement ? label.control : null;
  }

  function readState(el) {
    const target = el.tagName === 'LABEL' ? targetForLabel(el) || el : el;
    const tag = target.tagName.toLowerCase();
    if (isSensitive(target)) return (target.value || (target.isContentEditable && target.textContent)) ? '已有敏感内容（已隐藏）' : '当前为空';
    if (tag === 'input' && ['checkbox', 'radio'].includes(target.type)) return target.checked ? '已选中' : '未选中';
    if (tag === 'select') return `当前选项=${cleanText(target.selectedOptions[0]?.textContent || target.value, 60)}`;
    if (tag === 'input' || tag === 'textarea') return target.value ? `当前值="${cleanText(target.value, 80)}"` : '当前为空';
    if (target.isContentEditable) return target.textContent.trim() ? `当前内容="${cleanText(target.textContent, 80)}"` : '当前为空';
    const aria = target.getAttribute('aria-checked');
    if (aria != null) return aria === 'true' ? '已选中' : '未选中';
    return '';
  }

  function descriptionOf(el, ref, coveredText = null) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const usesText = !['input', 'textarea', 'select'].includes(tag) && !el.isContentEditable && role !== 'textbox';
    const text = visibleText(el, 80, usesText ? coveredText : null) || labelOf(el);
    if (tag === 'input') {
      if (['checkbox', 'radio'].includes(el.type)) return `[${ref}] 选项「${labelOf(el)}」 类型:${el.type === 'radio' ? '单选' : '复选'} ${el.checked ? '已选中' : '未选'}`;
      return `[${ref}] 输入框(${el.type}) 标签:${labelOf(el)} ${readState(el)}`;
    }
    if (tag === 'textarea') return `[${ref}] 文本域 标签:${labelOf(el)} ${readState(el)}`;
    if (tag === 'select') {
      if (isSensitive(el)) return `[${ref}] 下拉框 标签:${labelOf(el)} ${readState(el)}（敏感选项已隐藏）`;
      const options = [...el.options].slice(0, 100).map((option) => `${cleanText(option.textContent, 30)}(value=${cleanText(option.value, 30)})`).join(' | ');
      return `[${ref}] 下拉框 标签:${labelOf(el)} ${readState(el)}\n    选项: ${options.slice(0, 1600)}`;
    }
    if (tag === 'button' || role === 'button') return `[${ref}] 按钮「${text}」`;
    if (tag === 'a' || role === 'link') return `[${ref}] 链接「${text}」`;
    if (tag === 'summary') return `[${ref}] 折叠面板「${text}」`;
    if (el.isContentEditable || role === 'textbox') return `[${ref}] 富文本输入区 标签:${labelOf(el)} ${readState(el)}`;
    return `[${ref}] ${role || '可交互'}「${text}」${readState(el) ? ` ${readState(el)}` : ''}`;
  }

  function directText(el, max = 2000) {
    const text = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(' ');
    return cleanText(text, max);
  }

  // 目标身份指纹：只含稳定特征（标签/类型/角色/名称/文字），刻意排除 checked、value 等会被操作改变的属性。
  // 用于执行前逐目标核验：若编号指向的节点已被复用成别的内容（乱序页常见），据指纹不符判定失效，避免点错。
  function fingerprintOf(el) {
    if (el === document.body || el === document.documentElement) return el === document.body ? 'body' : 'html';
    const tag = el.tagName.toLowerCase();
    if (tag === 'label') return `label|${safeSlice(identityText(el), 120)}`;
    if (tag === 'input') return `input|${String(el.type || '').toLowerCase()}|${cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || el.name || el.id || '')}`;
    if (tag === 'textarea') return `textarea|${cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || el.name || el.id || '')}`;
    if (tag === 'select') return `select|${labelOf(el)}`;
    const role = (el.getAttribute('role') || '').toLowerCase();
    // 富文本的正文也是可变值，不能把本批合法输入当作节点身份变化。
    if (el.isContentEditable || role === 'textbox') return `${tag}|${role}|${labelOf(el)}`;
    const text = visibleText(el, 120) || labelOf(el);
    let href = '';
    if (tag === 'a' || role === 'link') {
      const raw = el.getAttribute('href');
      if (raw != null) {
        try { href = new URL(raw, document.baseURI).href; }
        catch { href = raw.trim(); }
      }
    }
    return `${tag}|${role}|${text}|${href}`;
  }

  // Candidate enumeration never reads pixels or fetches URLs. Pixels are requested separately.
  const IMAGE_POLICY = Object.freeze({ count: 3, candidates: 300, pixels: 16000000, edge: 1024, encoded: 524288, totalEncoded: 1048576, timeout: 8000 });
  let activeImageRead = null;

  function imageIdentity(el) {
    const img = el.tagName === 'IMG';
    return JSON.stringify([img ? el.currentSrc || el.src : '', img ? el.naturalWidth : el.width,
      img ? el.naturalHeight : el.height, el.getAttribute('src'), el.getAttribute('srcset'), el.getAttribute('sizes')]);
  }

  function nearbyImageText(root) {
    if (!root) return '';
    let text = '';
    let nodes = 0;
    const visit = (node) => {
      if (++nodes > 60 || text.length >= 400) return;
      if (node.nodeType === Node.TEXT_NODE) { text += ` ${node.textContent.slice(0, 400 - text.length)}`; return; }
      if (node.nodeType !== Node.ELEMENT_NODE || isSensitive(node)
        || ['INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE'].includes(node.tagName) || node.isContentEditable || isHidden(node)) return;
      for (const child of node.childNodes) { if (nodes >= 60 || text.length >= 400) break; visit(child); }
    };
    visit(root);
    return cleanText(text, 180);
  }

  function imageCandidate(el, id) {
    const rect = el.getBoundingClientRect();
    const img = el.tagName === 'IMG';
    const nearby = el.closest('figure,li,p,label') || el.parentElement || el.getRootNode().host;
    return {
      id, kind: img ? 'img' : 'canvas', width: img ? el.naturalWidth : el.width,
      height: img ? el.naturalHeight : el.height, displayWidth: Math.round(rect.width), displayHeight: Math.round(rect.height),
      x: Math.round(rect.left), y: Math.round(rect.top),
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
      alt: cleanText(el.getAttribute('alt') || el.getAttribute('aria-label') || el.title, 180),
      nearby: nearbyImageText(nearby),
      decorative: el.getAttribute('role') === 'presentation' || (img && el.getAttribute('alt') === ''),
    };
  }

  function validateImageRead(message) {
    if (cancelledRuns.has(message.runId)) return errorResult('CANCELLED', '任务已取消');
    if (!frozenSnapshot || frozenSnapshot.runId !== message.runId || currentSnapshotId !== message.snapshotId
      || currentSnapshotUrl !== location.href) return errorResult('STALE_SNAPSHOT', '图片快照已失效');
    if (!frozenSnapshot.allowImages || message.allowImages !== true) return errorResult('VISION_DISABLED', '当前模型未启用图片能力');
    if (!Array.isArray(message.ids) || message.ids.length < 1 || message.ids.length > IMAGE_POLICY.count
      || new Set(message.ids).size !== message.ids.length
      || message.ids.some((id) => !Number.isSafeInteger(id) || !frozenSnapshot.deliveredImages.has(id))) {
      return errorResult('INVALID_IMAGE', '只能读取当前快照已经展示的1至3个图片编号');
    }
    return null;
  }

  function verifyImage(message, id) {
    const invalid = validateImageRead(message);
    if (invalid) return invalid;
    const candidate = frozenSnapshot.imageMap.get(id);
    if (!candidate?.element.isConnected || isHidden(candidate.element)
      || imageIdentity(candidate.element) !== candidate.identity) return errorResult('STALE_IMAGE', '图片节点或来源已变化，请重新读取页面');
    return { ok: true, candidate };
  }

  async function readImages(message) {
    const invalid = validateImageRead(message);
    if (invalid) return invalid;
    if (executing || extracting || activeImageRead) return errorResult('BUSY', '页面正在处理另一项请求');
    const controller = new AbortController();
    activeImageRead = { runId: message.runId, controller };
    const deadline = performance.now() + IMAGE_POLICY.timeout;
    const timer = setTimeout(() => controller.abort('TIMEOUT'), IMAGE_POLICY.timeout);
    const results = [];
    let encoded = 0;
    const assertImageActive = () => {
      assertActive(message.runId);
      if (performance.now() >= deadline) controller.abort('TIMEOUT');
      if (controller.signal.aborted) throw Object.assign(new Error('图片读取已取消或超时'), { code: controller.signal.reason || 'CANCELLED' });
    };
    try {
      for (const id of message.ids) {
        assertImageActive();
        const verified = verifyImage(message, id);
        if (!verified.ok) { results.push({ id, ...verified }); continue; }
        const { element: el } = verified.candidate;
        const width = el.tagName === 'IMG' ? el.naturalWidth : el.width;
        const height = el.tagName === 'IMG' ? el.naturalHeight : el.height;
        if (width * height > IMAGE_POLICY.pixels || Math.max(width, height) > 32768) {
          results.push({ id, ...errorResult('PIXEL_LIMIT', '图片解码像素超出上限') }); continue;
        }
        if (!width || !height || (el.tagName === 'IMG' && !el.complete)) {
          results.push({ id, ...errorResult('IMAGE_NOT_READY', '图片尚未加载完成') }); continue;
        }
        const copy = document.createElement('canvas');
        try {
          const scale = Math.min(1, IMAGE_POLICY.edge / Math.max(width, height));
          copy.width = Math.max(1, Math.round(width * scale));
          copy.height = Math.max(1, Math.round(height * scale));
          copy.getContext('2d').drawImage(el, 0, 0, copy.width, copy.height);
          const blob = await new Promise((resolve, reject) => {
            const onAbort = () => { cleanup(); reject(Object.assign(new Error('图片读取已取消或超时'), { code: controller.signal.reason || 'CANCELLED' })); };
            const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
            controller.signal.addEventListener('abort', onAbort, { once: true });
            try { copy.toBlob((value) => { cleanup(); resolve(value); }, 'image/jpeg', 0.8); }
            catch (error) { cleanup(); reject(error); }
          });
          assertImageActive();
          const after = verifyImage(message, id);
          if (!after.ok) { results.push({ id, ...after }); continue; }
          if (!blob) throw new Error('图片编码失败');
          const size = 23 + 4 * Math.ceil(blob.size / 3);
          if (size > IMAGE_POLICY.encoded || encoded + size > IMAGE_POLICY.totalEncoded) {
            results.push({ id, ...errorResult('ENCODED_LIMIT', '图片编码后体积超出上限') }); continue;
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          assertImageActive();
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          encoded += size;
          results.push({ id, ok: true, dataUrl: `data:image/jpeg;base64,${btoa(binary)}` });
        } catch (error) {
          assertImageActive();
          const after = verifyImage(message, id);
          if (!after.ok) results.push({ id, ...after });
          else if (error.name === 'SecurityError' && el.tagName === 'IMG' && /^https?:/.test(el.currentSrc)) {
            // Only the trusted currentSrc of this selected candidate may be fetched by the background.
            results.push({ id, ok: false, code: 'FETCH_REQUIRED', source: el.currentSrc });
          } else results.push({ id, ...errorResult(error.code || 'IMAGE_UNREADABLE', '图片不可读取或canvas已被跨域内容污染') });
        } finally { copy.width = 0; copy.height = 0; }
      }
      assertImageActive();
      return { snapshotId: message.snapshotId, results };
    } catch (error) {
      return errorResult(error.code || 'CANCELLED', error.message);
    } finally {
      clearTimeout(timer);
      activeImageRead = null;
    }
  }

  async function buildSnapshot(runId, maxLen = 32000, includeImages = false, continuation = null) {
    assertActive(runId);
    const previous = frozenSnapshot;
    if (continuation && (!previous || previous.runId !== runId || previous.snapshotId !== continuation
      || currentSnapshotUrl !== location.href || !previous.cursor || continuationStamp() !== previous.continuationVersion
      || previous.navigationEpoch !== navigationEpoch || pageStateSignature() !== previous.signature)) {
      throw Object.assign(new Error('续读失败：页面已变化或续读位置失效，请重新开始'), { code: 'STALE_CONTINUATION' });
    }
    // Snapshot construction collects metadata only; image reads never rebuild refs.
    await waitForStable(runId, 1000, 150);
    assertActive(runId);
    const shadowRoots = rootsFrom(document).slice(1);
    if (continuation && (continuationStamp() !== previous.continuationVersion || location.href !== previous.url
      || shadowRoots.length !== previous.shadowRoots.length || shadowRoots.some((root, i) => root !== previous.shadowRoots[i]))) {
      throw Object.assign(new Error('续读失败：页面内容已变化，请重新开始'), { code: 'STALE_CONTINUATION' });
    }
    for (const root of shadowRoots) continuationObserver.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    refMap.clear();
    refFingerprints.clear();
    labelControls.clear();
    optionRecords.clear();
    // 重建期间旧快照立即失效：若 walk 中途抛错，绝不让旧编号解析到新元素
    currentSnapshotId = '';
    frozenSnapshot = null;
    const mappedControls = new Set();
    const coveredText = new Map(); // Normalized text prefixes already included in target titles.
    const segmentLimit = Math.min(50000, Math.max(1000, Number(maxLen) || 32000));
    const totalLimit = 512000; // UTF-16 代码单元，非 token
    const nodeLimit = 30000;
    const segments = [{ text: '', targets: {}, targetMeta: {}, imageCandidates: [] }];
    const imageMap = new Map();
    let omittedImages = false;
    let total = 0;
    let nodes = 0;
    let currentNode = 0;
    let cursor = null;
    const start = continuation ? previous.cursor : { node: 1, offset: 0 };
    let truncated = '';
    let ref = lastRef;
    let segment = segments[0];
    const nextSegment = () => { segment = { text: '', targets: {}, targetMeta: {}, imageCandidates: [] }; segments.push(segment); };
    const append = (line, atomicTitle = false) => {
      if (!line || truncated || currentNode < start.node) return false;
      const initialOffset = currentNode === start.node ? start.offset : 0;
      line = line.slice(initialOffset);
      if (!line) return true;
      const prefixLength = segment.text || (currentNode === start.node && start.prefix) ? 1 : 0;
      let remaining = (prefixLength ? '\n' : '') + line;
      let consumed = 0;
      if (atomicTitle && segment.text && segmentLimit - segment.text.length < line.split('\n')[0].length + 1) {
        nextSegment();
        remaining = line;
      }
      while (remaining) {
        if (segment.text.length === segmentLimit && total < totalLimit) nextSegment();
        let size = Math.min(remaining.length, segmentLimit - segment.text.length, totalLimit - total);
        if (size && size < remaining.length && /[\uD800-\uDBFF]/.test(remaining[size - 1]) && /[\uDC00-\uDFFF]/.test(remaining[size])) size--;
        if (!size) {
          // 总预算只剩一个代码单元时不能切开代理对，也不能反复创建空段。
          if (totalLimit - total < 2) {
            truncated = '达到快照总量上限';
            cursor = { node: currentNode, offset: initialOffset + Math.max(0, consumed - prefixLength), prefix: prefixLength > 0 && consumed === 0 };
            return false;
          }
          nextSegment();
          continue;
        }
        segment.text += remaining.slice(0, size);
        total += size;
        consumed += size;
        remaining = remaining.slice(size);
      }
      return true;
    };
    const addTarget = (el, describe = (id) => descriptionOf(el, id, coveredText)) => {
      const target = el.tagName === 'LABEL' ? targetForLabel(el) || el : el;
      if (mappedControls.has(target)) return;
      mappedControls.add(target);
      const id = ref + 1;
      // Rebuild coverage before the continuation cursor too, so a long control's
      // remaining text uses the same offsets in every window.
      let description = describe(id);
      if (currentNode < start.node) return;
      const title = description.split('\n')[0];
      if (title.length > segmentLimit || totalLimit - total < title.length + (segment.text ? 1 : 0)) {
        truncated = '达到快照总量上限，后续目标未知';
        cursor = { node: currentNode, offset: 0 };
        return;
      }
      // 控件标题及其详情同段登记；详情过长明确提示省略。
      if (description.length > segmentLimit) {
        const omitted = ' …（选项已省略）';
        description = safeSlice(description, segmentLimit - omitted.length) + omitted;
      }
      if (segment.text && segment.text.length + 1 + description.length > segmentLimit) nextSegment();
      if (totalLimit - total < description.length + (segment.text ? 1 : 0)) {
        truncated = '达到快照总量上限，后续目标未知';
        cursor = { node: currentNode, offset: 0 };
        return;
      }
      if (!append(description, true)) return;
      lastRef = ref = id;
      refMap.set(id, el);
      refFingerprints.set(id, fingerprintOf(el));
      if (el.tagName === 'LABEL') labelControls.set(id, target);
      const optionRecord = optionRecordOf(el);
      if (optionRecord) optionRecords.set(id, optionRecord);
      segment.targets[id] = description;
      const tagName = target.tagName.toLowerCase();
      const inputType = tagName === 'input' || tagName === 'button' ? String(target.type || '').toLowerCase() : '';
      if (!targetIdentities.has(target)) targetIdentities.set(target, `${documentId}:target:${++lastTargetIdentity}`);
      segment.targetMeta[id] = {
        identity: targetIdentities.get(target),
        tag: el.tagName === 'LABEL' ? 'label' : tagName,
        type: inputType,
        role: (target.getAttribute('role') || '').toLowerCase(),
        inForm: !!(target.form || target.closest('form')),
        submitsForm: target instanceof HTMLFormElement
          || (tagName === 'button' && (!inputType || inputType === 'submit'))
          || (tagName === 'input' && ['submit', 'image'].includes(inputType)),
        sensitive: isSensitive(target),
      };
    };
    const walk = (root, controlsOnly = false) => {
      for (const el of root.childNodes || []) {
        if (truncated) return;
        currentNode = ++nodes;
        if (nodes - start.node >= nodeLimit) { truncated = '达到遍历节点上限'; cursor = { node: currentNode, offset: 0 }; return; }
        if (el.nodeType === Node.TEXT_NODE) {
          if (!controlsOnly) append(cleanText(el.textContent, Infinity).slice(coveredText.get(el) || 0));
          continue;
        }
        if (el.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const style = getComputedStyle(el);
        if (isHidden(el) && style.display !== 'contents') continue;
        if (tag === 'iframe') {
          if (!controlsOnly) append(`嵌入页面: ${cleanText(el.title || el.src, 120)}（跨域内容可能无法读取）`);
          continue;
        }
        if (includeImages && currentNode >= start.node && (tag === 'img' || tag === 'canvas')) {
          if (imageMap.size < IMAGE_POLICY.candidates) {
            const id = imageMap.size + 1;
            const candidate = imageCandidate(el, id);
            const line = `图片候选 ${JSON.stringify(candidate)}`;
            if (segment.text && segment.text.length + line.length + 1 > segmentLimit) nextSegment();
            if (line.length <= segmentLimit && totalLimit - total >= line.length + (segment.text ? 1 : 0) && append(line, true)) {
              imageMap.set(id, { element: el, identity: imageIdentity(el) });
              segment.imageCandidates.push(candidate);
            } else {
              truncated = '达到快照总量上限，后续图片候选未知'; cursor = { node: currentNode, offset: 0 }; return;
            }
          } else omittedImages = true;
        }
        if (tag === 'label') {
          // 隐藏原生 input 的组件仍通过 label 操作；同一控件只发一个 ref。
          const controlled = targetForLabel(el);
          const isToggle = controlled instanceof HTMLInputElement && ['checkbox', 'radio'].includes(controlled.type);
          const own = isToggle ? visibleText(el, 60, coveredText) : '';
          if (isToggle) {
            addTarget(el, (id) => `[${id}] 选项「${cleanText(own, 60)}」 类型:${controlled.type === 'radio' ? '单选' : '复选'} ${controlled.checked ? '已选中' : '未选'}`);
            walk(el, false);
            if (el.shadowRoot) walk(el.shadowRoot, false);
            continue;
          }
        }
        if (isInteractive(el)) {
          addTarget(el);
          // Only omit text prefixes actually shown in a title; keep tails and
          // continue enumerating native/Shadow controls independently.
          if (!isSensitive(el) && !['select', 'textarea'].includes(tag)) {
            walk(el, false);
            if (el.shadowRoot) walk(el.shadowRoot, false);
          }
          continue;
        }
        if (tag === 'label') {
          walk(el, false);
          if (el.shadowRoot) walk(el.shadowRoot, false);
          continue;
        } else if (!controlsOnly && tag === 'li' && !el.children.length) {
          const own = directText(el, Infinity);
          if (own && own.length <= 120) {
            addTarget(el, (id) => `[${id}] 列表项「${own}」`);
            continue;
          }
        }
        walk(el, controlsOnly);
        if (el.shadowRoot) walk(el.shadowRoot, controlsOnly);
      }
    };
    if (document.body) walk(document.body);
    currentSnapshotUrl = location.href;
    currentSnapshotMutationVersion = mutationVersion;
    currentSnapshotId = `${documentId}:${++snapshotEpoch}:${currentSnapshotMutationVersion}`;
    const signature = pageStateSignature();
    frozenSnapshot = {
      runId, snapshotId: currentSnapshotId, url: currentSnapshotUrl, title: document.title,
      segments, deliveredRefs: new Set(), imageMap, deliveredImages: new Set(), allowImages: includeImages,
      omittedImages, truncated, totalChars: total, cursor,
      continuationVersion: continuationStamp(), shadowRoots, navigationEpoch, signature,
    };
    return readFrozenSegment(runId, currentSnapshotId, 0, true);
  }

  function readFrozenSegment(runId, snapshotId, index, internal = false) {
    if (cancelledRuns.has(runId)) return errorResult('CANCELLED', '任务已取消');
    if (!frozenSnapshot || runId !== frozenSnapshot.runId || snapshotId !== currentSnapshotId || currentSnapshotUrl !== location.href) {
      return errorResult('STALE_SNAPSHOT', '快照已失效或不属于当前任务，请重新读取页面');
    }
    if (!internal && (executing || extracting)) return errorResult('BUSY', '页面正在处理另一项请求');
    if (!Number.isSafeInteger(index) || index < 0 || index >= frozenSnapshot.segments.length) return errorResult('INVALID_SEGMENT', '分段编号超出范围');
    const item = frozenSnapshot.segments[index];
    Object.keys(item.targets).forEach((id) => frozenSnapshot.deliveredRefs.add(Number(id)));
    item.imageCandidates.forEach(({ id }) => frozenSnapshot.deliveredImages.add(id));
    return {
      snapshotId, url: frozenSnapshot.url, title: frozenSnapshot.title, index,
      segmentCount: frozenSnapshot.segments.length, totalChars: frozenSnapshot.totalChars,
      truncated: frozenSnapshot.truncated, canContinue: !!frozenSnapshot.cursor, signature: frozenSnapshot.signature,
      text: item.text, targets: item.targets, targetMeta: item.targetMeta,
      imageCandidates: item.imageCandidates, omittedImages: frozenSnapshot.omittedImages,
    };
  }

  function waitForSelector(selector, timeout, runId) {
    return new Promise((resolve, reject) => {
      let observer;
      let timer;
      let poll;
      function cleanup() { observer?.disconnect(); clearTimeout(timer); clearInterval(poll); }
      function inspect() {
        try {
          assertActive(runId);
          const found = queryDeep(selector);
          if (found) { cleanup(); resolve(found); }
        } catch (error) { cleanup(); reject(error); }
      }
      try {
        assertActive(runId);
        const found = queryDeep(selector);
        if (found) { resolve(found); return; }
      } catch (error) { reject(error); return; }
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      poll = setInterval(inspect, 100);
      timer = setTimeout(() => {
        cleanup();
        try { assertActive(runId); resolve(null); } catch (error) { reject(error); }
      }, Math.min(30000, Math.max(0, timeout)));
    });
  }

  async function resolveTarget(action, runId, options = {}) {
    let element;
    let optionRecord;
    if (action.ref != null) {
      const ref = Number(action.ref);
      if (!frozenSnapshot?.deliveredRefs.has(ref)) return { error: errorResult('TARGET_NOT_FOUND', `编号 ${action.ref} 未在当前快照中提供，请重新读取页面`) };
      element = refMap.get(ref);
      optionRecord = optionRecords.get(ref);
      if (optionRecord) {
        if (!element?.isConnected) element = optionAt(optionRecord.path);
        if (!optionMatches(element, optionRecord)) return { error: errorResult('STALE_TARGET', `编号 ${action.ref} 的题目、选项内容或关联控件已变化，请重新读取页面`) };
        // 只接受当前快照中同题同选项的等价重绘，随后派发阶段仍固定这次解析的节点。
        refMap.set(ref, element);
        if (element.tagName === 'LABEL') labelControls.set(ref, targetForLabel(element) || element);
      }
    } else if (action.selector) {
      try { element = queryDeep(String(action.selector)) || await waitForSelector(String(action.selector), 3000, runId); }
      catch (error) {
        if (typeof error.code === 'string') throw error;
        return { error: errorResult('INVALID_SELECTOR', `选择器语法错误: ${action.selector}`) };
      }
    }
    assertActive(runId);
    if (!element) return { error: errorResult('TARGET_NOT_FOUND', action.ref != null ? `编号 ${action.ref} 不存在或已过期` : '找不到目标元素') };
    if (!element.isConnected) return { error: errorResult('STALE_TARGET', '目标元素已被页面移除') };
    if (action.ref != null && options.verifyFingerprint !== false) {
      const recorded = refFingerprints.get(Number(action.ref));
      if (recorded && fingerprintOf(element) !== recorded) return { error: errorResult('STALE_TARGET', `编号 ${action.ref} 的目标内容已变化，请重新读取页面`) };
      if (element.tagName === 'LABEL' && labelControls.has(Number(action.ref)) && (targetForLabel(element) || element) !== labelControls.get(Number(action.ref))) {
        return { error: errorResult('STALE_TARGET', `编号 ${action.ref} 关联的控件已变化，请重新读取页面`) };
      }
    }
    if (!options.allowHidden && isHidden(element)) return { error: errorResult('TARGET_HIDDEN', '目标元素当前不可见') };
    const target = element.tagName === 'LABEL' ? targetForLabel(element) || element : element;
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { error: errorResult('TARGET_DISABLED', '目标元素已禁用') };
    return bindTarget(element, runId, optionRecord);
  }

  function bindTarget(element, runId, optionRecord = null) {
    const target = element.tagName === 'LABEL' ? targetForLabel(element) || element : element;
    const recorded = fingerprintOf(element);
    const targetRecorded = fingerprintOf(target);
    const anchor = element.closest('a');
    const linkRecorded = anchor && fingerprintOf(anchor);
    const form = target.form || target.closest('form');
    const formIdentity = () => form ? `${form.action}|${form.method}|${form.target}|${target.getAttribute('formaction') || ''}|${target.getAttribute('formmethod') || ''}` : '';
    const formRecorded = formIdentity();
    const verify = (click = false) => {
      assertActive(runId);
      if (!element.isConnected || !target.isConnected || fingerprintOf(element) !== recorded
          || fingerprintOf(target) !== targetRecorded
          || (element.tagName === 'LABEL' && (targetForLabel(element) || element) !== target)
          || (optionRecord && !optionContextMatches(optionRecord))
          || (target.form || target.closest('form')) !== form || formIdentity() !== formRecorded
          || (click && (element.closest('a') !== anchor || (anchor && fingerprintOf(anchor) !== linkRecorded)))) {
        throw Object.assign(new Error('目标身份在操作准备期间变化，请重新读取页面'), { code: 'STALE_TARGET' });
      }
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') {
        throw Object.assign(new Error('目标元素已禁用'), { code: 'TARGET_DISABLED' });
      }
      if (click) safeLink(element);
    };
    return { element, target, verify };
  }

  function setNativeValue(el, value, emitChange = true, verify = () => {}) {
    const next = String(value ?? '');
    if (el.value === next) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('目标不支持设置值');
    verify();
    setter.call(el, next);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    if (emitChange) { verify(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  }

  function safeLink(element) {
    const anchor = element.tagName === 'A' ? element : element.closest('a');
    if (!anchor) return null;
    const href = anchor.getAttribute('href') || '';
    const protocol = new URL(href, document.baseURI).protocol;
    if (['javascript:', 'data:', 'vbscript:'].includes(protocol)) throw new Error('已阻止不安全链接');
    return anchor;
  }

  async function clickOnce(element, runId, verify, detail = 1, visualElement = element) {
    verify(true);
    visualElement.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(TIMING.paint, runId);
    verify(true);
    const anchor = safeLink(element);
    const originalTarget = anchor?.getAttribute('target');
    if (anchor && /^_blank$/i.test(originalTarget || '')) anchor.setAttribute('target', '_self');
    try {
      const rect = visualElement.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail, clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
      // 每个前置事件都可能同步复用/移除节点或发起导航，不能只在整串事件前检查一次。
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        verify(true);
        if (type.startsWith('pointer')) {
          if (window.PointerEvent) element.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        } else element.dispatchEvent(new MouseEvent(type, init));
      }
      await sleep(TIMING.event, runId);
    } finally {
      // 页面可能在点击串中移除并稍后重挂 anchor；无条件恢复，避免 target=_self 永久泄漏
      if (anchor) {
        if (originalTarget == null) anchor.removeAttribute('target');
        else anchor.setAttribute('target', originalTarget);
      }
    }
  }

  function pageSignature() {
    return `${location.href}|${cleanText(document.body?.innerText, 1000)}`;
  }

  function pageStateSignature() {
    let hash = 2166136261;
    const mix = (text) => { for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); };
    const fields = [];
    const visit = (root) => {
      if (!root?.querySelectorAll) return;
      for (const el of root.querySelectorAll('input,textarea,select')) fields.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    const signatureText = (document.body?.innerText || '').slice(0, 2000000);
    mix(signatureText);
    visit(document);
    for (const el of fields) mix(`${el.value}|${el.checked}|${el.selectedIndex}|`);
    return `${signatureText.length}:${fields.length}:${hash >>> 0}`;
  }

  async function performPress(element, value, runId, verify) {
    const requested = String(value || '').trim();
    const aliases = { esc: 'Escape', space: ' ', enter: 'Enter', tab: 'Tab', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', backspace: 'Backspace', delete: 'Delete' };
    const key = aliases[requested.toLowerCase()] || requested;
    if (!key || key.length > 20) return errorResult('INVALID_KEY', '按键名称无效');
    verify();
    element.focus?.();
    verify();
    const init = { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true, composed: true };
    const proceed = element.dispatchEvent(new KeyboardEvent('keydown', init));
    verify();
    if (proceed) {
      if (key === 'Enter') {
        // 浏览器原生行为：textarea/富文本内 Enter 是换行而不是提交表单
        if (element instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, element.value + '\n');
          element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertLineBreak', data: '\n' }));
        } else if (element.isContentEditable) {
          // fill 后无选区，光标通常在开头：先把选区折叠到末尾再插入换行
          const selection = getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          try { document.execCommand('insertText', false, '\n'); } catch {}
        } else {
          const form = element.form || element.closest?.('form');
          if (form?.requestSubmit) form.requestSubmit();
        }
      } else if (key === ' ' && element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        element.click();
      } else if (key === 'Tab') {
        const focusable = [...document.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter((item) => !isHidden(item) && !item.disabled && item.tabIndex >= 0);
        const index = focusable.indexOf(element);
        focusable[(index + 1) % focusable.length]?.focus();
      }
    }
    assertActive(runId);
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    await sleep(TIMING.settle, runId);
    return { ok: true, msg: `已按键 ${requested}`, state: readState(element) };
  }

  async function typeText(element, value, runId, verify) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
    if (element instanceof HTMLInputElement && element.type === 'file') return errorResult('NOT_EDITABLE', '文件上传暂不支持，请手动选择文件');
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    const text = String(value ?? '');
    verify();
    element.scrollIntoView({ block: 'center' });
    verify();
    element.focus();
    verify();
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    if (!element.isContentEditable && element.value === text) return { ok: true, code: 'NO_CHANGE', msg: '目标已是指定内容', state: readState(element) };
    if (element.isContentEditable) {
      if (element.textContent === text) return { ok: true, code: 'NO_CHANGE', msg: '目标已是指定内容', state: readState(element) };
      element.textContent = '';
    } else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, '');
    }
    for (const char of text) {
      verify();
      const down = element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true, composed: true }));
      verify();
      if (down) {
        if (element.isContentEditable) element.textContent += char;
        else Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set?.call(element, element.value + char);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
      }
      verify();
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true, composed: true }));
      await sleep(12, runId);
    }
    verify();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, msg: '已逐字输入', state: readState(element) };
  }

  function isNavigationResult(result) {
    return ['NAVIGATING', 'NAVIGATED'].includes(result?.code);
  }

  function skippedAfterNavigation() {
    const result = errorResult('SKIPPED_AFTER_NAVIGATION', '页面正在或已经跳转，本批剩余操作已跳过');
    const operation = activeOperation;
    if (operation?.navigationUrl) result.navigationUrl = operation.navigationUrl;
    else if (operation && location.href !== operation.startUrl) result.navigationUrl = location.href;
    return result;
  }

  async function executeAction(action, runId, depth = 0, approved = false) {
    try {
      const result = await performAction(action, runId, depth, approved);
      return isNavigationResult(result) ? result : navigationResult() || result;
    } catch (error) {
      if (isNavigationResult(error)) return navigationResult();
      if (error.code === 'STALE_TARGET') return errorResult(error.code, error.message);
      throw error;
    }
  }

  async function performAction(action, runId, depth, approved) {
    assertActive(runId);
    if (!action || typeof action !== 'object' || !ACTIONS.has(action.action)) return errorResult('UNKNOWN_ACTION', `未知操作: ${action?.action || '(空)'}`);
    if (action.action === 'wait') {
      const timeout = Math.min(30000, Math.max(0, Number(action.value ?? 800)));
      if (action.selector) {
        let element;
        try { element = await waitForSelector(String(action.selector), timeout, runId); }
        catch (error) {
          if (typeof error.code === 'string') throw error;
          return errorResult('INVALID_SELECTOR', '等待选择器语法错误');
        }
        return element ? { ok: true, msg: '元素已出现' } : errorResult('WAIT_TIMEOUT', '等待元素超时');
      }
      await sleep(timeout, runId);
      return { ok: true, msg: `已等待 ${Math.round(timeout)}ms` };
    }
    if (action.action === 'repeat') {
      if (depth > 0) return errorResult('NESTED_REPEAT', 'repeat 不允许嵌套');
      const times = Number(action.times);
      const interval = Number(action.value ?? 1000);
      if (!Number.isInteger(times) || times < 1 || times > 100 || !Number.isFinite(interval) || interval < 0 || interval > 60000) return errorResult('INVALID_REPEAT', 'repeat 参数无效');
      if (!Array.isArray(action.actions) || !action.actions.length || action.actions.some((item) => item?.action === 'repeat')) return errorResult('INVALID_REPEAT', 'repeat 子操作无效');
      const summaries = [];
      for (let index = 0; index < times; index++) {
        assertActive(runId);
        const started = performance.now();
        const roundResults = [];
        for (let subIndex = 0; subIndex < action.actions.length; subIndex++) {
          const result = await executeAction(action.actions[subIndex], runId, depth + 1, approved);
          roundResults.push(result);
          summaries.push(`第${index + 1}轮:${result.msg || result.error || ''}`);
          if (isNavigationResult(result)) {
            for (let rest = subIndex + 1; rest < action.actions.length; rest++) roundResults.push(skippedAfterNavigation());
            return { ...result, msg: `循环执行 ${index + 1}/${times} 轮后因导航停止`, results: roundResults };
          }
          if (!result.ok && !RECOVERABLE_TARGET_ERRORS.has(result.code)) {
            for (let rest = subIndex + 1; rest < action.actions.length; rest++) roundResults.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作失败，已跳过'));
            return { ...errorResult(result.code || 'REPEAT_FAILED', `循环在第 ${index + 1} 轮停止：${result.msg || result.error}`), results: roundResults };
          }
        }
        const failed = roundResults.find((result) => !result.ok);
        if (failed) return { ...errorResult(failed.code, `循环第 ${index + 1} 轮存在失败目标，有效目标已执行，请核对结果`), results: roundResults };
        if (index < times - 1) await sleep(Math.max(0, interval - (performance.now() - started)), runId);
      }
      return { ok: true, msg: `已按 ${Math.round(interval)}ms 周期循环 ${times} 轮。${summaries.slice(-2).join('；').slice(0, 240)}` };
    }
    if (action.action === 'navigate') {
      let url;
      try { url = new URL(String(action.value || ''), location.href); } catch { return errorResult('INVALID_URL', '跳转地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol)) return errorResult('UNSAFE_URL', 'navigate 仅支持 http(s) 地址');
      if (location.href === url.href) return { ok: true, code: 'NO_CHANGE', msg: '已在目标页面' };
      location.assign(url.href);
      activeOperation.navigationStarted = true;
      activeOperation.navigationUrl = url.href;
      return { ok: true, code: 'NAVIGATING', navigationUrl: url.href, msg: `正在跳转到 ${url.href}` };
    }
    if (action.action === 'scroll') {
      let target = document.scrollingElement || document.documentElement;
      if (action.ref != null || action.selector) {
        const resolved = await resolveTarget(action, runId, { allowHidden: true });
        if (resolved.error) return resolved.error;
        resolved.verify();
        target = resolved.element;
      }
      assertActive(runId);
      const value = action.value;
      if (value === 'top') target.scrollTo({ top: 0, behavior: 'smooth' });
      else if (value === 'bottom') target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
      else target.scrollBy({ top: Number(value) || 400, behavior: 'smooth' });
      await waitForStable(runId, 2500, 350);
      const top = Math.round(target === document.scrollingElement ? window.scrollY : target.scrollTop);
      const height = target.scrollHeight;
      const viewport = target === document.scrollingElement ? innerHeight : target.clientHeight;
      return { ok: true, msg: `已滚动：位置 ${top}/${height}px${top + viewport >= height - 2 ? '，已到底部' : ''}` };
    }

    let resolved;
    if (action.action === 'press' && action.ref == null && !action.selector) resolved = bindTarget(document.activeElement || document.body, runId);
    else resolved = await resolveTarget(action, runId);
    if (resolved.error) return resolved.error;
    const { element, target, verify } = resolved;
    if (TARGET_ACTIONS.has(action.action) && !element) return errorResult('MISSING_TARGET', '操作缺少目标');
    verify();

    const tagName = target.tagName.toLowerCase();
    const inputType = tagName === 'input' || tagName === 'button' ? String(target.type || '').toLowerCase() : '';
    const submitsForm = target instanceof HTMLFormElement
      || (tagName === 'button' && (!inputType || inputType === 'submit'))
      || (tagName === 'input' && ['submit', 'image'].includes(inputType));
    const enterSubmits = action.action === 'press' && String(action.value || '').trim().toLowerCase() === 'enter' && !!(target.form || target.closest?.('form'));
    if (!approved && (action.action === 'submitForm' || enterSubmits || (['click', 'dblclick'].includes(action.action) && submitsForm))) {
      return errorResult('APPROVAL_REQUIRED', '此操作可能提交表单，必须先获得用户确认');
    }

    if (action.action === 'press') return performPress(target, action.value, runId, verify);
    if (action.action === 'hover') {
      element.scrollIntoView({ block: 'center' });
      verify();
      const rect = element.getBoundingClientRect();
      const init = { bubbles: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      if (window.PointerEvent) element.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
      verify();
      element.dispatchEvent(new MouseEvent('mouseover', init));
      verify();
      element.dispatchEvent(new MouseEvent('mousemove', init));
      await waitForStable(runId, 2000, 300);
      return { ok: true, msg: '已悬停目标' };
    }
    if (action.action === 'check' || action.action === 'checkRadio') {
      const checkbox = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? target : null;
      // 原生控件以 checked 为准（aria 可能与实际状态脱节）；仅非原生 ARIA 控件才信 aria-checked
      if (checkbox?.checked || (!checkbox && target.getAttribute('aria-checked') === 'true')) return { ok: true, code: 'NO_CHANGE', msg: '目标已选中', state: '已选中' };
      // label 引用时 target 是其内部 input，直接点 input 保证原生翻转与 change 事件
      await clickOnce(checkbox || element, runId, verify, 1, element);
      const record = action.ref != null && optionRecords.get(Number(action.ref));
      const observedElement = element.isConnected ? element : record && optionAt(record.path);
      if (record && !optionMatches(observedElement, record)) return errorResult('STALE_TARGET', '点击后题目或选项身份已变化，请重新读取页面核对实际状态');
      const observed = observedElement && (choiceTarget(observedElement) || observedElement);
      const checked = observed instanceof HTMLInputElement ? observed.checked : observed?.getAttribute('aria-checked') === 'true';
      if (!checked) return errorResult('CHECK_NOT_APPLIED', '点击后目标仍未选中，页面可能阻止了合成点击，请重新读取页面或手动选择');
      return { ok: true, msg: '已选中目标', state: readState(observedElement) };
    }
    if (action.action === 'click') {
      const before = pageSignature();
      // 复选/单选目标直接点 input，避免合成点击 label 时激活行为不生效导致翻转失败
      const toggle = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type);
      // 预记链接目标：原生导航触发 beforeunload 时 URL 尚未提交，让跳过结果能带上 navigationUrl
      try {
        const anchor = element.closest('a');
        const href = anchor?.getAttribute('href');
        if (href) activeOperation.navigationUrl = new URL(href, document.baseURI).href;
      } catch {}
      try { await clickOnce(toggle ? target : element, runId, verify, 1, element); }
      catch (error) {
        if (typeof error.code === 'string') throw error;
        return errorResult('CLICK_BLOCKED', error.message);
      }
      await waitForStable(runId, 2500, 350);
      return { ok: true, msg: `已点击${pageSignature() !== before ? '，页面已更新' : ''}`, state: element.isConnected ? readState(element) : '页面已更新' };
    }
    if (action.action === 'dblclick') {
      const before = pageSignature();
      await clickOnce(element, runId, verify, 1);
      await clickOnce(element, runId, verify, 2);
      verify(true);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      await waitForStable(runId, 2000, 350);
      return { ok: true, msg: `已双击${pageSignature() !== before ? '，页面已更新' : ''}`, state: element.isConnected ? readState(element) : '页面已更新' };
    }
    if (action.action === 'type') return typeText(target, action.value, runId, verify);
    if (action.action === 'fill') {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
      if (target instanceof HTMLInputElement && target.type === 'file') return errorResult('NOT_EDITABLE', '文件上传暂不支持，请手动选择文件');
      if (target.readOnly) return errorResult('READ_ONLY', '目标为只读');
      target.scrollIntoView({ block: 'center' });
      verify();
      target.focus();
      verify();
      if (target.readOnly) return errorResult('READ_ONLY', '目标为只读');
      const next = String(action.value ?? '');
      let changed = false;
      if (target.isContentEditable) {
        changed = target.textContent !== next;
        if (changed) {
          target.textContent = next;
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: next }));
          verify();
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else changed = setNativeValue(target, next, true, verify);
      assertActive(runId);
      target.blur();
      await sleep(TIMING.event, runId);
      return { ok: true, code: changed ? 'FILLED' : 'NO_CHANGE', msg: changed ? '已填写目标' : '目标已是指定内容', state: readState(target) };
    }
    if (action.action === 'select') {
      if (!(target instanceof HTMLSelectElement)) return errorResult('NOT_SELECT', 'select 仅支持原生下拉框');
      // 多选下拉 value 传数组；标量赋值会清掉其余已选项
      if (Array.isArray(action.value) && !target.multiple) return errorResult('INVALID_VALUE', '单选下拉不支持数组 value，请传单个选项');
      const requestedList = Array.isArray(action.value) ? action.value.map((item) => String(item ?? '')) : [String(action.value ?? '')];
      if (!requestedList.length || requestedList.includes('')) return errorResult('OPTION_NOT_FOUND', '选项不存在');
      const hits = [];
      for (const requested of requestedList) {
        const exact = [...target.options].filter((option) => option.value === requested || option.textContent.trim() === requested);
        const prefix = exact.length ? [] : [...target.options].filter((option) => option.textContent.trim().startsWith(requested));
        const hit = exact[0] || (prefix.length === 1 ? prefix[0] : null);
        if (!hit) return errorResult('OPTION_NOT_FOUND', prefix.length > 1 ? '选项前缀不唯一' : '选项不存在');
        if (!hits.includes(hit)) hits.push(hit);
      }
      if (target.multiple) {
        const signatureOf = () => [...target.selectedOptions].map((option) => option.value).join('\u0000');
        const before = signatureOf();
        verify();
        for (const option of target.options) option.selected = hits.includes(option);
        const changed = before !== signatureOf();
        if (changed) {
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, code: changed ? 'SELECTED' : 'NO_CHANGE', msg: changed ? (isSensitive(target) ? '已选择敏感选项（已隐藏）' : `已选择 ${hits.length} 项`) : '已是指定选项', state: readState(target) };
      }
      const hit = hits[0];
      const changed = setNativeValue(target, hit.value, true, verify);
      return { ok: true, code: changed ? 'SELECTED' : 'NO_CHANGE', msg: changed ? (isSensitive(target) ? '已选择敏感选项（已隐藏）' : `已选择「${cleanText(hit.textContent, 60)}」`) : '已是指定选项', state: readState(target) };
    }
    if (action.action === 'submitForm') {
      const form = target instanceof HTMLFormElement ? target : target.form || target.closest('form');
      if (!form) {
        await clickOnce(element, runId, verify);
        await waitForStable(runId, 3500, 500);
        return { ok: true, msg: '已点击提交目标' };
      }
      target.scrollIntoView({ block: 'center' });
      verify();
      // 预记表单提交目标，供原生导航的跳过结果携带 navigationUrl
      try {
        const formAction = form.getAttribute('action');
        activeOperation.navigationUrl = new URL(formAction || location.href, document.baseURI).href;
      } catch {}
      // novalidate 表单本就不做约束校验，requestSubmit 会跳过；不能替它拦下
      const skipValidation = form.novalidate === true || target.getAttribute?.('formnovalidate') != null;
      const valid = skipValidation || form.reportValidity();
      verify();
      if (!valid) return errorResult('FORM_INVALID', '表单校验未通过，未提交');
      const submitter = (target instanceof HTMLButtonElement && target.type === 'submit')
        || (target instanceof HTMLInputElement && ['submit', 'image'].includes(target.type)) ? target : undefined;
      if (form.requestSubmit) {
        if (submitter) form.requestSubmit(submitter);
        else form.requestSubmit();
      } else form.submit();
      await waitForStable(runId, 3500, 500);
      return { ok: true, msg: '已提交表单' };
    }
    return errorResult('UNKNOWN_ACTION', `未知操作: ${action.action}`);
  }

  function pruneCache() {
    while (operationCache.size > 100) operationCache.delete(operationCache.keys().next().value);
  }

  async function executeBatch(message) {
    if (!message.runId || !message.operationId || !message.snapshotId) return { results: [errorResult('INVALID_REQUEST', '缺少 runId、operationId 或 snapshotId')] };
    if (message.snapshotId !== currentSnapshotId || currentSnapshotUrl !== location.href || message.runId !== frozenSnapshot?.runId
      || frozenSnapshot.navigationEpoch !== navigationEpoch) {
      return { results: [errorResult('STALE_SNAPSHOT', '页面已跳转或快照已重建，请重新读取页面')] };
    }
    if (!Array.isArray(message.actions) || message.actions.length < 1 || message.actions.length > 20) return { results: [errorResult('INVALID_ACTIONS', '操作数量必须为 1-20')] };
    if (executing || extracting || activeImageRead) return { results: [errorResult('BUSY', '页面正在处理另一项请求')] };
    assertActive(message.runId);
    activeRunId = message.runId;
    executing = true;
    const operation = { runId: message.runId, startUrl: location.href, navigationStarted: false };
    activeOperation = operation;
    // 仅观察本次 operation；不阻断卸载、不改页面 API，finally 必须卸下监听。
    // 页面脚本可合成 beforeunload 事件伪造导航跳过整批操作，必须只信浏览器派发的可信事件。
    const onBeforeUnload = (event) => {
      if (event.isTrusted !== true) return;
      if (activeOperation === operation) operation.navigationStarted = true;
    };
    addEventListener('beforeunload', onBeforeUnload, true);
    const results = [];
    try {
      for (let index = 0; index < message.actions.length; index++) {
        assertActive(message.runId);
        try {
          const result = await executeAction(message.actions[index], message.runId, 0, message.approved === true); // 完全访问权限：background 恒发 approved=true
          results.push(result);
          if (isNavigationResult(result)) {
            for (let rest = index + 1; rest < message.actions.length; rest++) results.push(skippedAfterNavigation());
            break;
          }
          if (!result.ok && !RECOVERABLE_TARGET_ERRORS.has(result.code)) {
            for (let rest = index + 1; rest < message.actions.length; rest++) results.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作失败，已跳过'));
            break;
          }
        } catch (error) {
          if (isNavigationResult(error)) throw error;
          const code = error.code || (error.name === 'CancelledError' ? 'CANCELLED' : 'ACTION_ERROR');
          results.push(errorResult(code, error.message || String(error)));
          for (let rest = index + 1; rest < message.actions.length; rest++) results.push(errorResult('SKIPPED_AFTER_FAILURE', '前序操作中止，已跳过'));
          break;
        }
        if (index < message.actions.length - 1) await sleep(TIMING.settle, message.runId);
      }
      // beforeunload 后 URL 仍可能是旧页；绝不能返回旧文档快照。
      if (navigationResult() || results.some(isNavigationResult)) return { results };
      let page;
      try { page = await buildSnapshot(message.runId, 32000, message.includeImages === true); }
      catch (error) {
        if (isNavigationResult(error)) throw error;
        if (error.name === 'CancelledError') return { results };
        // 已发生的点击不能被后续观察异常抹掉；后台可独立重读，不能重放整批。
        return { results, observationError: errorResult('EXTRACT_ERROR', '操作已执行，但读取操作后页面失败，请重新读取页面') };
      }
      assertActive(message.runId);
      return { results, page };
    } catch (error) {
      // 导航也可能发生于批间等待或最终快照等待，把边界归到最后一个已执行动作。
      if (!isNavigationResult(error)) throw error;
      if (results.length) Object.assign(results.at(-1), navigationResult());
      else results.push(navigationResult());
      while (results.length < message.actions.length) results.push(skippedAfterNavigation());
      return { results };
    } finally {
      removeEventListener('beforeunload', onBeforeUnload, true);
      if (activeOperation === operation) activeOperation = null;
      executing = false;
      if (activeRunId === message.runId) activeRunId = '';
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ABORT' || message.type === 'CANCEL_IMAGES') {
      if (activeImageRead?.runId === message.runId) activeImageRead.controller.abort('CANCELLED');
      if (message.type === 'CANCEL_IMAGES') {
        if (message.disable === true && frozenSnapshot?.runId === message.runId) frozenSnapshot.allowImages = false;
        sendResponse({ ok: true }); return;
      }
      if (message.runId) cancelledRuns.add(message.runId);
      if (cancelledRuns.size > 100) cancelledRuns.delete(cancelledRuns.values().next().value);
      return;
    }
    if (message.type === 'READ_IMAGES') {
      readImages(message).then(sendResponse, (error) => sendResponse(errorResult(error.code || 'IMAGE_UNREADABLE', error.message)));
      return true;
    }
    if (message.type === 'VERIFY_IMAGES') {
      const invalid = validateImageRead(message);
      sendResponse(invalid || { snapshotId: message.snapshotId, results: message.ids.map((id) => {
        const result = verifyImage(message, id);
        return result.ok ? { id, ok: true } : { id, ...result };
      }) });
      return;
    }
    if (message.type === 'READ_SEGMENT') {
      sendResponse(readFrozenSegment(message.runId, message.snapshotId, message.index));
      return;
    }
    if (message.type === 'EXTRACT') {
      if (!message.runId) { sendResponse(errorResult('INVALID_REQUEST', '缺少 runId')); return; }
      if (executing || extracting || activeImageRead) { sendResponse(errorResult('BUSY', '页面正在处理另一项请求')); return; }
      activeRunId = message.runId;
      extracting = true;
      (async () => {
        try {
          await waitForStable(message.runId, 1500, 250);
          return await buildSnapshot(message.runId, message.maxLen, message.includeImages === true, message.continueSnapshotId || null);
        } finally {
          extracting = false;
          if (activeRunId === message.runId) activeRunId = '';
        }
      })().then(sendResponse, (error) => sendResponse(errorResult(error.code || 'EXTRACT_ERROR', error.message || String(error))));
      return true;
    }
    if (message.type === 'EXECUTE') {
      const key = String(message.operationId || '');
      if (key && operationCache.has(key)) {
        operationCache.get(key).then(sendResponse);
        return true;
      }
      const pending = executeBatch(message).catch((error) => ({ results: [errorResult(error.code || 'EXECUTE_ERROR', error.message || String(error))] }));
      if (key) {
        operationCache.set(key, pending);
        pruneCache();
        // 幂等缓存只该钉住「已执行」的结果：未执行成功的瞬态结局在结算后清除，允许同 operationId 重试；
        // 成功结果也剥掉整页快照，避免缓存长期驻留大对象。
        pending.then((result) => {
          const code = result?.results?.[0]?.code;
          if (['INVALID_REQUEST', 'STALE_SNAPSHOT', 'INVALID_ACTIONS', 'BUSY', 'EXECUTE_ERROR', 'CANCELLED'].includes(code)) operationCache.delete(key);
          else if (result?.page) operationCache.set(key, Promise.resolve({ results: result.results }));
        }).catch(() => {});
      }
      pending.then(sendResponse);
      return true;
    }
  });
})();
