'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.env.UI_ARTIFACT_DIR || path.join(os.homedir(), '.agents', 'temp', 'vias-page-agent', `agent-${Date.now()}`));
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

function bindingFixture(marker, long = false) {
  return `<!doctype html><meta charset="utf-8"><title>${marker}</title><p>${marker}</p>
<label for="note">任务备注</label><input id="note"><button id="work" type="button">Record task</button><p id="result">UNTOUCHED</p>
<a id="next" href="/binding-child" target="_blank">Open task child</a><button id="popup" type="button">Open task popup</button>
${marker.startsWith('B_') ? '<p>B_PRIVATE_DOCUMENT_MARKER</p><input type="password" value="B_PASSWORD_SENTINEL">' : ''}
${long ? `<p>${'binding-page-copy-'.repeat(2500)}</p><p>A_TAIL_ONLY_MARKER</p>` : ''}
<script>
window.clicks=0;window.inputEvents=0;window.popupAttempts=0;window.popupOpened=false;
popup.onclick=()=>{window.popupAttempts++;window.popupOpened=!!window.open(${JSON.stringify(marker.startsWith('B_') ? '/binding-b?popup=unrelated' : '/binding-child')},'_blank');};
note.oninput=()=>{window.inputEvents++;};
work.onclick=()=>{window.clicks++;result.textContent=${JSON.stringify(marker)}+':'+note.value+':'+window.clicks;};
</script>`;
}

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
    if (route.startsWith('/binding-')) {
      const marker = route === '/binding-b' ? 'B_UNRELATED_PAGE' : route === '/binding-child' ? 'FOLLOWED_CHILD_MARKER' : route === '/binding-next' ? 'FOLLOWED_NAVIGATION_MARKER' : 'A_TASK_MARKER';
      response.end(bindingFixture(marker, route === '/binding-long')); return;
    }
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
        response.end(JSON.stringify({ choices: [{ finish_reason: instruction?.__finishReason || 'stop', message: instruction?.__message || { content: typeof instruction === 'string' ? instruction : JSON.stringify(instruction) } }] }));
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

for (const ask of [false, true]) {
  for (const embedded of [false, true]) {
    test(`真实MV3${ask ? '问答' : '执行'}拒绝${embedded ? 'say内嵌' : '裸'}DSML，纠正后继续且不污染聊天和历史`, async () => {
      const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="vias_read"><｜DSML｜ parameter name="kind" string="false">"images"</｜DSML｜ parameter><｜DSML｜ parameter name="ids" string="false">[4]</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';
      reply = (n) => {
        if (n === 1) return embedded ? { say: dsml, actions: [{ action: 'click', selector: '#work' }] } : dsml;
        if (n === 2) return ask ? '正文回答：无需图片也可解释当前页面。' : { say: '现在点击目标', actions: [{ action: 'click', selector: '#work' }] };
        return complete;
      };
      await withPanel(async (panel, target) => {
        if (ask) await panel.locator('#modeAsk').click();
        await send(panel, ask ? '解释页面正文' : '点击 Do work 并汇报');
        await finished(panel);
        assert.equal(requests.length, ask ? 2 : 3);
        assert.equal(await target.evaluate(() => window.clicks), ask ? 0 : 1, '含内部协议的整条回复不得执行其中的动作');
        const displayed = await panel.locator('#chat').innerText();
        assert.ok(!displayed.includes('DSML'));
        assert.match(displayed, ask ? /正文回答/ : /任务完成/);
        assert.equal(await panel.locator('.tool-name').filter({ hasText: 'image analyze' }).count(), 0);
        for (const body of requests) {
          assert.ok(!JSON.stringify(body.messages).includes('<｜DSML｜'));
          assert.equal(body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).some((part) => part.type === 'image_url'), false);
        }
        const stored = JSON.stringify(await panel.evaluate(() => chrome.storage.session.get(null)));
        assert.ok(!stored.includes('<｜DSML｜'));
      });
    });
  }
}

for (const ask of [false, true]) {
  test(`真实MV3${ask ? '问答' : '执行'}原生工具协议错误跨侧栏回传后有界纠正`, async () => {
    const hidden = 'NATIVE_TOOL_CONTENT_MUST_NOT_APPEAR';
    reply = (n) => {
      if (n === 1) return { __finishReason: 'tool_calls', __message: { content: hidden, tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name: 'click', arguments: '{"selector":"#work"}' } }] } };
      if (n === 2) return ask ? '已恢复普通正文回答' : { say: '使用已支持的操作继续', actions: [{ action: 'click', selector: '#work' }] };
      return complete;
    };
    await withPanel(async (panel, target) => {
      if (ask) await panel.locator('#modeAsk').click();
      await send(panel, ask ? '解释页面' : '点击 Do work 并汇报');
      await finished(panel);
      assert.equal(requests.length, ask ? 2 : 3);
      assert.equal(await target.evaluate(() => window.clicks), ask ? 0 : 1);
      const displayed = await panel.locator('#chat').innerText();
      assert.ok(!displayed.includes(hidden));
      assert.match(displayed, ask ? /已恢复普通正文回答/ : /任务完成/);
      assert.ok(!JSON.stringify(requests).includes(hidden));
      assert.ok(!JSON.stringify(await panel.evaluate(() => chrome.storage.session.get(null))).includes(hidden));
    });
  });
}

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

test('真实侧栏整条拒绝损坏及 say 内嵌指令，纠正后才执行并保存', async () => {
  reply = (n) => n === 1 ? '{"say":"BROKEN_UI_MARKER","actions":[{"action":"click","selector":"#work"}],}'
    : n === 2 ? { say: '开始执行 {"actions":[{"action":"click","value":"EMBEDDED_UI_MARKER"}]}', actions: [{ action: 'click', selector: '#work' }] }
      : n === 3 ? { say: '纠正后开始执行', actions: [{ action: 'click', selector: '#work' }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '点击 Do work 并汇报');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 1, '前两条损坏回复均不得执行同条动作，仅纠正后的第三条执行一次');
    assert.equal(requests.length, 4);
    const displayed = await panel.locator('body').innerText();
    const stored = JSON.stringify(await panel.evaluate(() => chrome.storage.session.get(null)));
    for (const text of [displayed, stored, JSON.stringify(requests.slice(1))]) {
      assert.ok(!text.includes('BROKEN_UI_MARKER'));
      assert.ok(!text.includes('EMBEDDED_UI_MARKER'));
    }
    assert.match(displayed, /纠正后开始执行/);
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
        return { vias_read: { kind: 'images', snapshotId: text.match(/快照ID: ([^\n]+)/)[1], ids: [candidate.id], reason: '题目图中有正文未提供的图形信息，需要据此作答' } };
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
        const timeline = await panel.locator('#chat > .msg.ai, #chat > .tools').allTextContents();
        assert.match(timeline[0], /image analyze/);
        assert.match(timeline[0], /已读取/);
        if (ask) assert.match(timeline[1], /所选图片已识别/);
        else {
          assert.match(timeline[1], /click/);
          assert.match(timeline[2], /任务完成/);
        }
        assert.equal(await panel.locator('.tool.pending').count(), 0);
        fs.mkdirSync(artifacts, { recursive: true });
        await panel.setViewportSize({ width: 390, height: 850 });
        const screenshot = path.join(artifacts, `image-${ask ? 'ask' : 'agent'}-390.png`);
        await panel.screenshot({ path: screenshot });
        console.log(`Image timeline screenshot: ${screenshot}`);
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

test('页面无进展的同目标操作在ref刷新后连续三次才熔断', async () => {
  reply = (_n, body) => ({ actions: [{ action: 'click', ref: buttonRef(body, 'Do work') }] });
  await withPanel(async (panel, target) => {
    await target.evaluate(() => { document.querySelector('#work').onclick = () => { window.clicks++; }; });
    await send(panel);
    await finished(panel);
    assert.equal(await target.evaluate(() => window.clicks), 3);
    assert.equal(requests.length, 4);
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

test('失败后的提交只拦一次，继续提交后仍保留未确认失败提示', async () => {
  reply = (n, body) => n === 1 ? { actions: [{ action: 'click', ref: 999 }] }
    : n < 4 ? { actions: [{ action: 'submitForm', ref: buttonRef(body, 'Submit') }] } : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '核对后提交本地测试表单');
    await finished(panel);
    assert.equal(await target.evaluate(() => window.submits), 1);
    assert.equal(requests.length, 4);
    assert.match(JSON.stringify(requests[2].messages), /已拦下这一次提交并重新读取页面/);
    assert.match(await panel.locator('body').innerText(), /任务已结束，但仍有操作未获成功确认/);
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
    assert.equal(await panel.locator('.tool-state').last().textContent(), '已跳过');
    assert.equal(await panel.locator('.tool').last().evaluate((row) => row.classList.contains('fail')), false);
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
  reply = (n, body) => n === 1 ? { say: 'PAD'.repeat(60000), actions: [{ action: 'click', ref: buttonRef(body, 'Do work') }] } : complete;
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

function heldModelReply() {
  let arrived;
  let release;
  const started = new Promise((resolve) => { arrived = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  return {
    receive: (body) => { arrived(body); return response; },
    release,
    wait: async () => {
      let timer;
      try {
        return await Promise.race([started, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('本地模型请求未在15秒内到达')), 15000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

async function extensionTab(panel, page) {
  if (page.url().startsWith(`chrome-extension://${extensionId}/`)) {
    const tab = await page.evaluate(() => chrome.tabs.getCurrent());
    assert.ok(tab?.id, '扩展测试页必须有自己的tabId');
    return tab;
  }
  const tabs = await panel.evaluate(async (url) => (await chrome.tabs.query({})).filter((item) => item.url === url), page.url());
  assert.equal(tabs.length, 1, `测试URL必须唯一标识标签页 ${page.url()}`);
  return tabs[0];
}

async function activateTab(panel, tab) {
  await panel.evaluate(async ({ id, windowId }) => {
    await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(windowId, { focused: true });
  }, tab);
}

async function newWindowPage(panel, url) {
  const opened = context.waitForEvent('page', { timeout: 10000 });
  await panel.evaluate((url) => chrome.windows.create({ url, type: 'normal', width: 900, height: 850 }), url);
  const page = await opened;
  await page.waitForLoadState('domcontentloaded');
  await page.waitForURL(url);
  return page;
}

async function assertRunning(panel) {
  assert.equal(await panel.locator('#clear').isDisabled(), true, '正常切页不能结束侧栏任务');
  assert.equal((await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'PING' }))).running, true, '正常切页不能取消后台任务');
}

async function bindingState(page) {
  return page.evaluate(() => ({ value: document.querySelector('#note').value, clicks: window.clicks, inputs: window.inputEvents, result: document.querySelector('#result').textContent }));
}

function assertNoBContent(body) {
  const serialized = JSON.stringify(body.messages);
  for (const marker of ['B_UNRELATED_PAGE', 'B_PRIVATE_DOCUMENT_MARKER', 'B_PASSWORD_SENTINEL']) {
    assert.ok(!serialized.includes(marker), `非任务页内容不能进入模型请求: ${marker}`);
  }
}

for (const otherWindow of [false, true]) {
  test(`真实MV3任务绑定：模型挂起时多次切换${otherWindow ? '标签及不同窗口' : '标签'}，后台A继续读取填写点击且B零副作用`, { timeout: 90000 }, async () => {
    const gates = Array.from({ length: 4 }, heldModelReply);
    reply = (n, body) => { assert.ok(n <= gates.length); return gates[n - 1].receive(body); };
    await withPanel(async (panel, target) => {
      const decoys = [];
      try {
        const decoy = await context.newPage(); decoys.push(decoy);
        await decoy.goto(webUrl + '/binding-b');
        if (otherWindow) decoys.push(await newWindowPage(panel, webUrl + '/binding-b?window=other'));
        const taskTab = await extensionTab(panel, target);
        const decoyTabs = await Promise.all(decoys.map((page) => extensionTab(panel, page)));
        assert.equal(decoyTabs[0].windowId, taskTab.windowId);
        if (otherWindow) assert.notEqual(decoyTabs[1].windowId, taskTab.windowId, '必须实际创建第二个Edge窗口');
        await activateTab(panel, taskTab);
        await send(panel, '只在任务页面读取第二段并填写任务备注，然后分两轮点击 Record task');
        for (let index = 0; index < gates.length; index++) {
          const body = await gates[index].wait();
          assertNoBContent(body);
          const latest = body.messages.at(-1).content;
          assert.equal(typeof latest, 'string');
          if (index === 0) assert.match(latest, /A_TASK_MARKER/);
          if (index === 1) assert.match(latest, /A_TAIL_ONLY_MARKER/, '后台分段读取仍必须来自A');
          if (index >= 2) {
            assert.match(latest, /A_TASK_MARKER:A_FILLED_VALUE:/, '操作后的新观察仍必须来自A');
            assert.equal((await panel.evaluate((id) => chrome.tabs.get(id), taskTab.id)).active, false, '填写点击后A仍必须是非活动标签');
          }
          for (const tab of [decoyTabs[0], taskTab, ...decoyTabs, taskTab, ...decoyTabs]) await activateTab(panel, tab);
          const state = await panel.evaluate(async ({ taskId, decoyIds }) => ({
            task: await chrome.tabs.get(taskId), decoys: await Promise.all(decoyIds.map((id) => chrome.tabs.get(id))),
            focusedWindow: (await chrome.windows.getLastFocused()).id,
          }), { taskId: taskTab.id, decoyIds: decoyTabs.map((tab) => tab.id) });
          assert.equal(state.task.active, false, '发回模型回复时A必须不是活动标签');
          assert.equal(state.decoys[0].active, true);
          assert.equal(state.focusedWindow, decoyTabs.at(-1).windowId);
          await assertRunning(panel);
          if (index === 0) gates[index].release({ vias_read: { kind: 'segment', snapshotId: latest.match(/快照ID: ([^\n]+)/)?.[1], index: 1 } });
          else if (index === 1) gates[index].release({ actions: [{ action: 'fill', selector: '#note', value: 'A_FILLED_VALUE' }, { action: 'click', selector: '#work' }] });
          else if (index === 2) gates[index].release({ actions: [{ action: 'click', ref: buttonRef(body, 'Record task') }] });
          else gates[index].release(complete);
        }
        await finished(panel);
        assert.equal(requests.length, 4);
        for (const body of requests) assertNoBContent(body);
        assert.deepEqual(await bindingState(target), { value: 'A_FILLED_VALUE', clicks: 2, inputs: 1, result: 'A_TASK_MARKER:A_FILLED_VALUE:2' });
        for (const decoy of decoys) assert.deepEqual(await bindingState(decoy), { value: '', clicks: 0, inputs: 0, result: 'UNTOUCHED' });
        await panel.getByText('任务完成', { exact: true }).waitFor();
        assert.doesNotMatch(await panel.locator('#chat').innerText(), /任务已(?:停止|取消)/);
      } finally {
        for (const gate of gates) gate.release(complete);
        for (const decoy of decoys) await decoy.close();
      }
    }, '/binding-long');
  });
}

async function watchNavigationSource(worker, url) {
  await worker.evaluate((url) => {
    globalThis.__integrationNavigationTarget = null;
    globalThis.__integrationNavigationObserver = (details) => {
      if (details.url !== url) return;
      globalThis.__integrationNavigationTarget = {
        sourceTabId: details.sourceTabId, sourceFrameId: details.sourceFrameId, tabId: details.tabId,
        capturing: !!activeRun?.capturingNewTabs, executionTabId: activeRun?.executionTabId,
      };
      chrome.webNavigation.onCreatedNavigationTarget.removeListener(globalThis.__integrationNavigationObserver);
      delete globalThis.__integrationNavigationObserver;
    };
    chrome.webNavigation.onCreatedNavigationTarget.addListener(globalThis.__integrationNavigationObserver);
  }, url);
}

async function clearNavigationObserver(worker) {
  await worker.evaluate(() => {
    if (globalThis.__integrationNavigationObserver) chrome.webNavigation.onCreatedNavigationTarget.removeListener(globalThis.__integrationNavigationObserver);
    delete globalThis.__integrationNavigationObserver;
    delete globalThis.__integrationNavigationTarget;
  });
}

for (const { newTab, background } of [
  { newTab: false, background: true },
  { newTab: true, background: false },
  { newTab: true, background: true },
]) {
  test(`真实MV3任务跟随：${background ? '切到B后' : 'A活动时'}仍跟随任务自身${newTab ? '点击打开的新标签' : '导航的新文档'}，后续后台操作不误落B`, { timeout: 60000 }, async () => {
    const gates = Array.from({ length: 3 }, heldModelReply);
    reply = (n, body) => { assert.ok(n <= gates.length); return gates[n - 1].receive(body); };
    await withPanel(async (panel, target) => {
      let decoy;
      let followed;
      const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${extensionId}/`));
      try {
        if (newTab) await watchNavigationSource(worker, webUrl + '/binding-child');
        decoy = await context.newPage();
        await decoy.goto(webUrl + '/binding-b');
        const taskTab = await extensionTab(panel, target);
        const decoyTab = await extensionTab(panel, decoy);
        await activateTab(panel, taskTab);
        await send(panel, newTab ? '点击 Open task popup，在新标签填写并点击 Record task' : '导航到下一文档，在该页填写并点击 Record task');
        assert.match((await gates[0].wait()).messages.at(-1).content, /A_TASK_MARKER/);
        if (background) await activateTab(panel, decoyTab);
        await assertRunning(panel);
        gates[0].release({ actions: [newTab ? { action: 'click', selector: '#popup' } : { action: 'navigate', value: webUrl + '/binding-next' }] });
        const second = await gates[1].wait();
        const marker = newTab ? 'FOLLOWED_CHILD_MARKER' : 'FOLLOWED_NAVIGATION_MARKER';
        followed = newTab ? context.pages().find((page) => page.url() === webUrl + '/binding-child') : target;
        assert.match(second.messages.at(-1).content, new RegExp(marker));
        assertNoBContent(second);
        assert.ok(followed, '必须存在已被模型观察到的任务后续页');
        const followedTab = await extensionTab(panel, followed);
        assert.equal(followedTab.id === taskTab.id, !newTab, '导航保留tabId，操作开页必须换tabId');
        if (newTab) {
          const navigationTarget = await worker.evaluate(() => globalThis.__integrationNavigationTarget);
          assert.equal(navigationTarget?.tabId, followedTab.id);
          assert.equal(navigationTarget.sourceTabId, taskTab.id, '使用浏览器来源事件核实真实任务页，不能信任Edge活动页归属');
          assert.equal(navigationTarget.sourceFrameId, 0);
          assert.equal(await followed.evaluate(() => window.opener?.location.href || null), webUrl + '/binding-opener');
          assert.deepEqual(await target.evaluate(() => ({ attempts: window.popupAttempts, opened: window.popupOpened })), { attempts: 1, opened: true });
        }
        await activateTab(panel, decoyTab);
        await assertRunning(panel);
        gates[1].release({ actions: [{ action: 'fill', selector: '#note', value: 'FOLLOWED_VALUE' }, { action: 'click', ref: buttonRef(second, 'Record task') }] });
        const third = await gates[2].wait();
        assert.match(third.messages.at(-1).content, new RegExp(`${marker}:FOLLOWED_VALUE:1`));
        gates[2].release(complete);
        await finished(panel);
        assert.equal(requests.length, 3);
        for (const body of requests) assertNoBContent(body);
        assert.deepEqual(await bindingState(followed), { value: 'FOLLOWED_VALUE', clicks: 1, inputs: 1, result: `${marker}:FOLLOWED_VALUE:1` });
        assert.equal((await panel.evaluate((id) => chrome.tabs.get(id), followedTab.id)).active, false, '跟随后切回B，填写点击不能激活任务页');
        assert.deepEqual(await bindingState(decoy), { value: '', clicks: 0, inputs: 0, result: 'UNTOUCHED' });
        if (newTab) assert.deepEqual(await bindingState(target), { value: '', clicks: 0, inputs: 0, result: 'UNTOUCHED' });
        await panel.getByText('任务完成', { exact: true }).waitFor();
      } finally {
        for (const gate of gates) gate.release(complete);
        if (newTab && worker) await clearNavigationObserver(worker);
        if (followed && followed !== target) await followed.close();
        await decoy?.close();
      }
    }, '/binding-opener');
  });
}

test('真实MV3反向隔离：A操作捕获窗口内后台B自行开页，来源B即使被Edge标为A的opener也不能接管任务', { timeout: 90000 }, async () => {
  const gates = Array.from({ length: 2 }, heldModelReply);
  reply = (n, body) => { assert.ok(n <= gates.length); return gates[n - 1].receive(body); };
  await withPanel(async (panel, target) => {
    const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${extensionId}/`));
    let decoy;
    let unrelated;
    try {
      await watchNavigationSource(worker, webUrl + '/binding-b?popup=unrelated');
      decoy = await context.newPage();
      await decoy.goto(webUrl + '/binding-b');
      const taskTab = await extensionTab(panel, target);
      const decoyTab = await extensionTab(panel, decoy);
      await activateTab(panel, taskTab);
      await send(panel, '等待本地门闩出现后，只点击当前任务页面的 Record task');
      assert.match((await gates[0].wait()).messages.at(-1).content, /A_TASK_MARKER/);
      gates[0].release({ actions: [{ action: 'wait', selector: '#releaseTask', timeout: 15000 }, { action: 'click', selector: '#work' }] });
      const deadline = Date.now() + 5000;
      let capturing = false;
      while (Date.now() < deadline && !capturing) {
        capturing = await worker.evaluate(() => !!activeRun?.capturingNewTabs && !!activeRun?.newTabOperationId);
        if (!capturing) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(capturing, true, 'B必须在真实操作的新标签捕获窗口内开页');
      assert.equal((await panel.evaluate((id) => chrome.tabs.get(id), taskTab.id)).active, true);
      const opened = context.waitForEvent('page', { timeout: 10000 });
      await decoy.evaluate(() => document.querySelector('#popup').click());
      unrelated = await opened;
      await unrelated.waitForLoadState('domcontentloaded');
      await unrelated.waitForURL(webUrl + '/binding-b?popup=unrelated');
      const unrelatedTab = await extensionTab(panel, unrelated);
      const event = await worker.evaluate(() => globalThis.__integrationNavigationTarget);
      assert.equal(event?.tabId, unrelatedTab.id);
      assert.equal(event.sourceTabId, decoyTab.id);
      assert.equal(event.capturing, true);
      assert.equal(event.executionTabId, taskTab.id);
      await target.evaluate(() => {
        const latch = document.createElement('span'); latch.id = 'releaseTask'; latch.textContent = '门闩已打开'; document.body.append(latch);
      });
      const second = await gates[1].wait();
      assertNoBContent(second);
      assert.match(second.messages.at(-1).content, /A_TASK_MARKER::1/);
      gates[1].release(complete);
      await finished(panel);
      assert.equal(requests.length, 2);
      for (const body of requests) assertNoBContent(body);
      assert.deepEqual(await bindingState(target), { value: '', clicks: 1, inputs: 0, result: 'A_TASK_MARKER::1' });
      for (const page of [decoy, unrelated]) assert.deepEqual(await bindingState(page), { value: '', clicks: 0, inputs: 0, result: 'UNTOUCHED' });
      await panel.getByText('任务完成', { exact: true }).waitFor();
    } finally {
      for (const gate of gates) gate.release(complete);
      await clearNavigationObserver(worker);
      await unrelated?.close();
      await decoy?.close();
    }
  }, '/binding-opener');
});

async function openPromptOptions(panel, otherWindow = false) {
  const url = `chrome-extension://${extensionId}/options.html`;
  const options = otherWindow ? await newWindowPage(panel, url) : await context.newPage();
  if (!otherWindow) await options.goto(url);
  await options.waitForFunction(() => latestPromptState !== null);
  return options;
}

async function saveSystemPrompt(options, text) {
  await options.locator('#systemPrompt').fill(text);
  await options.locator('#btnSavePrompt').click();
  await options.waitForFunction(() => !promptDirty && !promptSaving && !document.querySelector('#btnSavePrompt').disabled);
  assert.equal((await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }))).systemPrompt, text);
}

function assertSystemPrompt(body, expected, absent = []) {
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.startsWith(expected + '\n'), 'system消息必须使用实际保存的全局提示词');
  const outputRules = body.messages[0].content.split('\n').at(-1);
  assert.match(outputRules, /遵循用户指定的语言、格式和长度/);
  assert.match(outputRules, /value只放字段需要的内容/);
  assert.match(outputRules, /say用于简短进度/);
  for (const text of absent) assert.ok(!body.messages[0].content.includes(text), `system消息混入了非本任务提示词: ${text}`);
}

test('真实MV3设置页UI保存提示词后，同一侧栏的下一任务立即使用新system消息并移除旧文本', { timeout: 60000 }, async () => {
  reply = () => complete;
  await withPanel(async (panel, target) => {
    const options = await openPromptOptions(panel);
    const original = await options.locator('#systemPrompt').inputValue();
    try {
      const taskTab = await extensionTab(panel, target);
      const oldPrompt = 'UI_SAVED_OLD_PROMPT：本地回归旧提示词。';
      const nextPrompt = 'UI_SAVED_NEXT_PROMPT：本地回归更新提示词。';
      await saveSystemPrompt(options, oldPrompt);
      await activateTab(panel, taskTab);
      await send(panel, '检查首次保存的提示词'); await finished(panel);
      assert.equal(requests.length, 1);
      assertSystemPrompt(requests[0], oldPrompt, [nextPrompt]);
      await saveSystemPrompt(options, nextPrompt);
      await activateTab(panel, taskTab);
      await send(panel, '检查修改提示词后的下一任务'); await finished(panel);
      assert.equal(requests.length, 2);
      assertSystemPrompt(requests[1], nextPrompt, [oldPrompt]);
      await panel.getByText('任务完成', { exact: true }).last().waitFor();
    } finally {
      await saveSystemPrompt(options, original);
      await options.close();
    }
  });
});

test('真实MV3提示词生命周期：跨窗口更新与未保存草稿不串用，运行中保持启动快照而下一任务采用新版本', { timeout: 90000 }, async () => {
  const gates = Array.from({ length: 2 }, heldModelReply);
  reply = (n, body) => n <= gates.length ? gates[n - 1].receive(body) : complete;
  await withPanel(async (panel, target) => {
    const optionsA = await openPromptOptions(panel);
    const original = await optionsA.locator('#systemPrompt').inputValue();
    let optionsB;
    try {
      const oldPrompt = 'PROMPT_BASE_SAVED：外部更新前的版本。';
      const draft = 'PROMPT_DRAFT_UNSAVED：只能显式核对并保存后才生效。';
      const external = 'PROMPT_EXTERNAL_START：本任务启动时的已保存版本。';
      const updated = 'PROMPT_EXTERNAL_LATER：运行中保存，仅供下一任务使用。';
      await saveSystemPrompt(optionsA, oldPrompt);
      optionsB = await openPromptOptions(panel, true);
      assert.notEqual((await extensionTab(panel, optionsA)).windowId, (await extensionTab(panel, optionsB)).windowId);
      await optionsA.locator('#systemPrompt').fill(draft);
      await saveSystemPrompt(optionsB, external);
      await optionsA.locator('#promptConflict').waitFor({ state: 'visible' });
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), draft);
      assert.equal(await optionsA.locator('#latestPrompt').inputValue(), external);
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !promptSaving);
      assert.equal(await optionsA.locator('#promptConflict').isVisible(), true);
      assert.match(await optionsA.locator('#promptStatus').textContent(), /草稿已保留/);
      assert.equal((await optionsA.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }))).systemPrompt, external, '旧revision草稿不能静默覆盖外部保存');
      const taskTab = await extensionTab(panel, target);
      await activateTab(panel, taskTab);
      await send(panel, '点击 Do work 并汇报');
      assertSystemPrompt(await gates[0].wait(), external, [oldPrompt, draft, updated]);
      await saveSystemPrompt(optionsB, updated);
      await optionsA.waitForFunction((text) => document.querySelector('#latestPrompt').value === text, updated);
      assert.equal(await optionsA.locator('#systemPrompt').inputValue(), draft, '外部更新不得覆盖未保存的本地草稿');
      await assertRunning(panel);
      gates[0].release({ actions: [{ action: 'click', selector: '#work' }] });
      assertSystemPrompt(await gates[1].wait(), external, [oldPrompt, draft, updated]);
      gates[1].release(complete);
      await finished(panel);
      assert.equal(requests.length, 2);
      assert.equal(await target.evaluate(() => window.clicks), 1);
      await activateTab(panel, taskTab);
      await send(panel, '新任务采用外部最新已保存提示词'); await finished(panel);
      assert.equal(requests.length, 3);
      assertSystemPrompt(requests[2], updated, [oldPrompt, external, draft]);
      await optionsA.locator('#btnRebasePrompt').click();
      await optionsA.locator('#btnSavePrompt').click();
      await optionsA.waitForFunction(() => !promptDirty && !promptSaving);
      await activateTab(panel, taskTab);
      await send(panel, '草稿明确核对保存后才生效'); await finished(panel);
      assert.equal(requests.length, 4);
      assertSystemPrompt(requests[3], draft, [oldPrompt, external, updated]);
      await panel.getByText('任务完成', { exact: true }).last().waitFor();
    } finally {
      for (const gate of gates) gate.release(complete);
      await optionsA.reload();
      await optionsA.waitForFunction(() => latestPromptState !== null);
      await saveSystemPrompt(optionsA, original);
      await optionsB?.close();
      await optionsA.close();
    }
  });
});

test('真实MV3长文本：超过20k的Unicode问题完整发送，超过50k的问答显示保存并在同窗口重开后完整回传历史', { timeout: 90000 }, async () => {
  const question = 'Q'.repeat(24000) + '问题尾标记_中文_🙂_QUESTION_END';
  const answer = '答'.repeat(55000) + '答案尾标记_中文_🙂_ANSWER_END';
  reply = (n) => n === 1 ? answer : '重开侧栏后的问答已完成';
  await withPanel(async (panel, target) => {
    let reopened;
    const windowId = (await extensionTab(panel, panel)).windowId;
    const originalSessionKey = await panel.evaluate(() => sessionKey);
    assert.equal(originalSessionKey, `chat:${windowId}`);
    try {
      await panel.locator('#modeAsk').click();
      await send(panel, question); await finished(panel);
      assert.equal(requests.length, 1);
      assert.ok(requests[0].messages.at(-1).content.includes(question), 'RUN与模型请求必须包含完整长问题及Unicode尾标记');
      assert.equal(await panel.locator('#chat > .msg.user').textContent(), question);
      assert.ok((await panel.locator('#chat > .msg.ai .md-content').innerText()).trim() === answer, '问答正文在UI中必须完整显示到Unicode尾标记');
      await panel.evaluate(() => persistQueue);
      const saved = await panel.evaluate(async () => (await chrome.storage.session.get(sessionKey))[sessionKey]);
      assert.ok(saved.some((item) => item.role === 'user' && item.content === question), '完整问题必须持久化');
      assert.ok(saved.some((item) => item.role === 'assistant' && item.content === answer), '完整长答案必须持久化');
      await panel.close();
      reopened = await context.newPage();
      await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await reopened.waitForFunction(() => initialized && !document.querySelector('#clear').disabled);
      assert.equal((await extensionTab(reopened, reopened)).windowId, windowId, '必须在原Edge窗口重新打开侧栏');
      assert.equal(await reopened.evaluate(() => sessionKey), originalSessionKey, '重开前后必须使用同一窗口sessionKey');
      assert.ok((await reopened.locator('#chat > .msg.ai .md-content').innerText()).trim() === answer, '重开后完整恢复长答案');
      await reopened.locator('#modeAsk').click();
      await activateTab(reopened, await extensionTab(reopened, target));
      await send(reopened, '根据刚才长答案的尾部继续回答'); await finished(reopened);
      assert.equal(requests.length, 2);
      assert.ok(requests[1].messages.some((item) => item.role === 'assistant' && item.content === answer),
        `下一次真实请求必须保留完整长答案: ${JSON.stringify({ historyLimit: await reopened.evaluate(() => globalThis.ViasCore.TEXT_LIMITS.history), messages: requests[1].messages.map((item) => ({ role: item.role, length: typeof item.content === 'string' ? item.content.length : 0, questionTail: JSON.stringify(item.content).includes('QUESTION_END'), answerTail: JSON.stringify(item.content).includes('ANSWER_END') })) })}`);
      await reopened.getByText('重开侧栏后的问答已完成', { exact: true }).waitFor();
    } finally { await reopened?.close(); }
  });
});

test('真实MV3大JSON：完整Unicode转义的200000字合法fill跨越旧1M协议上限，实际填写全量后done', { timeout: 90000 }, async () => {
  const raw = '{"actions":[{"action":"fill","selector":"#note","value":"' + '\\u4e2d'.repeat(200000) + '"}]}';
  assert.ok(raw.length > 1000000 && raw.length < 3000000);
  reply = (n) => n === 1 ? raw : complete;
  await withPanel(async (panel, target) => {
    await send(panel, '填写本地备注字段中的20万个中文字并核对完成'); await finished(panel);
    assert.equal(requests.length, 2, '大JSON必须作为合法指令一次执行并完成核对');
    assert.deepEqual(await target.evaluate(() => {
      const value = document.querySelector('#note').value;
      return { length: value.length, allChinese: /^中+$/.test(value), inputs: window.inputEvents };
    }), { length: 200000, allChinese: true, inputs: 1 });
    const feedback = JSON.parse(requests[1].messages.at(-1).content.match(/^操作结果: (\[[^\n]*\])/m)?.[1] || 'null');
    assert.equal(feedback?.[0]?.ok, true);
    await panel.getByText('任务完成', { exact: true }).waitFor();
  }, '/binding-opener');
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
