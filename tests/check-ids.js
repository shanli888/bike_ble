const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const ui = fs.readFileSync('js/ui.js', 'utf8');

// 提取 $('#id') 引用
const ids = [...ui.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
const uniq = [...new Set(ids)];

const missing = [];
for (const id of uniq) {
  const needle = 'id="' + id + '"';
  if (!html.includes(needle)) missing.push(id);
}

console.log('ui.js 引用的 ID 总数:', uniq.length);
console.log('HTML 中缺失的 ID:', missing.length ? missing.join(', ') : '无');