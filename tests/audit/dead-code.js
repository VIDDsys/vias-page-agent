'use strict';
// 死代码扫描：找出「定义后从未被任何地方引用」的顶层函数与常量。
// 跨文件契约一致性（动作集合、错误码、STRUCTURAL_FAILURES、meta 字段、预算链）
// 由 contract-audit.cjs 负责，两者结论不重叠。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');

const files = ['core.js', 'background.js', 'content.js', 'sidepanel.js', 'options.js', 'main-world.js'];
const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
const testDir = path.join(root, 'tests');
const testSources = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))
  .map((f) => fs.readFileSync(path.join(testDir, f), 'utf8'))
  .join('\n');
const everything = Object.values(sources).join('\n') + '\n' + testSources;

// `$` 不是正则的 word 字符，必须单独处理，否则每个 UI 文件都会误报
const references = (name) => {
  if (name === '$') {
    const hits = everything.match(/\$\s*\(/g) || [];
    return hits.length;
  }
  return (everything.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
};

const dead = [];
for (const [file, src] of Object.entries(sources)) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|new |\[|`|\d|'|")/g)) names.add(m[1]);

  for (const name of names) {
    // 出现一次 = 只有定义那一处；出现两次 = 定义 + 一次调用，才算活着
    if (references(name) <= 1) dead.push(`${file} -> ${name}`);
  }
}

if (dead.length) {
  console.log('死代码：');
  for (const item of dead) console.log(`  ✗ ${item}`);
  process.exit(1);
}
console.log('✓ 未发现死代码');