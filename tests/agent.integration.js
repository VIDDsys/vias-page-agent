'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let context;
let profile;
let webServer;
let modelServer;
let webUrl;
let modelUrl;
let extensionId;
let reply;
let requests = [];
let oldPageClicks = 0;
let imageServer;
let imageUrl;
let imagePng;
const imageHits = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const fixture = '<!doctype html><meta charset="utf-8"><title>Agent Integration</title><button id="work">Do work</button><form id="form"><button id="submit">Submit</button></form><p id="result">INITIAL_PAGE_MARKER</p><script>window.clicks=0;window.submits=0;work.onclick=()=>{clicks++;result.textContent="PAGE_"+clicks};form.onsubmit=e=>{e.preventDefault();submits++;result.textContent="SUBMITTED"};</script>';

const batchOptionsFixture = `<!doctype html><meta charset="utf-8"><title>Batch options</title>
<style>input{opacity:0;position:absolute;width:0;height:0}label{display:block;min-height:24px}</style>
<form id="paperForm"><main id="paper"></main><button id="save" type="button">保存</button><button type="submit">提交</button></form>
<script>
window.paperSelected = Array.from({ length: 12 }, () => []);
window.paperChanges = [];
window.paperRenders = 0;
window.saves = 0;
window.submits = 0;
document.querySelector('#save').onclick = () => { window.saves++; };
document.querySelector('#paperForm').onsubmit = (event) => { event.preventDefault(); window.submits++; };
function renderPaper() {
  window.paperRenders++;
  document.querySelector('#paper').innerHTML = window.paperSelected.map((selected, question) => {
    const type = question % 2 ? 'checkbox' : 'radio';
    const options = ['相同选项', '', '相同选项'].map((text, option) =>
      '<label><span><input type="' + type + '" name="q' + question + '" value="' + option + '" ' + (selected.includes(option) ? 'checked' : '') + '></span><span>' + text + '</span></label>'
    ).join('');
    return '<section><h2>批量题目 ' + String(question + 1).padStart(2, '0') + ' ' + (type === 'radio' ? '单选' : '多选') + '</h2><div>' + options + '</div></section>';
  }).join('');
  document.querySelectorAll('#paper input').forEach((input) => input.addEventListener('change', () => {
    const question = Number(input.name.slice(1));
    const option = Number(input.value);
    const selected = [...document.querySelectorAll('#paper input')].filter((item) => item.name === input.name && item.checked).map((item) => Number(item.value));
    window.paperSelected[question] = selected;
    const previousInputs = [...document.querySelectorAll('#paper input')];
    renderPaper();
    window.paperChanges.push({ question, option, selected, replacedAll: previousInputs.every((item) => !item.isConnected) });
  }));
}
renderPaper();
</script>`;

test.before(async () => {
  assert.ok(fs.existsSync(edgePath), `Edge 不存在: ${edgePath}`);
  webServer = http.createServer((request, response) => {
    const route = request.url.split('?')[0];
    if (route === '/no-document') { response.writeHead(204); response.end(); return; }
    if (route === '/redirect-back') { response.writeHead(302, { location: '/navigate' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (route === '/old-click') { oldPageClicks++; response.end('recorded'); return; }
    if (route === '/slow') { setTimeout(() => response.end('<!doctype html><title>Arrived</title><p>ARRIVED_NEW_PAGE</p>'), 1500); return; }
    if (route === '/navigate') { response.end('<!doctype html><button id="old" onclick="fetch(\'/old-click\')">Old action</button><p>OLD_DOCUMENT</p>'); return; }
    if (route === '/navigate-link') { response.end('<!doctype html><a href="/slow">Start navigation</a><button id="old" onclick="fetch(\'/old-click\')">Old action</button>'); return; }
    if (route === '/navigate-form') { response.end('<!doctype html><form action="/slow"><input name="note"><button type="submit">Submit</button></form><button id="old" onclick="fetch(\'/old-click\')">Old action</button>'); return; }
    if (route === '/batch-options') { response.end(batchOptionsFixture); return; }
    response.end(fixture);
  });
  modelServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        const instruction = await reply(requests.length, body);
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof instruction === 'string' ? instruction : JSON.stringify(instruction) } }] }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(error.message);
      }
    });
  });
  imageServer = http.createServer((request, response) => {
    imageHits.push({ url: request.url, cookie: request.headers.cookie || '' });
    if (request.url === '/selected.png') { response.writeHead(302, { location: '/resolved.png' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(imagePng);
  });
  imageUrl = `http://127.0.0.1:${await listen(imageServer)}`;
  webUrl = `http://127.0.0.1:${await listen(webServer)}`;
  modelUrl = `http://127.0.0.1:${await listen(modelServer)}/v1`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vias-agent-integration-'));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edgePath, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  assert.ok(extensionId);
  const config = await context.newPage();
  await config.goto(`chrome-extension://${extensionId}/options.html`);
  await config.evaluate((baseUrl) => chrome.storage.local.set({
    models: [{ id: 'integration', name: 'Integration', baseUrl, apiKey: '', model: 'mock', vision: false }],
    activeModelId: 'integration', settingsRevision: 1,
  }), modelUrl);
  await config.close();
});

test.after(async () => {
  await context?.close();
  if (imageServer?.listening) await new Promise((resolve) => imageServer.close(resolve));
  if (webServer?.listening) await new Promise((resolve) => webServer.close(resolve));
  if (modelServer?.listening) await new Promise((resolve) => modelServer.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function withPanel(handler, route = '/') {
  requests = [];
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('#modelPill')?.textContent.includes('Integration') && !document.querySelector('#clear').disabled);
  await panel.locator('#clear').click();
  const target = await context.newPage();
  await target.goto(webUrl + route);
  await target.bringToFront();
  try {
    await handler(panel, target);
    assert.deepEqual(errors, []);
  } finally {
    await panel.close();
    await target.close();
  }
}

async function send(panel, question = 'Complete the local task') {
  await panel.locator('#input').fill(question);
  await panel.locator('#inputForm').evaluate((form) => form.requestSubmit());
}

async function finished(panel) {
  await panel.waitForFunction(() => !document.querySelector('#clear').disabled, null, { timeout: 30000 });
}

const complete = { say: '任务完成', done: true, actions: [] };

function buttonRef(body, label) {
  const content = body.messages.at(-1).content;
  const text = typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const line = text.split('\n').find((item) => item.includes(`按钮「${label}」`));
  const match = line?.match(/^\[(\d+)\]/);
  assert.ok(match, `最新观察未包含按钮 ${label}`);
  return Number(match[1]);
}

test('真实扩展完成模型→操作→新快照→done全链路，无审批和脚本错误', async () => {
  reply = (n) => n === 1 ? { say: '正在执行', actions: [{ action: 'click', selector: '#work' }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '点击 Do work 并汇报');
    await finished(panel);
    assert.equal(await target.locator('#result').textContent(), 'PAGE_1');
    assert.equal(requests.length, 2);
    await panel.getByText('任务完成', { exact: true }).waitFor();
    assert.equal(await panel.locator('.approval').count(), 0);
    assert.match(JSON.stringify(requests[1].messages), /操作结果/);
  });
});

test('真实MV3模型按当前快照分两批选择12题原生label/input，逐次全量重绘后核对反馈才done且不保存提交', { timeout: 90000 }, async () => {
  const expected = Array.from({ length: 12 }, (_, question) => question % 2
    ? [question % 3, (question + 1) % 3].sort((a, b) => a - b) : [question % 3]);
  const snapshots = [];
  const batches = [];
  const feedback = [];
  let modelDone = false;
  reply = (n, body) => {
    assert.ok(n <= 3, '只应有两批操作和一次完成核对');
    const latest = body.messages.at(-1).content;
    assert.equal(typeof latest, 'string');
    const snapshotId = latest.match(/快照ID: ([^\n]+)/)?.[1];
    assert.ok(snapshotId, '模型必须收到当轮快照');
    assert.ok(!snapshots.some((snapshot) => snapshot.id === snapshotId), '操作后必须收到新快照');
    const questions = [];
    for (const line of latest.split('\n')) {
      const heading = line.match(/^批量题目 (\d{2}) (单选|多选)$/);
      if (heading) {
        assert.equal(Number(heading[1]), questions.length + 1, '题目上下文顺序必须完整');
        questions.push({ type: heading[2], options: [] });
        continue;
      }
      const option = line.match(/^\[(\d+)\] 选项「([^」]*)」 类型:(单选|复选) (已选中|未选)$/);
      if (option) {
        assert.ok(questions.length, '每个选项必须位于题目上下文中');
        questions.at(-1).options.push({ ref: Number(option[1]), text: option[2], type: option[3], checked: option[4] === '已选中' });
      }
    }
    assert.equal(questions.length, 12);
    for (const [question, item] of questions.entries()) {
      assert.equal(item.type, question % 2 ? '多选' : '单选');
      assert.deepEqual(item.options.map((option) => option.text), ['相同选项', '', '相同选项']);
      assert.ok(item.options.every((option) => option.type === (question % 2 ? '复选' : '单选')));
      const selected = item.options.flatMap((option, index) => option.checked ? [index] : []);
      assert.deepEqual(selected, question < (n - 1) * 6 ? expected[question] : [], `第${n}轮观察的第${question + 1}题真实选中状态`);
    }
    const refs = questions.flatMap((question) => question.options.map((option) => option.ref));
    assert.equal(new Set(refs).size, 36);
    assert.ok(snapshots.every((snapshot) => snapshot.refs.every((ref) => !refs.includes(ref))), '新快照不能复用旧ref');
    snapshots.push({ id: snapshotId, refs });
    if (n > 1) {
      const results = JSON.parse(latest.match(/^操作结果: (\[[^\n]*\])/m)?.[1] || 'null');
      assert.ok(Array.isArray(results), '模型必须收到上一批操作反馈');
      assert.equal(results.length, 9);
      assert.ok(results.every((result) => result.ok === true && result.state === '已选中'), JSON.stringify(results));
      feedback.push(results);
    }
    if (n === 3) {
      modelDone = true;
      return { say: '12题已核对完成', done: true, actions: [] };
    }
    const start = (n - 1) * 6;
    const actions = questions.slice(start, start + 6).flatMap((question, index) => expected[start + index].map((option) => ({
      action: question.type === '单选' ? 'checkRadio' : 'check', ref: question.options[option].ref, value: true,
    })));
    assert.equal(actions.length, 9);
    assert.ok(actions.every((action) => refs.includes(action.ref)), '每批仅下发本轮观察中的ref');
    batches.push(actions);
    return { say: `选择第${n}批并重新核对`, actions };
  };
  await withPanel(async (panel, target) => {
    await send(panel, '按题号分两批选择12题，先选1至6题，再选7至12题；单选选择题号从0起模3的选项，多选再选下一个选项。每批后核对实际选中状态，全部成功才完成，不保存、不提交。');
    await finished(panel);
    await panel.getByText('12题已核对完成', { exact: true }).waitFor();
    assert.equal(requests.length, 3);
    assert.equal(modelDone, true);
    assert.equal(batches.length, 2);
    assert.equal(feedback.length, 2);
    const state = await target.evaluate(() => ({
      selected: Array.from(document.querySelectorAll('#paper section'), (section) => [...section.querySelectorAll('input')].filter((input) => input.checked).map((input) => Number(input.value))),
      recorded: window.paperSelected, changes: window.paperChanges, renders: window.paperRenders,
      saves: window.saves, submits: window.submits,
    }));
    assert.deepEqual(state.selected, expected, '直接检查最终DOM原生checked，而非仅相信操作成功反馈');
    assert.deepEqual(state.recorded, expected);
    assert.equal(state.changes.length, 18, '每个选中动作均触发真实change');
    assert.equal(state.renders, 19, '初始渲染加18次change全量重绘');
    assert.ok(state.changes.every((change) => change.replacedAll), '每次change都必须断开全部36个旧input');
    assert.deepEqual(state.changes.map(({ question, option }) => [question, option]), expected.flatMap((options, question) => options.map((option) => [question, option])));
    assert.equal(state.saves, 0);
    assert.equal(state.submits, 0);
  }, '/batch-options');
});

test('真实侧栏隐藏损坏协议及 say 内嵌指令，修复后正常执行并保存', async () => {
  reply = (n) => n === 1 ? '{"say":"BROKEN_UI_MARKER","actions":[{"action":"click","selector":"#work"}],}'
    : n === 2 ? { say: '开始执行 {"actions":[{"action":"click","value":"EMBEDDED_UI_MARKER"}]}', actions: [{ action: 'click', selector: '#work' }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '点击 Do work 并汇报');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 1);
    assert.equal(requests.length, 3);
    const displayed = await panel.locator('body').innerText();
    const stored = JSON.stringify(await panel.evaluate(() => chrome.storage.session.get(null)));
    for (const text of [displayed, stored, JSON.stringify(requests.slice(1))]) {
      assert.ok(!text.includes('BROKEN_UI_MARKER'));
      assert.ok(!text.includes('EMBEDDED_UI_MARKER'));
    }
    assert.match(displayed, /开始执行/);
    assert.match(displayed, /任务完成/);
  });
});

test('问答模式完整展示含操作JSON的说明文章但不执行', async () => {
  reply = () => '解释前言\n```json\n{"actions":[{"action":"click","ref":1}]}\n```\n解释结尾';
  await withPanel(async (panel, target) => {
    await panel.locator('#modeAsk').click();
    await send(panel, '解释这段JSON');
    await finished(panel);
    assert.equal(requests.length, 1);
    assert.equal(await target.evaluate(() => window.clicks), 0);
    const text = await panel.locator('body').innerText();
    assert.match(text, /解释前言/);
    assert.match(text, /解释结尾/);
  });
});

for (const ask of [false, true]) {
  test(`真实扩展长页面${ask ? '问答原样展示JSON' : '跨段执行旧ref与尾部ref'}，读取后继续模型循环`, async () => {
    const answer = '分段问答正文\n```json\n{"actions":[{"action":"click","ref":1}]}\n```\n分段问答结尾';
    reply = (n, body) => {
      const latest = body.messages.at(-1).content;
      if (n === 1) {
        const id = latest.match(/快照ID: ([^\n]+)/)?.[1];
        assert.ok(id);
        assert.match(latest, /共 2 段/);
        assert.ok(!latest.includes('TAIL_SEGMENT_MARKER'));
        return { vias_read: { kind: 'segment', snapshotId: id, index: 1 } };
      }
      if (n === 2) {
        assert.match(latest, /TAIL_SEGMENT_MARKER/);
        assert.ok(JSON.stringify(body.messages).includes('INITIAL_PAGE_MARKER'), '跨段最终回答必须仍可看到首段事实');
        if (ask) return answer;
        const ref = Number(latest.match(/\[(\d+)\] 按钮「Tail segment action」/)?.[1]);
        assert.ok(ref);
        return { actions: [{ action: 'click', ref: 1 }, { action: 'click', ref }] };
      }
      return complete;
    };
    await withPanel(async (panel, target) => {
      await target.evaluate(() => {
        const p = document.createElement('p'); p.textContent = 'long-page-copy-'.repeat(3000); document.body.append(p);
        const tail = document.createElement('button'); tail.textContent = 'Tail segment action';
        window.tailClicks = 0; tail.onclick = () => { window.tailClicks++; }; document.body.append(tail);
        const marker = document.createElement('p'); marker.textContent = 'TAIL_SEGMENT_MARKER'; document.body.append(marker);
      });
      if (ask) await panel.locator('#modeAsk').click();
      await send(panel, ask ? '读取第二段并解释JSON' : '读取第二段，点击首段和尾部按钮');
      await finished(panel);
      assert.equal(requests.length, ask ? 2 : 3);
      assert.equal(await target.evaluate(() => window.clicks), ask ? 0 : 1);
      assert.equal(await target.evaluate(() => window.tailClicks), ask ? 0 : 1);
      const displayed = await panel.locator('body').innerText();
      if (ask) { assert.match(displayed, /分段问答正文/); assert.match(displayed, /分段问答结尾/); }
      else assert.match(displayed, /任务完成/);
    });
  });
}

for (const ask of [false, true]) {
  test(`真实MV3${ask ? '问答' : '执行'}仅下载所选跨域CDN图片，默认不附图且历史不重复`, async () => {
    imageHits.length = 0;
    reply = (n, body) => {
      const parts = body.messages.flatMap((item) => Array.isArray(item.content) ? item.content : []);
      const images = parts.filter((part) => part.type === 'image_url');
      if (n === 1) {
        assert.equal(images.length, 0);
        const text = body.messages.at(-1).content;
        const candidates = text.split('\n').filter((line) => line.startsWith('图片候选 ')).map((line) => JSON.parse(line.slice('图片候选 '.length)));
        const candidate = candidates.find((item) => item.alt === '需要识别的题目图');
        assert.ok(candidate);
        assert.equal(imageHits.length, 3, '仅页面自身初始两图及所选图的302跳转');
        return { vias_read: { kind: 'images', snapshotId: text.match(/快照ID: ([^\n]+)/)[1], ids: [candidate.id] } };
      }
      if (n === 2) {
        assert.equal(images.length, 1, JSON.stringify(body.messages.at(-1)).slice(0, 600));
        assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);
        assert.equal(imageHits.filter((item) => item.url === '/selected.png').length, 2);
        assert.equal(imageHits.filter((item) => item.url === '/resolved.png').length, 2, '所选CDN的302目标可正常识别');
        assert.equal(imageHits.filter((item) => item.url === '/other.png').length, 1);
        assert.equal(imageHits.at(-1).cookie, '', '后台跨域下载不能携带凭据');
        return ask ? '所选图片已识别' : { actions: [{ action: 'click', selector: '#work' }] };
      }
      assert.equal(images.length, 0, '后续请求不能重发旧图');
      return complete;
    };
    await withPanel(async (panel, target) => {
      const data = await target.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        canvas.getContext('2d').fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png').split(',')[1];
      });
      imagePng = Buffer.from(data, 'base64');
      await context.addCookies([{ name: 'fixture_image_cookie', value: 'not-for-background', url: imageUrl }]);
      await target.evaluate(async (base) => {
        for (const [file, alt] of [['other', '其它图'], ['selected', '需要识别的题目图']]) {
          const img = document.createElement('img'); img.src = `${base}/${file}.png`; img.alt = alt;
          document.body.append(img); await img.decode();
        }
      }, imageUrl);
      await panel.evaluate(async () => {
        const state = await chrome.storage.local.get(['models', 'settingsRevision']);
        state.models[0].vision = true; state.settingsRevision++;
        await chrome.storage.local.set(state);
      });
      try {
        if (ask) await panel.locator('#modeAsk').click();
        await send(panel, '识别题目图，忽略其它图'); await finished(panel);
        assert.equal(requests.length, ask ? 2 : 3);
        assert.match(await panel.locator('body').innerText(), ask ? /所选图片已识别/ : /任务完成/);
        const stored = JSON.stringify(await panel.evaluate(() => chrome.storage.session.get(null)));
        assert.ok(!stored.includes('data:image/'), '会话持久化不得保存图片');
      } finally {
        await panel.evaluate(async () => {
          const state = await chrome.storage.local.get(['models', 'settingsRevision']);
          state.models[0].vision = false; state.settingsRevision++; await chrome.storage.local.set(state);
        });
      }
    });
  });
}

test('真实扩展续读512000字符窗口后使用新快照尾部ref执行', async () => {
  let oldSnapshot;
  reply = (n, body) => {
    const latest = body.messages.at(-1).content;
    const id = latest.match(/快照ID: ([^\n]+)/)?.[1];
    if (n === 1) {
      oldSnapshot = id;
      assert.ok(id);
      assert.match(latest, /采集不完整/);
      return { vias_read: { kind: 'continue', snapshotId: id, notes: '已读取首段，用户要求续读并点击Continue action。' } };
    }
    if (n === 2) {
      assert.ok(id && id !== oldSnapshot);
      assert.match(latest, /CONTINUED_TAIL/);
      const ref = Number(latest.match(/\[(\d+)\] 按钮「Continue action」/)?.[1]);
      assert.ok(ref);
      return { actions: [{ action: 'click', ref }] };
    }
    return complete;
  };
  await withPanel(async (panel, target) => {
    await target.evaluate(() => {
      document.body.innerHTML = '';
      const p = document.createElement('p'); p.textContent = 'x'.repeat(512010) + 'CONTINUED_TAIL'; document.body.append(p);
      const tail = document.createElement('button'); tail.textContent = 'Continue action';
      window.continuedClicks = 0; tail.onclick = () => { window.continuedClicks++; }; document.body.append(tail);
    });
    await send(panel, '续读下一窗口并点击尾部按钮');
    await finished(panel);
    assert.equal(requests.length, 3);
    assert.equal(await target.evaluate(() => window.continuedClicks), 1);
    assert.match(await panel.locator('body').innerText(), /任务完成/);
  });
});

test('有进展的连续同目标点击使用最新ref且不误停，旧首屏不重复发送', async () => {
  reply = (n, body) => n <= 4 ? { actions: [{ action: 'click', ref: buttonRef(body, 'Do work') }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '连续点击四次 Do work');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 4);
    assert.equal(requests.length, 5);
    assert.ok(JSON.stringify(requests[0].messages).includes('INITIAL_PAGE_MARKER'));
    for (const body of requests.slice(1)) assert.ok(!JSON.stringify(body.messages).includes('INITIAL_PAGE_MARKER'));
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('PAGE_4'));
  });
});

test('页面无进展的同目标操作在ref刷新后仍会熔断', async () => {
  reply = (_n, body) => ({ actions: [{ action: 'click', ref: buttonRef(body, 'Do work') }] });
  await withPanel(async (panel, target) => {
    await target.evaluate(() => { document.querySelector('#work').onclick = () => { window.clicks++; }; });
    await send(panel);
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 2);
    assert.equal(requests.length, 3);
    assert.match(await panel.locator('body').innerText(), /无进展/);
  });
});

test('无效操作参数三轮熔断，不把超长坏回复反复带入请求', async () => {
  reply = () => ({ actions: [{ action: 'not-a-real-action' }], padding: 'x'.repeat(100000) });
  await withPanel(async (panel, target) => {
    await send(panel);
    await finished(panel);
    assert.equal(requests.length, 3);
    assert.equal(await target.evaluate(() => window.clicks), 0);
    assert.ok(requests.every((body) => JSON.stringify(body.messages).length < 20000));
    assert.match(await panel.locator('body').innerText(), /无效操作参数/);
  });
});

test('失败后的提交只拦一次，读取最新页面后能继续完成', async () => {
  reply = (n, body) => n === 1 ? { actions: [{ action: 'click', ref: 999 }] }
    : n < 4 ? { actions: [{ action: 'submitForm', ref: buttonRef(body, 'Submit') }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '核对后提交本地测试表单');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.submits), 1);
    assert.equal(requests.length, 4);
    assert.match(JSON.stringify(requests[2].messages), /已拦下这一次提交并重新读取页面/);
  });
});

test('慢导航截断旧页后续动作，等待新文档再交给模型', async () => {
  oldPageClicks = 0;
  reply = (n) => n === 1 ? { actions: [{ action: 'navigate', value: webUrl + '/slow' }, { action: 'click', ref: 1 }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '跳转到新页面并汇报');
    await finished(panel);
    assert.equal(oldPageClicks, 0);
    assert.equal(requests.length, 2);
    assert.equal(await target.locator('body').innerText(), 'ARRIVED_NEW_PAGE');
    assert.match(JSON.stringify(requests[1].messages), /ARRIVED_NEW_PAGE/);
    assert.ok(!JSON.stringify(requests[1].messages).includes('OLD_DOCUMENT'));
  }, '/navigate');
});

for (const scenario of [
  { name: '普通链接点击', route: '/navigate-link', action: { action: 'click', ref: 1 }, oldRef: 2 },
  { name: '原生表单提交', route: '/navigate-form', action: { action: 'submitForm', ref: 2 }, oldRef: 3 },
  { name: 'Enter提交表单', route: '/navigate-form', action: { action: 'press', ref: 1, value: 'Enter' }, oldRef: 3 },
]) {
  test(`${scenario.name}的慢导航同样停止旧页后续操作`, async () => {
    oldPageClicks = 0;
    reply = (n) => n === 1 ? { actions: [scenario.action, { action: 'click', ref: scenario.oldRef }] } : complete;
    await withPanel(async (panel, target) => {
      await send(panel, '打开下一页面并汇报');
      await finished(panel);
      assert.equal(oldPageClicks, 0);
      assert.equal(requests.length, 2);
      assert.equal(await target.locator('body').innerText(), 'ARRIVED_NEW_PAGE');
      assert.match(JSON.stringify(requests[1].messages), /ARRIVED_NEW_PAGE/);
    }, scenario.route);
  });
}

test('204无新文档响应不会被当成导航成功', async () => {
  oldPageClicks = 0;
  reply = (n) => n === 1 ? { actions: [{ action: 'navigate', value: webUrl + '/no-document' }, { action: 'click', ref: 1 }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel);
    await finished(panel);
    assert.equal(oldPageClicks, 0);
    assert.equal(requests.length, 1);
    assert.equal(target.url(), webUrl + '/navigate');
    assert.match(await panel.locator('body').innerText(), /跳转未产生新文档或 URL 变化|页面跳转未完成/);
  }, '/navigate');
});

test('重定向回原URL但已生成新文档时允许继续', async () => {
  reply = (n) => n === 1 ? { actions: [{ action: 'navigate', value: webUrl + '/redirect-back' }] } : complete;
  await withPanel(async (panel, target) => {
    await target.evaluate(() => { window.__oldDocument = true; });
    await send(panel);
    await finished(panel);
    assert.equal(requests.length, 2);
    assert.equal(target.url(), webUrl + '/navigate');
    assert.equal(await target.evaluate(() => window.__oldDocument), undefined);
    await panel.getByText('任务完成', { exact: true }).waitFor();
  }, '/navigate');
});

test('合法长回答仅把规范化操作写入后续模型历史', async () => {
  reply = (n, body) => n === 1 ? { say: 'PAD'.repeat(100000), actions: [{ action: 'click', ref: buttonRef(body, 'Do work') }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel);
    await finished(panel);
    assert.equal(requests.length, 2, await panel.locator('body').innerText());
    assert.equal(await target.evaluate(() => window.clicks), 1);
    const history = JSON.stringify(requests[1].messages);
    assert.ok(history.length < 10000, `后续请求长度 ${history.length}`);
    assert.ok((history.match(/PAD/g) || []).length <= 683, '超长说明未按2048字符历史上限裁剪');
  });
});

test('模型请求等待中停止，旧响应不能污染下一任务', async () => {
  let started;
  let release;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  reply = async () => { started(); await hold; return { say: 'OLD_RESPONSE_MUST_NOT_APPEAR', done: true, actions: [] }; };
  await withPanel(async (panel, target) => {
    await send(panel, '任务一');
    await requestStarted;
    await panel.locator('#send').click();
    await finished(panel);
    assert.match(await panel.locator('body').innerText(), /任务已(?:停止|取消)/);
    assert.equal(requests.length, 1);
    release();
    reply = () => complete;
    await target.bringToFront();
    await send(panel, '任务二');
    await finished(panel);
    assert.equal(requests.length, 2);
    assert.ok(!(await panel.locator('body').innerText()).includes('OLD_RESPONSE_MUST_NOT_APPEAR'));
    await panel.getByText('任务完成', { exact: true }).waitFor();
  });
});
