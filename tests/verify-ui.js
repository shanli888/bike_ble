// verify-ui.js
// 用 jsdom 跑真实 UI 脚本，验证渲染/交互逻辑（无法跑真机 BLE，但能抓出 JS 运行时错误）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// 让 window 同时具备 document 等全局，方便脚本用 globalThis
window.eval(`
  window.LVBU = {};
  window.performance = window.performance || { now: () => Date.now() };
`);

const order = ['util', 'protocol', 'config', 'adapter', 'ble', 'app', 'icons', 'ui'];
const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));

for (const name of order) {
  const code = fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8');
  try {
    window.eval(code);
  } catch (e) {
    errors.push(`${name}.js: ${e.message}`);
  }
}

// 触发 DOMContentLoaded（ui.js 若 readyState=loading 会挂起等待）
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

let fails = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) fails++;
};

const $ = (s) => window.document.querySelector(s);
const state = window.LVBU.app.state;

console.log('\n[1] 初始化');
check(errors.length === 0, '脚本无运行时错误 ' + JSON.stringify(errors));
check($('#connText').textContent === '未连接', '状态=未连接，实际：' + $('#connText').textContent);
check($('#speedValue').textContent === '0.0', '速度 0.0');
check($('#confirmChip').textContent.includes('手动'), '确认胶囊：' + $('#confirmChip').textContent);
const empty = [...window.document.querySelectorAll('.card.is-empty')].map((c) => c.id);
check(empty.length === 3, '3 张空卡片：' + empty.join(','));
check($('#assistSlider').disabled === true, '未连接滑杆禁用');
check($('#btnStop').disabled === true, '未连接停止禁用');
check(window.document.querySelectorAll('.mode').length === 5, '5 个模式按钮');

console.log('\n[2] 助力草稿（未连接，仅改草稿）');
$('.mode[data-mode=climbing]').click();
check(state.draft.mode === 'climbing' && state.draft.level === 85, '点爬坡 → 草稿 85%');
check(state.draft.dirty === true, '草稿为脏');

console.log('\n[3] 停车确认硬门槛（伪造已连接）');
state.conn.status = 'ready';
state.bike.speed = 12.0;
window.LVBU.app._internal.changed();
let notified = [];
window.LVBU.app.on('toast', (t) => notified.push(t));
$('#confirmChip').click();
check(state.confirmed.mode !== 'climbing', '高速时确认被拒绝，confirmed 未变');
check(notified.some((t) => /停车/.test(t.text) && t.level === 'error'), '弹出停车提示：' + JSON.stringify(notified.map((n) => n.text)));

state.bike.speed = 0;
window.LVBU.app._internal.changed();
check($('#confirmChip').textContent === '确认下发', '停车后按钮=确认下发，实际：' + $('#confirmChip').textContent);

console.log('\n[4] 单位切换');
state.prefs.unit = 'mph';
state.bike.speed = 16;
window.LVBU.app._internal.changed();
check($('#speedUnit').textContent === 'mph', '单位标签=mph');
check($('#speedValue').textContent === '9.9', '16km/h → 9.9mph，实际：' + $('#speedValue').textContent);

console.log('\n[5] 卡片显示');
state.prefs.unit = 'kmh';
Object.assign(state.bike, { battery: 65, voltage: 37.6, controllerTemp: 21.7, gyro: 0.9, odo: 1284.8 });
window.LVBU.app._internal.changed();
check($('[data-field=battery]').textContent === '65%', '电量 65%');
check($('[data-field=batteryBar]').style.width === '65%', '电量条 65%');
check(/37\.6 V/.test($('[data-field=batterySub]').textContent), '电压文案：' + $('[data-field=batterySub]').textContent);
check($('[data-field=gyro]').textContent === '0.9°', '陀螺仪 0.9°');
check($('#cardOdo').classList.contains('is-empty') === false, '总里程不再是占位');

console.log('\n[6] 页面切换');
window.document.querySelector('[data-tab=device]').click();
check($('#page-device').hidden === false && $('#page-dash').hidden === true, '切到设备页');
window.document.querySelector('#rawInput').value = '10';
window.document.querySelector('#rawInput').dispatchEvent(new window.Event('input'));
check(/AA 55/.test($('#rawPreview').textContent), '原始帧预览：' + $('#rawPreview').textContent);

console.log('\n[7] 帧编解码（页面内同一份代码）');
const { adapter, protocol, config, util } = window.LVBU;
const prefs = state.prefs;
const enc = adapter.encode({ kind: 'wheel', inch: 27, diameterMm: 2110 }, prefs);
const got = [];
const parser = protocol.createParser(util.deepMerge(prefs.protocol, {}), (f) => got.push(f));
parser.push(enc.frames[0]);
check(got.length === 1 && got[0].cmd === adapter.CMDS.setWheel, '轮径帧可往返：' + util.bytesToHex(enc.frames[0]));

console.log('\n' + (fails ? `失败 ${fails} 项` : '全部通过 ✓'));
process.exit(fails ? 1 : 0);