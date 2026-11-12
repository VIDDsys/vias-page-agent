'use strict';
// 执行侧极端场景：操作在病态页面上是否安全返回（不挂死、不误报成功）
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..', '..');
const contentScript = path.join(root, 'content.js');
const edgePath = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// [名称, HTML, 动作, 预期码, 超时毫秒]
// 超时按各动作的真实上界给：wait 上限 30s；repeat 100 次每次含稳定等待约 0.4s，合计约 40s。
// 低于真实上界判定会得到假阳性「疑似挂死」。
const CASES = [
  ['点击会抛异常的处理器', `<button id="b">炸按钮</button><script>b.onclick=()=>{throw new Error('boom')}</script>`, [{ action: 'click', selector: '#b' }], ['已点击'], 25000],
  ['点击删除自身', `<div id="wrap"><button id="b">自杀按钮</button></div><script>b.onclick=()=>wrap.remove()</script>`, [{ action: 'click', selector: '#b' }], ['已点击'], 25000],
  ['点击后同步跳转', `<button id="b">跳转</button><script>b.onclick=()=>location.hash='x'</script>`, [{ action: 'click', selector: '#b' }], ['NAVIGAT'], 25000],
  ['悬停超大元素', `<div id="huge" style="width:5000px;height:3000px;background:#eee">巨大区域</div>`, [{ action: 'hover', selector: '#huge' }], ['已悬停'], 25000],
  ['滚动到不存在的位置', `<div style="height:50px">短页面</div>`, [{ action: 'scroll', value: 999999 }], ['已滚动'], 25000],
  ['超长 wait 必须被钳到 30 秒上限', `<button>按钮</button>`, [{ action: 'wait', value: 999999 }], ['已等待 30000ms'], 40000],
  ['repeat 极值 100 次', `<button id="b">计数</button><script>window.n=0;b.onclick=()=>n++</script>`, [{ action: 'repeat', times: 100, value: 0, actions: [{ action: 'click', selector: '#b' }] }], ['循环 100 轮'], 90000],
  ['js: 链接必须被拦', `<a id="l" href="javascript:alert(1)">恶意链接</a>`, [{ action: 'click', selector: '#l' }], ['CLICK_BLOCKED'], 25000],
  ['data: 链接必须被拦', `<a id="l" href="data:text/html,<b>x</b>">数据链接</a>`, [{ action: 'click', selector: '#l' }], ['CLICK_BLOCKED'], 25000],
  ['navigate 到 javascript: 必须被拦', `<button>按钮</button>`, [{ action: 'navigate', value: 'javascript:alert(1)' }], ['UNSAFE_URL'], 25000],
  ['fill 超长文本', `<textarea id="t"></textarea>`, [{ action: 'fill', selector: '#t', value: '长'.repeat(50000) }], ['已填写'], 25000],
  ['type 超长自动降级', `<textarea id="t"></textarea>`, [{ action: 'type', selector: '#t', value: '长'.repeat(5000) }], ['整体填入'], 25000],
  ['对不存在的 selector 操作', `<button>按钮</button>`, [{ action: 'click', selector: '#never-exists' }], ['TARGET_NOT_FOUND'], 25000],
  ['selector 语法错误', `<button>按钮</button>`, [{ action: 'click', selector: '###' }], ['INVALID_SELECTOR'], 25000],
  ['图片作用域缺 ref', `<div>无图</div>`, [{ action: 'image' }], ['MISSING_TARGET'], 25000],
];

let browser;
const extract = (page) => page.evaluate(() => new Promise((resolve) => {
  globalThis.__viasContentListener({ type: 'EXTRACT', runId: 'stress', includeImages: true }, {}, resolve);
}));
const exec = (page, snapshotId, actions) => page.evaluate((message) => new Promise((resolve) => {
  globalThis.__viasContentListener(message, {}, resolve);
}), { type: 'EXECUTE', runId: 'stress', operationId: `op-${Math.random()}`, snapshotId, approved: true, actions });

(async () => {
  browser = await chromium.launch({ executablePath: edgePath, headless: true });
  let failures = 0;
  for (const [name, html, actions, expect, budget] of CASES) {
    const page = await browser.newPage();
    const started = Date.now();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => {
        const onMessage = { addListener(l) { globalThis.__viasContentListener = l; } };
        Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { onMessage } } });
      });
      await page.addScriptTag({ path: contentScript });
      await page.waitForFunction(() => !!window.__viasPageAgentLoaded);
      const snap = await extract(page);
      const out = await Promise.race([
        exec(page, snap.snapshotId, actions),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`EXECUTE 超时 ${budget}ms，疑似挂死`)), budget)),
      ]);
      const ms = Date.now() - started;
      const hit = expect.some((token) => JSON.stringify(out.results).includes(token));
      if (!hit) { failures++; console.log(`✗ ${name.padEnd(22)} ${String(ms).padStart(5)}ms  未命中预期 ${JSON.stringify(expect)}  实际 ${JSON.stringify(out.results).slice(0, 180)}`); }
      else console.log(`✓ ${name.padEnd(22)} ${String(ms).padStart(5)}ms  ${out.results.map((r) => r.code || 'ok').join(',')}`);
    } catch (error) {
      failures++;
      console.log(`✗ ${name.padEnd(22)} 抛异常：${error.message}`);
    } finally { await page.close(); }
  }
  console.log(failures ? `\n${failures} 个场景失败` : '\n全部场景通过');
  await browser.close();
  process.exit(failures ? 1 : 0);
})();