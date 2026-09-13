'use strict';

// 多选题与 Element UI 隐藏 input 选项的回归测试
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const contentScript = path.join(root, 'content.js');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const ELEMENT_UI_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ElementUI</title>
<style>.el-checkbox__original,.el-radio__original{opacity:0;position:absolute;left:-9999px}</style></head><body>
<div class="subjectDet"><div class="title">1.【多选题】</div>
<label class="el-checkbox"><input class="el-checkbox__original" type="checkbox"><span class="el-checkbox__label">MySQL</span></label>
<label class="el-checkbox"><input class="el-checkbox__original" type="checkbox"><span class="el-checkbox__label">Redis</span></label>
<label class="el-checkbox"><input class="el-checkbox__original" type="checkbox"><span class="el-checkbox__label">红烧肉</span></label></div>
<div class="subjectDet"><div class="title">2.【单选题】</div>
<label class="el-radio"><input class="el-radio__original" type="radio" name="q2"><span class="el-radio__label">结构化查询语言</span></label>
<label class="el-radio"><input class="el-radio__original" type="radio" name="q2"><span class="el-radio__label">编程语言</span></label></div>
</body></html>`;

const quizHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>多选题测试</title>
<style>
  .opt { display:block; margin:10px; padding:8px; border:1px solid #ccc; cursor:pointer; }
  .opt input { margin-right:8px; }
  .opt.checked { background:#e0f0ff; }
</style></head><body>
<h1>1. 下列哪些是编程语言？</h1>
<label class="opt" id="optA"><input type="checkbox" id="cA" value="A">Python</label>
<label class="opt" id="optB"><input type="checkbox" id="cB" value="B">Java</label>
<label class="opt" id="optC"><input type="checkbox" id="cC" value="C">汉堡</label>
<label class="opt" id="optD"><input type="checkbox" id="cD" value="D">JavaScript</label>
<button id="submit">提交答案</button>
<script>
  document.querySelectorAll('.opt input').forEach((input) => {
    input.addEventListener('change', () => {
      input.closest('.opt').classList.toggle('checked', input.checked);
      // 模拟 React 异步重渲染
      setTimeout(() => {
        const h = document.querySelector('h1');
        h.dataset.render = (Number(h.dataset.render || 0) + 1);
      }, 120);
    });
  });
</script></body></html>`;

let browser, server, url;

test.before(async () => {
  server = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end(q.url === '/element' ? ELEMENT_UI_HTML : quizHtml);
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
});
test.after(async () => { await browser?.close(); server.close(); });

async function openQuizPage(pathname = '/quiz') {
  const page = await browser.newPage();
  await page.goto(url + pathname, { waitUntil: 'load' });
  await page.evaluate(() => {
    const onMessage = { addListener(l) { globalThis.__l = l; } };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { onMessage } } });
  });
  await page.addScriptTag({ path: contentScript });
  await page.waitForFunction(() => typeof globalThis.__l === 'function');
  return page;
}

function send(page, message) {
  return page.evaluate((payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('响应超时')), 25000);
    globalThis.__l(payload, {}, (resp) => { clearTimeout(timer); resolve(resp); });
  }), message);
}

test('快照应列出4个复选项', async () => {
  const page = await openQuizPage();
  const snap = await send(page, { type: 'EXTRACT', runId: 'r1', maxLen: 16000 });
  assert.ok(snap.snapshotId, '应有 snapshotId');
  const optLines = Object.values(snap.targets).filter((t) => t.includes('复选'));
  console.log('快照选项行:', optLines);
  assert.equal(optLines.length, 4);
  await page.close();
});

test('一批内连续 check 两个选项', async () => {
  const page = await openQuizPage();
  const snap = await send(page, { type: 'EXTRACT', runId: 'r1', maxLen: 16000 });
  const refs = Object.entries(snap.targets).filter(([, t]) => t.includes('复选')).map(([id]) => Number(id));
  const res = await send(page, {
    type: 'EXECUTE', runId: 'r1', operationId: 'op1', snapshotId: snap.snapshotId,
    actions: refs.slice(0, 2).map((ref) => ({ action: 'check', ref })),
  });
  console.log('批量结果:', res.results.map((r) => ({ ok: r.ok, code: r.code, msg: r.msg })));
  assert.ok(res.results.every((r) => r.ok), '批量 check 应全部成功');
  const states = await page.evaluate(() => ['cA', 'cB', 'cC', 'cD'].map((id) => document.getElementById(id).checked));
  assert.deepEqual(states, [true, true, false, false]);
  await page.close();
});

test('模拟 Agent 实际节奏：每批后重提取，连续三批各勾一个', async () => {
  const page = await openQuizPage();
  let runSeq = 0;
  for (let round = 0; round < 3; round++) {
    runSeq += 1;
    const snap = await send(page, { type: 'EXTRACT', runId: `r${runSeq}`, maxLen: 16000 });
    const unchecked = Object.entries(snap.targets).filter(([, t]) => t.includes('复选') && t.includes('未选'));
    if (!unchecked.length) break;
    const [ref, desc] = unchecked[0];
    const res = await send(page, {
      type: 'EXECUTE', runId: `r${runSeq}`, operationId: `op${runSeq}`, snapshotId: snap.snapshotId,
      actions: [{ action: 'check', ref: Number(ref) }],
    });
    console.log(`round${round + 1}: 勾选 ref=${ref} ${desc.slice(0, 30)} ->`, res.results.map((r) => `${r.ok ? 'OK' : 'FAIL:' + r.code} ${r.msg || ''}`));
    assert.ok(res.results[0].ok, `第${round + 1}轮 check 应成功: ${JSON.stringify(res.results[0])}`);
  }
  const states = await page.evaluate(() => ['cA', 'cB', 'cC', 'cD'].map((id) => document.getElementById(id).checked));
  assert.deepEqual(states, [true, true, true, false]);
  await page.close();
});

test('check 目标是 LABEL 映射后的 input，且已勾选项返回 NO_CHANGE', async () => {
  const page = await openQuizPage();
  await page.evaluate(() => document.getElementById('cB').click());
  const snap = await send(page, { type: 'EXTRACT', runId: 'r1', maxLen: 16000 });
  const entry = Object.entries(snap.targets).find(([, t]) => t.includes('Java'));
  console.log('Java 选项快照行:', entry[1]);
  assert.ok(entry[1].includes('已选中'), '快照应反映已选中');
  const res = await send(page, {
    type: 'EXECUTE', runId: 'r1', operationId: 'op1', snapshotId: snap.snapshotId,
    actions: [{ action: 'check', ref: Number(entry[0]) }],
  });
  console.log('重复 check 结果:', res.results[0]);
  assert.equal(res.results[0].code, 'NO_CHANGE');
  const still = await page.evaluate(() => document.getElementById('cB').checked);
  assert.ok(still);
  await page.close();
});

test('Element UI 风格：opacity:0 隐藏 input 的 label 选项必须拿到编号并可勾选（回归：多选题选不上）', async () => {
  const page = await openQuizPage('/element');
  const snap = await send(page, { type: 'EXTRACT', runId: 'r1', maxLen: 16000 });
  const checks = Object.entries(snap.targets).filter(([, t]) => t.includes('复选'));
  assert.equal(checks.length, 3, '3 个复选项都应有编号: ' + JSON.stringify(snap.targets));
  const refs = checks.map(([id]) => Number(id));
  const res = await send(page, {
    type: 'EXECUTE', runId: 'r1', operationId: 'op1', snapshotId: snap.snapshotId,
    actions: refs.map((ref) => ({ action: 'check', ref })),
  });
  assert.ok(res.results.every((r) => r.ok), '批量 check 应全部成功: ' + JSON.stringify(res.results));
  const states = await page.evaluate(() => [...document.querySelectorAll('.el-checkbox__original')].map((i) => i.checked));
  assert.deepEqual(states, [true, true, true]);

  const snap2 = await send(page, { type: 'EXTRACT', runId: 'r2', maxLen: 16000 });
  const radios = Object.entries(snap2.targets).filter(([, t]) => t.includes('单选'));
  assert.ok(radios.length >= 2, '单选项应有编号');
  const res2 = await send(page, {
    type: 'EXECUTE', runId: 'r2', operationId: 'op2', snapshotId: snap2.snapshotId,
    actions: [{ action: 'checkRadio', ref: Number(radios[0][0]) }],
  });
  assert.ok(res2.results[0].ok, JSON.stringify(res2.results[0]));
  const radioChecked = await page.evaluate(() => [...document.querySelectorAll('.el-radio__original')].map((i) => i.checked));
  assert.deepEqual(radioChecked, [true, false]);
  await page.close();
});
