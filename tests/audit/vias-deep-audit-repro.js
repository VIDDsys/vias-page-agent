'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const project = 'C:/Users/VIDDsys/.zcode/projects/vias-page-agent';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const contentScript = fs.readFileSync(path.join(project, 'content.js'), 'utf8');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function inject(page) {
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { onMessage: { addListener(listener) { globalThis.__vias = listener; } } } } });
  });
  await page.evaluate(contentScript);
}

function dispatch(page, payload, wait = true) {
  return page.evaluate(({ payload, wait }) => new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { if (!finished) reject(new Error(`timeout:${payload.type}`)); }, 15000);
    const done = (value) => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    const result = globalThis.__vias(payload, {}, done);
    if (!wait || result !== true) queueMicrotask(() => done(undefined));
  }), { payload, wait });
}

(async () => {
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const server = http.createServer((request, response) => {
    if (request.url === '/slow.png') {
      setTimeout(() => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(imageBytes); }, 2500);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><style>button,img{display:block;width:160px;height:60px}</style><button id="action">Continue</button><img src="/slow.png"><script>window.clicks=0;action.onclick=()=>clicks++</script>');
  });
  const port = await listen(server);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vias-audit-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath: edge, headless: true });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await inject(page);

    const extracting = dispatch(page, { type: 'EXTRACT', runId: 'vision-race', includeImages: true, maxLen: 20000 });
    await page.waitForTimeout(1800);
    await page.evaluate(() => { document.querySelector('#action').textContent = 'Delete account'; });
    const raced = await extracting;
    const ref = Number(raced.text.match(/^\[(\d+)\] 按钮「Continue」/m)?.[1]);
    const raceExec = await dispatch(page, { type: 'EXECUTE', runId: 'vision-race', operationId: 'race-op', snapshotId: raced.snapshotId, actions: [{ action: 'click', ref }] });
    const snapshotRaceConfirmed = raceExec.results[0].ok === true && await page.evaluate(() => window.clicks) === 1;

    await page.setContent('<form id="f"><input id="note"><button>Submit</button></form><script>window.submits=0;f.addEventListener("submit",e=>{e.preventDefault();submits++})</script>');
    await inject(page);
    const fresh = await dispatch(page, { type: 'EXTRACT', runId: 'enter-submit', includeImages: false });
    const inputRef = Number(fresh.text.match(/^\[(\d+)\] 输入框/m)?.[1]);
    const enterExec = await dispatch(page, { type: 'EXECUTE', runId: 'enter-submit', operationId: 'enter-op', snapshotId: fresh.snapshotId, approved: false, actions: [{ action: 'press', ref: inputRef, value: 'Enter' }] });
    const enterBypassConfirmed = enterExec.results[0].ok === true && await page.evaluate(() => window.submits) === 1;

    const result = { snapshotRaceConfirmed, enterBypassConfirmed, racedText: raced.text.slice(0, 200), raceExec: raceExec.results[0] };
    console.log(JSON.stringify(result));
    assert.equal(enterBypassConfirmed, true);
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
