(() => {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 180000;
  const MAX_ERROR_BODY = 500;

  function normalizeBaseUrl(url) {
    let value = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(value)) value = value.slice(0, -'/chat/completions'.length);
    return value;
  }

  function validateModel(input) {
    const cfg = input && typeof input === 'object' ? input : {};
    const baseUrl = normalizeBaseUrl(cfg.baseUrl);
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('API 地址无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 地址仅支持 http(s)');
    if (parsed.username || parsed.password) throw new Error('API 地址不能包含账号或密码');
    const model = String(cfg.model || '').trim();
    if (!model || model.length > 200) throw new Error('模型名不能为空且不能超过 200 个字符');
    const name = String(cfg.name || '').trim();
    if (name.length > 80) throw new Error('显示名称不能超过 80 个字符');
    const apiKey = String(cfg.apiKey || '').trim();
    if (apiKey.length > 4096) throw new Error('API Key 长度异常');
    return {
      ...cfg,
      name,
      baseUrl,
      apiKey,
      model,
      vision: cfg.vision === true,
    };
  }

  function abortError(message = '请求已取消') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  function wait(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function retryAfterMs(resp, attempt) {
    const header = resp.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.min(10000, Math.max(0, seconds * 1000));
      const date = Date.parse(header);
      if (Number.isFinite(date)) return Math.min(10000, Math.max(0, date - Date.now()));
    }
    return Math.min(4000, 500 * (2 ** attempt));
  }

  function linkAbort(parent, child) {
    if (!parent) return () => {};
    if (parent.aborted) child.abort(parent.reason);
    const onAbort = () => child.abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    return () => parent.removeEventListener('abort', onAbort);
  }

  async function callModel(input, messages, options = {}) {
    const cfg = validateModel(input);
    if (!Array.isArray(messages) || !messages.length) throw new Error('模型消息不能为空');
    const timeoutMs = Math.min(300000, Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const retries = Math.min(3, Math.max(0, Number(options.retries) || 0));
    const url = cfg.baseUrl + '/chat/completions';
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (options.signal?.aborted) throw abortError();
      const ctrl = new AbortController();
      const unlink = linkAbort(options.signal, ctrl);
      const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2 }),
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'omit',
        });

        if (!resp.ok) {
          const body = (await resp.text()).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_BODY);
          const error = new Error(`API ${resp.status}${body ? `: ${body}` : ''}`);
          error.retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
          error.retryDelay = retryAfterMs(resp, attempt);
          throw error;
        }

        let data;
        try {
          data = await resp.json();
        } catch {
          throw new Error('API 返回的不是有效 JSON');
        }
        const message = data?.choices?.[0]?.message;
        const content = typeof message?.content === 'string' && message.content.trim()
          ? message.content
          : message?.reasoning_content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('模型响应缺少 choices[0].message.content');
        }
        return content;
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (error?.name === 'AbortError') {
          lastError = new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
          lastError.retryable = true;
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (lastError.retryable == null) lastError.retryable = error instanceof TypeError;
        }
        if (attempt >= retries || !lastError.retryable) throw lastError;
        await wait(lastError.retryDelay || Math.min(4000, 500 * (2 ** attempt)), options.signal);
      } finally {
        clearTimeout(timer);
        unlink();
      }
    }
    throw lastError || new Error('模型请求失败');
  }

  function repairControlEscapes(text) {
    const valid = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) { esc = false; out += ch; continue; }
        if (ch === '\\') {
          if (valid.has(text[i + 1])) { out += ch; esc = true; }
          else out += '\\\\';
          continue;
        }
        if (ch === '"') { inStr = false; out += ch; continue; }
        out += ch;
        continue;
      }
      if (ch === '"') { inStr = true; }
      out += ch;
    }
    return out;
  }

  function tryParseJson(str) {
    try { return JSON.parse(str); } catch {}
    try { return JSON.parse(repairControlEscapes(str)); } catch { return null; }
  }

  function isInstructionObject(value) {
    return !!value && typeof value === 'object'
      && (Array.isArray(value.actions) || typeof value.say === 'string' || value.done === true);
  }

  // 平衡括号扫描：从混排文本中提取合法的指令 JSON 对象（正确处理字符串内的引号与转义）
  function extractInstructionObjects(text) {
    const found = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        if (depth === 0) continue;
        depth--;
        if (depth === 0 && start >= 0) {
          const value = tryParseJson(text.slice(start, i + 1));
          if (isInstructionObject(value)) found.push(value);
          start = -1;
        }
      }
    }
    return found;
  }

  function normalizeInstruction(value) {
    return {
      say: typeof value.say === 'string' ? value.say.slice(0, 50000) : '',
      actions: Array.isArray(value.actions) ? value.actions : [],
      done: value.done === true,
    };
  }

  // 解析模型回复为 {say, actions, done}。done 是任务真正完成的显式截止信号。
  function parseReply(text) {
    const candidates = [];
    for (const match of String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
    candidates.push(String(text).trim());
    for (const candidate of candidates) {
      const value = tryParseJson(candidate);
      if (isInstructionObject(value)) return normalizeInstruction(value);
    }
    // 兜底：模型常把 JSON 与自由文本混排（前言/解说写在块外）——提取最后一个合法指令对象，绝不吞掉操作
    const extracted = extractInstructionObjects(String(text));
    if (extracted.length) return normalizeInstruction(extracted[extracted.length - 1]);
    return { say: String(text), actions: [], done: false };
  }

  globalThis.ViasCore = Object.freeze({ normalizeBaseUrl, validateModel, callModel, parseReply });
})();
