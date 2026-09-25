(() => {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 180000;
  const MAX_ERROR_BODY = 500;
  const MAX_REPLY_LENGTH = 1000000;

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

  function redactErrorText(text, apiKey) {
    let safe = String(text);
    if (apiKey) {
      // 精确屏蔽本次凭据（含 JSON 转义形式），必须先于正文规范化与截断。
      for (const secret of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])) {
        safe = safe.split(secret).join('[REDACTED]');
      }
    }
    return safe.replace(/(\bauthorization["']?\s*:\s*["']?(?:bearer|basic)\s+)[^\s"',;<>\\]+/gi, '$1[REDACTED]');
  }

  async function callModel(input, messages, options = {}) {
    const cfg = validateModel(input);
    if (!Array.isArray(messages) || !messages.length) throw new Error('模型消息不能为空');
    const timeoutMs = Math.min(300000, Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const retries = Math.floor(Math.min(3, Math.max(0, Number(options.retries) || 0)));
    const url = cfg.baseUrl + '/chat/completions';
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (options.signal?.aborted) throw abortError();
      const ctrl = new AbortController();
      const unlink = linkAbort(options.signal, ctrl);
      const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
      let responseRetryable;
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
        if (ctrl.signal.aborted) throw abortError();

        if (!resp.ok) {
          responseRetryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
          let body;
          try {
            body = redactErrorText(await resp.text(), cfg.apiKey).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR_BODY);
          } catch (error) {
            if (ctrl.signal.aborted) throw error;
            body = '错误响应正文读取失败';
          }
          const error = new Error(`API ${resp.status}${body ? `: ${body}` : ''}`);
          error.retryable = responseRetryable;
          error.retryDelay = retryAfterMs(resp, attempt);
          throw error;
        }

        let data;
        try {
          data = await resp.json();
        } catch (error) {
          if (ctrl.signal.aborted) throw error;
          throw new Error('API 返回的不是有效 JSON');
        }
        if (ctrl.signal.aborted) throw abortError();
        const choice = data?.choices?.[0];
        const finishReason = choice?.finish_reason;
        if (finishReason === 'length') {
          throw new Error('模型输出达到长度限制，回复可能被截断，未执行任何操作；请缩小任务后重试');
        }
        if (finishReason === 'content_filter') {
          throw new Error('模型输出被内容过滤，未执行任何操作；请调整请求后重试');
        }
        // 兼容省略 finish_reason 的网关，但不接受工具调用或其他未正常结束的输出。
        if (finishReason !== undefined && finishReason !== 'stop') {
          throw new Error('模型响应未正常结束或返回了不支持的工具调用，未执行任何操作');
        }
        const content = choice?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('模型响应缺少 choices[0].message.content 最终回答（推理内容不会执行）');
        }
        return content;
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (ctrl.signal.aborted) {
          lastError = new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
          // 已收到 401 等非重试状态时，读取正文超时也不能再次请求。
          lastError.retryable = responseRetryable !== false;
        } else if (error?.name === 'AbortError') {
          throw abortError();
        } else {
          // 不复用上游 Error：其 message、stack 或自定义属性都可能携带凭据。
          lastError = new Error(redactErrorText(error?.message ?? error, cfg.apiKey));
          lastError.retryable = responseRetryable ?? (error?.retryable == null ? error instanceof TypeError : error.retryable === true);
          if (Number.isFinite(error?.retryDelay)) lastError.retryDelay = error.retryDelay;
        }
        if (attempt >= retries || !lastError.retryable) throw lastError;
      } finally {
        clearTimeout(timer);
        unlink();
      }
      // 退避不再保留上一请求的超时计时器与父信号监听器，且 Retry-After: 0 有效。
      await wait(lastError.retryDelay ?? Math.min(4000, 500 * (2 ** attempt)), options.signal);
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
          const next = text[i + 1];
          const validUnicode = next !== 'u' || /^[0-9a-f]{4}$/i.test(text.slice(i + 2, i + 6));
          if (valid.has(next) && validUnicode) { out += ch; esc = true; }
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
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && (Array.isArray(value.actions) || typeof value.say === 'string' || value.done === true);
  }

  // 只扫描顶层容器，忽略 JSON 字符串内括号；前言中的孤立引号不应吞掉后续指令。
  function extractLastInstruction(text) {
    let found = null;
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
      if (ch === '"' && depth > 0) { inStr = true; continue; }
      if (ch === '{' || ch === '[') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}' || ch === ']') {
        if (depth === 0) continue;
        depth--;
        if (depth === 0 && start >= 0) {
          const value = tryParseJson(text.slice(start, i + 1));
          if (isInstructionObject(value)) found = { value, index: start };
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
    const source = String(text);
    // 不截断后解析，避免超长回复的合法前缀被当成完整指令。
    if (source.length > MAX_REPLY_LENGTH) {
      return { say: '模型回复过长，未解析或执行操作；请缩小任务后重试', actions: [], done: false };
    }
    const value = tryParseJson(source.trim());
    if (isInstructionObject(value)) return normalizeInstruction(value);
    // 完整的数组/普通对象是数据，不应挖出其中的示例操作。
    if (value !== null) return { say: source.slice(0, 50000), actions: [], done: false };

    let last = extractLastInstruction(source);
    function consider(segment, offset) {
      const candidate = extractLastInstruction(segment);
      if (!candidate) return;
      candidate.index += offset;
      if (!last || candidate.index > last.index) last = candidate;
    }
    // 围栏内外均按原文位置比较；独立扫描各段可容忍前言中未配对的括号。
    let cursor = 0;
    for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      consider(source.slice(cursor, match.index), cursor);
      consider(match[1], match.index + match[0].indexOf(match[1]));
      cursor = match.index + match[0].length;
    }
    if (cursor) consider(source.slice(cursor), cursor);
    if (last) return normalizeInstruction(last.value);
    return { say: source.slice(0, 50000), actions: [], done: false };
  }

  globalThis.ViasCore = Object.freeze({ normalizeBaseUrl, validateModel, callModel, parseReply });
})();
