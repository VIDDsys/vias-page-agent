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
  const choiceIdentities = new WeakMap();
  let lastTargetIdentity = 0;
  let lastChoiceIdentity = 0;
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
        } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName.toLowerCase()) && !isHidden(child) && !isSensitive(child)) {
          // The host and its shadow tree share the same sensitivity gate.
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

  function isIdentityState(element) {
    // aria-live 也用于宣布动态题干，不能单凭它丢弃整块身份文字。
    return ['OUTPUT', 'PROGRESS'].includes(element.tagName)
      || ['status', 'timer', 'progressbar', 'alert', 'log'].includes(element.getAttribute('role'));
  }

  // 身份文字不随滚动、焦点或选中样式的可见性改变，也不含字段值和语义状态提示。
  function identityText(element) {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && !(node instanceof ShadowRoot)) return;
      if (node instanceof Element && (SKIP_TAGS.has(node.tagName.toLowerCase()) || isIdentityState(node)
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
      if (!(node instanceof Element) && !(node instanceof ShadowRoot)) return;
      if (node instanceof Element && (SKIP_TAGS.has(node.tagName.toLowerCase()) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)
        || node.isContentEditable || isIdentityState(node) || choiceTarget(node))) return;
      for (const child of node.childNodes) visit(child);
      if (node.shadowRoot) visit(node.shadowRoot);
    };
    // 页级容器只取标题；进度等全局状态不能成为每一道题的身份。
    if (['MAIN', 'BODY', 'HTML'].includes(element.tagName)) {
      for (const heading of element.querySelectorAll(HEADING_SELECTOR)) parts.push(identityText(heading));
      if (element.shadowRoot) visit(element.shadowRoot);
    } else visit(element);
    const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => element.getRootNode().getElementById?.(id)).filter(Boolean).map(identityText);
    return JSON.stringify([element.getAttribute('aria-label') || '', labelled, cleanText(parts.join(' '), Infinity)]);
  }

  function optionContext(element) {
    const scopes = [];
    let parent = element.parentElement || element.getRootNode().host;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const text = optionContextText(parent);
      scopes.push({ element: parent, path: optionPathOf(parent), text });
      const container = parent.parentElement;
      const choices = new Set([...parent.querySelectorAll(CHOICE_SELECTOR)].map(choiceTarget).filter(Boolean));
      const hasPrompt = [...parent.childNodes].some((node) => node.nodeType === Node.TEXT_NODE ? !!cleanText(node.textContent)
        : node instanceof Element && !choiceTarget(node) && !node.querySelector(CHOICE_SELECTOR) && !!identityText(node));
      const namedGroup = parent.matches('[role="group"],[role="radiogroup"],[role="listbox"]')
        && !!(parent.getAttribute('aria-label') || parent.getAttribute('aria-labelledby'));
      const peer = (namedGroup || ((choices.size > 1 || parent.querySelector(HEADING_SELECTOR)) && hasPrompt)) && container
        && !container.matches('ul,ol,[role="list"],[role="listbox"],[role="radiogroup"]')
        && [...container.children].some((sibling) => sibling !== parent
          && !choiceTarget(sibling) && sibling.querySelector(CHOICE_SELECTOR));
      // 选项内的说明标题不证明已经包含题干；继续至语义题块或独立的同级题块。
      if (parent.matches('section,article,fieldset') || peer) break;
      parent = parent.parentElement || parent.getRootNode().host;
    }
    return scopes;
  }

  // 原生字段的身份只取控件自身与显式语义上下文：labels、aria-labelledby 由调用方另取，
  // 这里只取最近的题块/字段集标题。表单区块里的联想词、热搜、隐藏计数等可变文本
  // 不属于字段身份，否则自动补全一出现就会被误判为控件变化。
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  function fieldContextText(element) {
    const parts = [];
    const headingOf = (block) => {
      for (const child of block.children) {
        if (child.tagName === 'LEGEND' || HEADING_TAGS.has(child.tagName)) return child;
      }
      const nested = block.matches('SECTION,ARTICLE') ? block.querySelector('h1,h2,h3,h4,h5,h6') : null;
      return nested && nested.closest('section,article') === block ? nested : null;
    };
    let parent = element.parentElement || element.getRootNode().host;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const heading = headingOf(parent);
      if (heading) {
        const text = identityText(heading);
        if (text) parts.push(`${heading.tagName}|${text}`);
      }
      // 找到最近的显式题块（标题/legend/语义分组）即停，不把整页容器文字拉进字段身份。
      if (heading || parent.matches('FIELDSET,SECTION,ARTICLE,[role="group"],[role="radiogroup"]')) break;
      parent = parent.parentElement || parent.getRootNode().host;
    }
    return JSON.stringify(parts);
  }

  function withinScope(element, scope) {
    for (let current = element; current; current = current.parentElement || current.getRootNode().host) {
      if (current === scope) return true;
    }
    return false;
  }

  function optionContextMatches(record, element = null) {
    return record.scopes.every((scope) => {
      const current = scope.element.isConnected ? scope.element : optionAt(scope.path);
      return current?.ownerDocument === document && (!element || withinScope(element, current))
        && optionContextText(current) === scope.text;
    });
  }

  function choiceFormIdentity(form) {
    return form ? JSON.stringify([form.id, form.getAttribute('name'), form.action, form.method, form.target]) : '';
  }

  function optionRecordOf(element) {
    const target = choiceTarget(element);
    if (!target) return null;
    const form = target.form || target.closest('form');
    const anchor = element.closest('a');
    return { path: optionPathOf(element), fingerprint: fingerprintOf(element), targetFingerprint: fingerprintOf(target), target,
      controlValue: target instanceof HTMLInputElement ? target.value : null,
      labelFor: element.getAttribute('for'), scopes: optionContext(element),
      form, formPath: form && optionPathOf(form), formIdentity: choiceFormIdentity(form),
      anchor, anchorPath: anchor && optionPathOf(anchor), anchorFingerprint: anchor && fingerprintOf(anchor) };
  }

  function choiceIdentityOf(record) {
    // 原始题干/标签/提交值只留内容脚本内存，后台仅得到无内容的不透明语义 token。
    const signature = JSON.stringify([record.fingerprint, record.targetFingerprint, record.controlValue, record.labelFor,
      record.scopes.map((scope) => scope.text), record.formIdentity, record.anchorFingerprint]);
    let identity = choiceIdentities.get(record.target);
    if (!identity || identity.signature !== signature) {
      identity = { signature, token: `${documentId}:choice:${++lastChoiceIdentity}` };
      choiceIdentities.set(record.target, identity);
    }
    return identity.token;
  }

  function optionMatches(element, record) {
    const target = element && choiceTarget(element);
    if (!target || !element.isConnected || !target.isConnected || element.ownerDocument !== document || target.ownerDocument !== document) return false;
    const form = target.form || target.closest('form');
    const anchor = element.closest('a');
    return fingerprintOf(element) === record.fingerprint && fingerprintOf(target) === record.targetFingerprint
      // radio/checkbox value 是选项身份，即使原节点未替换也必须核验。
      && (!(target instanceof HTMLInputElement) || target.value === record.controlValue)
      && element.getAttribute('for') === record.labelFor && optionContextMatches(record, element)
      && choiceFormIdentity(form) === record.formIdentity
      && (form === record.form || (!record.form?.isConnected && optionAt(record.formPath) === form))
      && (anchor === record.anchor || (!record.anchor?.isConnected && optionAt(record.anchorPath) === anchor))
      && (!anchor || fingerprintOf(anchor) === record.anchorFingerprint);
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
    if (tag === 'select') {
      if (!target.multiple) return `当前选项=${cleanText(target.selectedOptions[0]?.textContent || target.value, 60)}`;
      const selected = [...target.selectedOptions];
      const shown = [];
      let length = 0;
      for (const option of selected) {
        const text = `${cleanText(option.textContent, 30)}(value=${cleanText(option.value, 30)})`;
        if (shown.length >= 50 || length + text.length + (shown.length ? 3 : 0) > 400) break;
        length += text.length + (shown.length ? 3 : 0);
        shown.push(text);
      }
      return `当前选项=${shown.join(' | ') || '(无)'}（多选，已选${selected.length}项${selected.length > shown.length ? `，其余${selected.length - shown.length}项已省略` : ''}）`;
    }
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

  function selectOptionIdentity(option) {
    return JSON.stringify([option.value, option.textContent, option.label, option.disabled,
      option.parentElement?.tagName === 'OPTGROUP' ? [option.parentElement.label, option.parentElement.disabled] : null]);
  }

  // 排除 checked、普通字段 value 等可变状态；radio/checkbox 的 value 属于选项身份。
  // 标签、题目上下文及下拉选项在读取时冻结，不能到派发时才接受新身份。
  function fingerprintOf(el) {
    if (el === document.body || el === document.documentElement) return el === document.body ? 'body' : 'html';
    const tag = el.tagName.toLowerCase();
    const choice = choiceTarget(el);
    if (choice) {
      const native = choice instanceof HTMLInputElement;
      const text = native && el === choice ? [...(choice.labels || [])].map(identityText).join(' ') : identityText(el);
      // 有真实标签时，ARIA 可增补选中/焦点提示；没有标签时仍以无障碍名称防止错认。
      return JSON.stringify([tag, el.getAttribute('role') || '', el.id, text || labelOf(el),
        native ? [choice.type, choice.id, choice.name, choice.value] : el.getAttribute('value')]);
    }
    if (tag === 'label') return `label|${safeSlice(identityText(el), 120)}`;
    if (['input', 'textarea', 'select'].includes(tag)) {
      const root = el.getRootNode();
      const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => root.getElementById?.(id) || document.getElementById(id)).filter(Boolean).map(identityText);
      // 按钮类 input 的 value 就是可见文字（如「百度一下」），属于控件身份；
      // 普通字段的 value 是可变状态，仍排除在指纹外以保证同批填写。
      const buttonValue = el instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image'].includes(el.type) ? el.value : null;
      return JSON.stringify([tag, el.type, el.id, el.name,
        ['aria-label', 'title', 'placeholder', 'aria-labelledby'].map((name) => el.getAttribute(name)),
        [...(el.labels || [])].map(identityText), labelled, fieldContextText(el), buttonValue,
        tag === 'select' ? [el.multiple, [...el.options].map(selectOptionIdentity)] : null]);
    }
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
        ...(optionRecord ? { choiceIdentity: choiceIdentityOf(optionRecord) } : {}),
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
        // isHidden already permits display:contents without a layout box;
        // semantic hiding must still suppress that element's entire subtree.
        if (isHidden(el)) continue;
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
      if (!element.isConnected || !target.isConnected || element.ownerDocument !== document || target.ownerDocument !== document
          || fingerprintOf(element) !== recorded || fingerprintOf(target) !== targetRecorded
          || (element.tagName === 'LABEL' && (targetForLabel(element) || element) !== target)
          || (optionRecord && !optionMatches(element, optionRecord))
          || (target.form || target.closest('form')) !== form || formIdentity() !== formRecorded
          || (click && (element.closest('a') !== anchor || (anchor && fingerprintOf(anchor) !== linkRecorded)))) {
        throw Object.assign(new Error('目标身份在操作准备期间变化，请重新读取页面'), { code: 'STALE_TARGET' });
      }
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') {
        throw Object.assign(new Error('目标元素已禁用'), { code: 'TARGET_DISABLED' });
      }
      if (click) safeLink(element);
    };
    const recoverChoice = optionRecord ? () => {
      assertActive(runId);
      // 只对快照内的选项恢复等价重绘；不重查 selector，不从其他题/其他文档搜索。
      if (element.ownerDocument !== document || target.ownerDocument !== document) {
        throw Object.assign(new Error('目标已移入其他文档，请重新读取页面'), { code: 'STALE_TARGET' });
      }
      const current = element.isConnected ? element : optionAt(optionRecord.path);
      if (!optionMatches(current, optionRecord)) {
        throw Object.assign(new Error('题目、选项或关联控件已变化，请重新读取页面'), { code: 'STALE_TARGET' });
      }
      return bindTarget(current, runId, optionRecord);
    } : null;
    return { element, target, verify, recoverChoice };
  }

  function setNativeValue(el, value, verify) {
    const next = String(value ?? '');
    if (el.value === next) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('目标不支持设置值');
    verify();
    setter.call(el, next);
    return true;
  }

  function normalizedFieldValue(element, value) {
    const text = String(value ?? '');
    if (element instanceof HTMLTextAreaElement) return text.replace(/\r\n?/g, '\n');
    if (element instanceof HTMLInputElement) {
      if (['text', 'search', 'tel', 'password', 'url', 'email'].includes(element.type)) {
        const line = text.replace(/[\r\n]/g, '');
        const trim = (part) => part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
        if (element.type === 'email' && element.multiple) return line.split(',').map(trim).join(',');
        if (element.type === 'url' || element.type === 'email') return trim(line);
        return line;
      }
      if (element.type === 'datetime-local') {
        // HTML normalizes valid local date/times to T and the shortest time.
        // A rejected nonempty request still expects nonempty text and must fail.
        const probe = document.createElement('input');
        probe.type = 'datetime-local';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(probe, text);
        return probe.value || text;
      }
    }
    // Do not accept a rejected/defaulted setter result as the expected value:
    // number/date rejection and range/color clamping remain observable failures.
    return text;
  }

  function valueNotApplied() {
    // Neither requested nor actual values belong in errors, including secrets.
    return errorResult('VALUE_NOT_APPLIED', '页面未保留完整的预期内容或选区，可能存在字段限制或页面回退；本批后续操作已停止，请重新读取并核对');
  }

  function targetReplacedDuringValue() {
    // 字段本身被页面替换/改身份时不能冒充“值没写进去”，否则会掩盖真实身份变化。
    return errorResult('STALE_TARGET', '目标在填写期间被页面替换或改变，请重新读取页面');
  }

  function exceedsFieldLimit(element, value) {
    return (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      && element.maxLength >= 0 && value.length > element.maxLength;
  }

  function fieldValueState(element) {
    return [element.isContentEditable ? element.textContent : element.value,
      typeof element.selectionStart === 'number' ? element.selectionStart : null,
      typeof element.selectionEnd === 'number' ? element.selectionEnd : null,
      element.selectionStart === element.selectionEnd ? 'none' : element.selectionDirection];
  }

  // fill/type 的成功依据是值本身：页面合法重置光标/选区不算填写失败。
  // 光标语义只由 press 的按键结果核验。
  function fieldValueOnly(element) {
    return [element.isContentEditable ? element.textContent : element.value];
  }

  function sameValueState(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function valueTargetObserver(target, verify, runId) {
    const path = optionPathOf(target);
    const identityOf = (element) => JSON.stringify([fingerprintOf(element), element.id, element.getAttribute('name'), labelOf(element),
      element.getAttribute('autocomplete'), element.getAttribute('aria-labelledby'), element.isContentEditable,
      element instanceof HTMLSelectElement ? element.multiple : null]);
    const identity = identityOf(target);
    const context = fieldContextText(target);
    const form = target.form || target.closest('form');
    const formPath = form && optionPathOf(form);
    const formIdentityOf = (element) => element ? JSON.stringify([element.id, element.getAttribute('name'), element.action, element.method, element.target]) : '';
    const formIdentity = formIdentityOf(form);
    // 返回 {target} 或 {stale:true}：身份变化与“值没保留”是两类不同结果。
    return () => {
      assertActive(runId);
      if (target.isConnected) {
        try { verify(); } catch (error) { if (error.code === 'STALE_TARGET' || error.code === 'TARGET_DISABLED') return { stale: true }; throw error; }
        return identityOf(target) === identity ? { target } : { stale: true };
      }
      // Recovery is read-only and only after writing. Never re-resolve a selector
      // to dispatch events or continue typing into a replacement node.
      const current = optionAt(path);
      if (!current || identityOf(current) !== identity || fieldContextText(current) !== context) return { stale: true };
      const currentForm = current.form || current.closest('form');
      if (formIdentityOf(currentForm) !== formIdentity || (form && currentForm !== form && (form.isConnected || optionAt(formPath) !== currentForm))) return { stale: true };
      return { target: current };
    };
  }

  function canContinueValueEvents(target, verify, runId) {
    assertActive(runId);
    if (!target.isConnected || target.readOnly) return false;
    try { verify(); return true; }
    catch (error) { if (error.code === 'STALE_TARGET' || error.code === 'TARGET_DISABLED') return false; throw error; }
  }

  async function confirmValueApplied(observe, read, expected, runId) {
    const started = performance.now();
    let stableSince = started;
    let previousTarget;
    let previousState;
    // Property-only rollbacks do not produce MutationObserver records. Poll the
    // complete value/selection as well as identity, allowing a bounded quiet period.
    while (performance.now() - started < 1200) {
      const current = observe();
      const target = current?.target || null;
      const state = target ? read(target) : [];
      if (target !== previousTarget || !previousState || !sameValueState(state, previousState)) {
        stableSince = performance.now(); previousTarget = target; previousState = state;
      }
      if (performance.now() - stableSince >= TIMING.settle) {
        if (!target) return { error: targetReplacedDuringValue() };
        return sameValueState(state, expected) ? { target } : { error: valueNotApplied() };
      }
      await sleep(40, runId);
    }
    return { error: previousTarget ? valueNotApplied() : targetReplacedDuringValue() };
  }

  function safeLink(element) {
    const anchor = element.tagName === 'A' ? element : element.closest('a');
    if (!anchor) return null;
    const href = anchor.getAttribute('href') || '';
    const protocol = new URL(href, document.baseURI).protocol;
    if (['javascript:', 'data:', 'vbscript:'].includes(protocol)) throw new Error('已阻止不安全链接');
    return anchor;
  }

  // stillNeeded 仅由 check 传入：等待绘制期间页面可能自行恢复选中，此时不能再点一次把它反选。
  async function clickOnce(element, runId, verify, detail = 1, visualElement = element, recoverChoice = null, stillNeeded = null) {
    const prepare = () => {
      if (recoverChoice) {
        const current = recoverChoice();
        visualElement = current.element;
        element = current.target instanceof HTMLInputElement ? current.target : current.element;
        verify = current.verify;
      }
      verify(true);
    };
    prepare();
    visualElement.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(TIMING.paint, runId);
    prepare();
    if (stillNeeded && !stillNeeded(element)) return false;
    const anchor = safeLink(element);
    const originalTarget = anchor?.getAttribute('target');
    if (anchor && /^_blank$/i.test(originalTarget || '')) anchor.setAttribute('target', '_self');
    try {
      const rect = visualElement.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail, clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
      // 每个前置事件都可能同步复用/移除节点或发起导航，不能只在整串事件前检查一次。
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        prepare();
        // Pointer handlers or equivalent redraws can satisfy check after paint.
        if (type === 'click' && stillNeeded && !stillNeeded(element)) return false;
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

  function pageStateSignature(root = document.body) {
    let hash = 2166136261;
    let nodes = 0;
    let targets = 0;
    let remaining = 2000000;
    const mix = (value, limit = 200000) => {
      const text = String(value ?? '').slice(0, Math.min(limit, remaining));
      remaining -= text.length;
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
      hash = Math.imul(hash ^ 0, 16777619); // Separate values, including absent/empty states.
    };
    const stateAttributes = ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-disabled', 'aria-readonly', 'aria-required', 'aria-invalid'];
    const visit = (node, clock = false) => {
      if (++nodes > 30000 || remaining <= 0) return;
      if (node.nodeType === Node.TEXT_NODE) {
        // Clock/timer ticks are not task progress. Keep ordinary content changes,
        // but ignore explicit timers and the seconds of standalone clock text.
        if (!clock) mix(cleanText(node.textContent, remaining).replace(/^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/, '[clock]'), remaining);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && !(node instanceof ShadowRoot)) return;
      if (node instanceof Element) {
        if (SKIP_TAGS.has(node.tagName.toLowerCase()) || isHidden(node)) return;
        clock ||= node.tagName === 'TIME' || node.getAttribute('role') === 'timer';
        const target = node.tagName === 'LABEL' ? targetForLabel(node) : node;
        if (target && (isInteractive(target) || target.hasAttribute('tabindex')) && targets < 4096) {
          targets++;
          mix(`${target.tagName}|${target.getAttribute('role') || ''}`);
          for (const name of stateAttributes) mix(target.getAttribute(name), 256);
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
            mix(target.value);
            mix(`${target.checked}|${target.indeterminate}|${target.disabled}|${target.readOnly}|${target.selectedIndex}`);
            // The first value/index alone cannot distinguish multi-select changes.
            if (target instanceof HTMLSelectElement) {
              for (const option of [...target.options].slice(0, 4096)) mix(option.selected ? '1' : '0');
            }
          }
          if (target.tagName === 'SUMMARY') mix(target.parentElement?.open);
        }
      }
      for (const child of node.childNodes) {
        if (nodes >= 30000 || remaining <= 0) break;
        visit(child, clock);
      }
      if (node.shadowRoot && nodes < 30000 && remaining > 0) visit(node.shadowRoot, clock);
    };
    if (root) visit(root);
    return `${targets}:${hash >>> 0}`;
  }

  function focusedElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element || document.body;
  }

  function textFieldState(element) {
    return JSON.stringify([element.value, element.selectionStart, element.selectionEnd, element.selectionStart === element.selectionEnd ? 'none' : element.selectionDirection]);
  }

  function textBoundary(text, offset, forward) {
    // Do not split emoji, surrogate pairs or combining characters when deleting/moving.
    let previous = 0;
    for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      if (forward && index + segment.length > offset) return index + segment.length;
      if (!forward && index >= offset) return previous;
      previous = index;
    }
    return forward ? text.length : previous;
  }

  function pressTextField(element, key, modifiers, verify) {
    const { shiftKey, ctrlKey, metaKey } = modifiers;
    const text = element.value;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if ((ctrlKey || metaKey) && key.toLowerCase() === 'a') {
      element.setSelectionRange(0, text.length, 'forward');
      verify();
      return null;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      const backward = element.selectionDirection === 'backward';
      const anchor = backward ? end : start;
      const focus = backward ? start : end;
      let next;
      if (key === 'Home') next = element instanceof HTMLTextAreaElement && !ctrlKey && !metaKey && focus > 0 ? text.lastIndexOf('\n', focus - 1) + 1 : 0;
      else if (key === 'End') {
        const newline = text.indexOf('\n', focus);
        next = element instanceof HTMLTextAreaElement && !ctrlKey && !metaKey && newline >= 0 ? newline : text.length;
      } else if (!shiftKey && start !== end) next = key === 'ArrowLeft' ? start : end;
      else next = textBoundary(text, focus, key === 'ArrowRight');
      element.setSelectionRange(shiftKey ? Math.min(anchor, next) : next, shiftKey ? Math.max(anchor, next) : next, shiftKey && next < anchor ? 'backward' : 'forward');
      verify();
      return null;
    }
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    let from = start;
    let to = end;
    let replacement = key === 'Enter' ? '\n' : key;
    let inputType = key === 'Enter' ? 'insertLineBreak' : 'insertText';
    if (key === 'Backspace' || key === 'Delete') {
      replacement = '';
      inputType = key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward';
      if (start === end) {
        if (key === 'Backspace') from = textBoundary(text, start, false);
        else to = textBoundary(text, end, true);
      }
    }
    if (from === to && !replacement) return errorResult('NO_EFFECT', '光标已在边界，没有可删除的内容');
    if (replacement && element.maxLength >= 0 && text.length - (to - from) + replacement.length > element.maxLength) return errorResult('NO_EFFECT', '输入将超过字段长度限制');
    const before = textFieldState(element);
    verify();
    const proceed = element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, data: replacement || null }));
    verify();
    if (!proceed) return errorResult('NO_EFFECT', '页面阻止了 beforeinput，未修改字段');
    if (focusedElement() !== element) return errorResult('NO_EFFECT', '页面在 beforeinput 中转移了焦点，未修改字段');
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    if (textFieldState(element) !== before) return errorResult('NO_EFFECT', '页面在 beforeinput 中改变了字段，请重新读取后操作');
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const next = text.slice(0, from) + replacement + text.slice(to);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, next);
    element.setSelectionRange(from + replacement.length, from + replacement.length);
    verify();
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data: replacement || null }));
    verify();
    if (element.value !== next || element.selectionStart !== from + replacement.length || element.selectionEnd !== from + replacement.length) return errorResult('NO_EFFECT', '页面未保留预期的字段值或选区，请重新读取后操作');
    return null;
  }

  async function performPress(element, value, runId, verify) {
    const requested = String(value ?? '').trim();
    if (!requested || requested.length > 60) return errorResult('INVALID_KEY', '按键名称无效');
    const parts = requested.length === 1 ? [requested] : requested.split('+');
    const rawKey = parts.pop();
    const modifiers = { shiftKey: false, ctrlKey: false, metaKey: false };
    for (const part of parts) {
      const modifier = { shift: 'shiftKey', ctrl: 'ctrlKey', control: 'ctrlKey', meta: 'metaKey' }[part.toLowerCase()];
      if (!modifier || modifiers[modifier]) return errorResult('UNSUPPORTED_KEY', '不支持此修饰键组合');
      modifiers[modifier] = true;
    }
    const aliases = { esc: 'Escape', escape: 'Escape', space: ' ', enter: 'Enter', tab: 'Tab', arrowdown: 'ArrowDown', arrowup: 'ArrowUp', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', backspace: 'Backspace', delete: 'Delete' };
    const key = aliases[rawKey.toLowerCase()] || rawKey;
    const command = modifiers.ctrlKey || modifiers.metaKey;
    const textField = element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'password'].includes(element.type));
    const textKey = textField && ((!command && ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key))
      || (command && ['Home', 'End'].includes(key)) || (command && !modifiers.shiftKey && key.toLowerCase() === 'a')
      || (!command && !modifiers.shiftKey && ([...key].length === 1 || (key === 'Enter' && element instanceof HTMLTextAreaElement))));
    const form = element.form || element.closest?.('form');
    const submitter = (element instanceof HTMLButtonElement && element.type === 'submit')
      || (element instanceof HTMLInputElement && ['submit', 'image'].includes(element.type)) ? element : null;
    const submit = !command && !modifiers.shiftKey && key === 'Enter' && form && (submitter
      || (element instanceof HTMLInputElement && !['button', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(element.type)));
    const toggle = !command && !modifiers.shiftKey && key === ' ' && element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
    const tab = !command && key === 'Tab';
    const custom = !textKey && !submit && !toggle && !tab;
    verify();
    element.focus?.();
    verify();
    if (focusedElement() !== element) return errorResult('NO_EFFECT', '目标未获得键盘焦点');
    // 动作前身份校验保持严格；一旦默认行为已派发（提交/选中），后续只做效果确认：
    // 页面在提交后改写文字、替换节点属于正常响应，不能再报“未执行”或继续派发到旧节点。
    let dispatched = false;
    const identityStillValid = () => {
      try { verify(); return true; }
      catch (error) { if (error.code === 'STALE_TARGET' || error.code === 'TARGET_DISABLED') return false; throw error; }
    };
    const postVerify = () => {
      if (!dispatched) { verify(); return true; }
      return identityStillValid();
    };
    const before = textField ? textFieldState(element) : null;
    // Event-driven widgets may implement their own keys. Only local semantic
    // effects/focus count as evidence; unrelated page timers/animation do not.
    const effectRoot = element.closest?.('[role="menu"],[role="listbox"],[role="radiogroup"],[role="tablist"]') || element;
    const beforeEffect = custom ? pageStateSignature(effectRoot) : null;
    const beforeFocus = focusedElement();
    const init = { key, code: key === ' ' ? 'Space' : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key, ...modifiers, bubbles: true, cancelable: true, composed: true };
    const proceed = element.dispatchEvent(new KeyboardEvent('keydown', init));
    verify();
    let failure = custom ? null : !proceed ? errorResult('NO_EFFECT', '页面阻止了 keydown，未执行默认按键行为')
      : focusedElement() !== element ? errorResult('NO_EFFECT', '页面在 keydown 中转移了焦点，未执行默认按键行为') : null;
    let expected;
    let expectedFocus;
    let expectedChecked;
    if (!failure && !custom) {
      if (tab) {
        // Flatten open shadow roots in composed traversal order; positive tabindex first.
        const focusable = [];
        const visit = (root) => {
          for (const child of root.children) {
            if (isHidden(child) || child.inert) continue;
            if (!child.disabled && child.tabIndex >= 0) focusable.push(child);
            visit(child.shadowRoot || child);
          }
        };
        visit(document.body);
        focusable.sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
        const index = focusable.indexOf(element);
        expectedFocus = focusable[(index + (modifiers.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
        verify();
        expectedFocus?.focus();
        verify();
        if (!expectedFocus || expectedFocus === element || focusedElement() !== expectedFocus) failure = errorResult('NO_EFFECT', 'Tab 未移动到另一个可聚焦目标');
      } else if (textKey) {
        failure = pressTextField(element, key, modifiers, verify);
        expected = textFieldState(element);
        if (!failure && before === expected) failure = errorResult('NO_EFFECT', '按键未改变字段值或选区');
      } else if (toggle) {
        const checked = element.checked;
        verify();
        dispatched = true;
        element.click();
        const intact = postVerify();
        expectedChecked = element.checked;
        if (intact && checked === expectedChecked) failure = errorResult('NO_EFFECT', 'Space 未改变选中状态');
      } else if (submit) {
        let submitted = false;
        let submissionError;
        // Implicit submission activates the first form-associated submit button
        // in tree order, even when disabled. It never falls through to a second.
        const defaultSubmitter = !submitter && [...form.getRootNode().querySelectorAll('button,input')].find((candidate) => candidate.form === form
          && ((candidate instanceof HTMLButtonElement && candidate.type === 'submit')
            || (candidate instanceof HTMLInputElement && ['submit', 'image'].includes(candidate.type))));
        const defaultVerify = defaultSubmitter && bindTarget(defaultSubmitter, runId).verify;
        const onSubmit = (event) => {
          try { verify(); if (defaultVerify) defaultVerify(true); }
          catch (error) { event.preventDefault(); submissionError = error; return; }
          submitted = true;
        };
        form.addEventListener('submit', onSubmit, true);
        try {
          verify();
          dispatched = true;
          if (submitter) form.requestSubmit(submitter);
          else if (defaultSubmitter) {
            // Native click activation preserves submitter, name/value,
            // formaction/formnovalidate and the page's click cancellation.
            if (!defaultSubmitter.disabled && !defaultSubmitter.matches(':disabled')) {
              defaultVerify(true);
              defaultSubmitter.click();
            }
          } else {
            const blockers = [...form.elements].filter((candidate) => candidate instanceof HTMLInputElement
              && ['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'].includes(candidate.type));
            if (blockers.length <= 1) form.requestSubmit();
          }
          if (submissionError) throw submissionError;
          // 提交事件已触发：只确认已派发，业务结果由页面/用户核对；身份变化不再算未执行。
          postVerify();
          if (!submitted) failure = errorResult('NO_EFFECT', 'Enter 未触发表单提交事件，请检查默认提交按钮、页面事件或原生约束校验');
        } finally { form.removeEventListener('submit', onSubmit, true); }
      }
    }
    postVerify();
    // 已派发后节点被替换/改身份则不再向旧节点补发 keyup。
    if (!dispatched || identityStillValid()) element.dispatchEvent(new KeyboardEvent('keyup', init));
    postVerify();
    await sleep(TIMING.settle, runId);
    postVerify();
    if (expected != null && textFieldState(element) !== expected) failure = errorResult('NO_EFFECT', '按键后页面未保留预期字段值或选区');
    if (expectedFocus && focusedElement() !== expectedFocus) failure = errorResult('NO_EFFECT', '按键后页面未保留预期焦点');
    if (expectedChecked != null && element.checked !== expectedChecked) failure = errorResult('NO_EFFECT', '按键后页面未保留预期选中状态');
    if (custom && beforeEffect === pageStateSignature(effectRoot) && beforeFocus === focusedElement()) failure = errorResult('UNSUPPORTED_KEY', '未观察到此按键的局部语义或焦点效果；无法保证自定义控件/富文本或未实现按键的浏览器默认行为');
    return failure || { ok: true, msg: `已按键 ${requested}`, state: element.isConnected ? readState(element) : '页面已更新' };
  }

  async function typeText(element, value, runId, verify) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) return errorResult('NOT_EDITABLE', '目标不是可编辑元素');
    if (element instanceof HTMLInputElement && element.type === 'file') return errorResult('NOT_EDITABLE', '文件上传暂不支持，请手动选择文件');
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    verify();
    element.scrollIntoView({ block: 'center' });
    verify();
    element.focus();
    verify();
    if (element.readOnly) return errorResult('READ_ONLY', '目标为只读');
    const text = normalizedFieldValue(element, value);
    if (exceedsFieldLimit(element, text)) return valueNotApplied();
    const changed = fieldValueState(element)[0] !== text;
    const expected = [text];
    const observe = valueTargetObserver(element, verify, runId);
    const wholeNumber = element instanceof HTMLInputElement && element.type === 'number';
    if (changed) {
      if (wholeNumber) {
        // Native number setters reject intermediate strings such as '-' or '12.'.
        // Keep the whole-field replacement contract and verify the complete value.
        setNativeValue(element, text, verify);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      } else {
        if (element.isContentEditable) element.textContent = '';
        else setNativeValue(element, '', verify);
        // Each native append places the caret at the end of the replaced field.
        for (const char of text) {
          if (!canContinueValueEvents(element, verify, runId)) break;
          const down = element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true, composed: true }));
          if (!canContinueValueEvents(element, verify, runId)) break;
          if (down) {
            if (element.isContentEditable) element.textContent += char;
            else setNativeValue(element, element.value + char, verify);
            element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: char }));
          }
          if (!canContinueValueEvents(element, verify, runId)) break;
          element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true, composed: true }));
          await sleep(12, runId);
        }
      }
      if (canContinueValueEvents(element, verify, runId)) element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const confirmed = await confirmValueApplied(observe, fieldValueOnly, expected, runId);
    if (confirmed.error) return confirmed.error;
    return { ok: true, ...(changed ? {} : { code: 'NO_CHANGE' }), msg: changed ? (wholeNumber ? '已输入数字' : '已逐字输入') : '目标已是指定内容', state: readState(confirmed.target) };
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
      if (!Array.isArray(action.actions) || !action.actions.length || action.actions.length > 20 || action.actions.some((item) => item?.action === 'repeat')) return errorResult('INVALID_REPEAT', 'repeat 子操作必须为1至20项且不可嵌套');
      const history = [];
      const summary = { plannedIterations: times, completedIterations: 0, iteration: 0, subIndex: 0, successCount: 0, failureCount: 0, skippedCount: 0, omittedCount: 0 };
      const record = (result, subIndex, skipped = false) => {
        if (!skipped) summary[result.ok ? 'successCount' : 'failureCount']++;
        history.push({ action: safeSlice(action.actions[subIndex]?.action, 32), iteration: summary.iteration, subIndex: subIndex + 1,
          ok: result.ok === true, ...(result.code ? { code: safeSlice(result.code, 64) } : {}), msg: safeSlice(result.msg || result.error, 300) });
        if (history.length > 100) { history.shift(); summary.omittedCount++; }
      };
      const finish = (result, skipCurrentRound = false) => {
        if (skipCurrentRound) {
          for (let rest = summary.subIndex; rest < action.actions.length; rest++) {
            record(isNavigationResult(result) ? skippedAfterNavigation() : errorResult('SKIPPED_AFTER_FAILURE', '前序操作中止，已跳过'), rest, true);
          }
        }
        summary.skippedCount = times * action.actions.length - summary.successCount - summary.failureCount;
        return { ...result, results: history, repeatSummary: summary };
      };
      try {
        for (let index = 0; index < times; index++) {
          assertActive(runId);
          summary.iteration = index + 1;
          summary.subIndex = 0;
          const started = performance.now();
          let failed;
          for (let subIndex = 0; subIndex < action.actions.length; subIndex++) {
            summary.subIndex = subIndex + 1;
            let result;
            try { result = await executeAction(action.actions[subIndex], runId, depth + 1, approved); }
            catch (error) { result = isNavigationResult(error) ? navigationResult() : errorResult(error.code || 'ACTION_ERROR', error.message || String(error)); }
            record(result, subIndex);
            if (isNavigationResult(result)) return finish({ ...result, msg: `循环执行 ${index + 1}/${times} 轮后因导航停止` }, true);
            if (!result.ok && !RECOVERABLE_TARGET_ERRORS.has(result.code)) return finish(errorResult(result.code || 'REPEAT_FAILED', `循环在第 ${index + 1} 轮停止：${result.msg || result.error}`), true);
            if (!result.ok) failed ||= result;
          }
          summary.completedIterations++;
          if (failed) return finish(errorResult(failed.code, `循环第 ${index + 1} 轮存在失败目标，有效目标已执行，请核对结果`));
          if (index < times - 1) await sleep(Math.max(0, interval - (performance.now() - started)), runId);
        }
        return finish({ ok: true, msg: `已按 ${Math.round(interval)}ms 周期循环 ${times} 轮` });
      } catch (error) {
        return finish(isNavigationResult(error) ? navigationResult() : errorResult(error.code || 'REPEAT_FAILED', error.message || String(error)));
      }
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
    if (action.action === 'press' && action.ref == null && !action.selector) resolved = bindTarget(focusedElement(), runId);
    else resolved = await resolveTarget(action, runId);
    if (resolved.error) return resolved.error;
    if (resolved.recoverChoice && ['click', 'check', 'checkRadio'].includes(action.action)) resolved = resolved.recoverChoice();
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
      const isChecked = (node) => {
        const control = choiceTarget(node) || node;
        return control instanceof HTMLInputElement ? control.checked : control?.getAttribute('aria-checked') === 'true';
      };
      const clicked = await clickOnce(checkbox || element, runId, verify, 1, element, resolved.recoverChoice, (node) => !isChecked(node));
      const record = action.ref != null && optionRecords.get(Number(action.ref));
      const observedElement = element.isConnected ? element : record && optionAt(record.path);
      if (record && !optionMatches(observedElement, record)) return errorResult('STALE_TARGET', '点击后题目或选项身份已变化，请重新读取页面核对实际状态');
      const observed = observedElement && (choiceTarget(observedElement) || observedElement);
      const checked = observed instanceof HTMLInputElement ? observed.checked : observed?.getAttribute('aria-checked') === 'true';
      if (!checked) return errorResult('CHECK_NOT_APPLIED', '点击后目标仍未选中，页面可能阻止了合成点击，请重新读取页面或手动选择');
      return { ok: true, ...(clicked === false ? { code: 'NO_CHANGE' } : {}), msg: clicked === false ? '目标已选中' : '已选中目标', state: readState(observedElement) };
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
      try { await clickOnce(toggle ? target : element, runId, verify, 1, element, resolved.recoverChoice); }
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
      const next = normalizedFieldValue(target, action.value);
      if (exceedsFieldLimit(target, next)) return valueNotApplied();
      const changed = fieldValueState(target)[0] !== next;
      const expected = [next];
      const observe = valueTargetObserver(target, verify, runId);
      if (changed) {
        if (target.isContentEditable) target.textContent = next;
        else setNativeValue(target, next, verify);
        target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: next }));
        if (canContinueValueEvents(target, verify, runId)) target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (canContinueValueEvents(target, verify, runId)) target.blur();
      const confirmed = await confirmValueApplied(observe, fieldValueOnly, expected, runId);
      if (confirmed.error) return confirmed.error;
      return { ok: true, code: changed ? 'FILLED' : 'NO_CHANGE', msg: changed ? '已填写目标' : '目标已是指定内容', state: readState(confirmed.target) };
    }
    if (action.action === 'select') {
      if (!(target instanceof HTMLSelectElement)) return errorResult('NOT_SELECT', 'select 仅支持原生下拉框');
      // 多选下拉 value 传数组；标量赋值会清掉其余已选项
      if (Array.isArray(action.value) && !target.multiple) return errorResult('INVALID_VALUE', '单选下拉不支持数组 value，请传单个选项');
      const requestedList = Array.isArray(action.value) ? action.value.map((item) => String(item ?? '')) : [String(action.value ?? '')];
      if (!requestedList.length || requestedList.includes('')) return errorResult('OPTION_NOT_FOUND', '选项不存在');
      const hits = [];
      for (const requested of requestedList) {
        // 提交值优先；只有没有同值选项时才按可见文字匹配，文字重复或前缀不唯一均拒绝，避免静默选中首项。
        const byValue = [...target.options].filter((option) => option.value === requested);
        const byText = byValue.length ? [] : [...target.options].filter((option) => option.textContent.trim() === requested);
        const prefix = byValue.length || byText.length ? [] : [...target.options].filter((option) => option.textContent.trim().startsWith(requested));
        const candidates = byValue.length ? byValue : byText.length ? byText : prefix;
        if (candidates.length !== 1) {
          return errorResult('OPTION_NOT_FOUND', candidates.length > 1 ? '匹配到多个选项，请使用唯一的选项值' : '选项不存在');
        }
        const hit = candidates[0];
        if (!hits.includes(hit)) hits.push(hit);
      }
      const options = [...target.options];
      const selected = options.map((option) => hits.includes(option));
      const optionIdentity = (option) => JSON.stringify([option.value, option.textContent, option.label, option.disabled,
        option.parentElement?.tagName === 'OPTGROUP' ? [option.parentElement.label, option.parentElement.disabled] : null]);
      const readSelection = (element) => [...element.options].flatMap((option) => [optionIdentity(option), option.selected]);
      const expected = options.flatMap((option, index) => [optionIdentity(option), selected[index]]);
      const changed = options.some((option, index) => option.selected !== selected[index]);
      const observe = valueTargetObserver(target, verify, runId);
      if (changed) {
        verify();
        if (target.multiple) options.forEach((option, index) => { option.selected = selected[index]; });
        // A value may belong to multiple options. Use the matched option's index
        // so choosing by visible text does not silently select a different row.
        else Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(target, options.indexOf(hits[0]));
        target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        if (canContinueValueEvents(target, verify, runId)) target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const confirmed = await confirmValueApplied(observe, readSelection, expected, runId);
      if (confirmed.error) return confirmed.error;
      return { ok: true, code: changed ? 'SELECTED' : 'NO_CHANGE', msg: changed ? (isSensitive(confirmed.target) ? '已选择敏感选项（已隐藏）' : `已选择 ${hits.length} 项`) : '已是指定选项', state: readState(confirmed.target) };
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
      const submitter = (target instanceof HTMLButtonElement && target.type === 'submit')
        || (target instanceof HTMLInputElement && ['submit', 'image'].includes(target.type)) ? target : undefined;
      const skipValidation = form.noValidate === true || submitter?.formNoValidate === true;
      const valid = skipValidation || form.reportValidity();
      verify();
      if (!valid) return errorResult('FORM_INVALID', '表单校验未通过，未提交');
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
      // 导航也可能发生于批间等待或最终快照等待。仅把它归到成功的最后动作；失败或跳过的结果保持原样，
      // 由批级 navigation 告知后台等待新文档，避免把未执行的提交显示为成功。
      if (!isNavigationResult(error)) throw error;
      const last = results.at(-1);
      if (last?.ok === true && !isNavigationResult(last)) Object.assign(last, navigationResult());
      else if (!results.length) results.push(navigationResult());
      else {
        while (results.length < message.actions.length) results.push(skippedAfterNavigation());
        return { results, navigation: navigationResult() };
      }
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
