// 演示坡度循环 + 11 格条端到端验证
const SLOPE_CENTER = 5;
const SLOPE_MAX = 5;
const DEG_PER_CELL = 5;

function slopeBar(slope) {
  const hasData = slope != null && isFinite(slope);
  const abs = hasData ? Math.abs(slope) : 0;
  const level = hasData ? Math.min(SLOPE_MAX, Math.max(0, Math.round(abs / DEG_PER_CELL))) : 0;
  const side = !hasData || slope === 0 ? 0 : slope < 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < 11; i++) {
    const isCenter = i === SLOPE_CENTER;
    const filled =
      hasData &&
      (isCenter ||
        (side < 0 && i >= SLOPE_CENTER - level && i < SLOPE_CENTER) ||
        (side > 0 && i > SLOPE_CENTER && i <= SLOPE_CENTER + level));
    const tone = !filled ? 'off' : level === 0 ? 'flat' : side < 0 ? 'down' : 'up';
    out.push({ tone });
  }
  return { out, level, side };
}

function draw(slope) {
  const { out, level } = slopeBar(slope);
  const sym = { off: '·', flat: 'B', down: 'G', up: 'R' };
  return out.map((c, i) => (i === 5 ? `[${sym[c.tone]}]` : ` ${sym[c.tone]} `)).join('');
}

// 模拟 sim.js 的循环（24 秒一圈，-28 ~ +28）
function demoGyro(t) {
  const phase = (t % 24) / 24;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return Math.round((tri * 56 - 28) * 10) / 10;
}

console.log('=== 演示循环（24 秒一圈）抽样 ===\n');
const seen = new Set();
for (let t = 0; t <= 24; t += 1.5) {
  const v = demoGyro(t);
  const { out } = slopeBar(v);
  const state = out[5].tone === 'off' ? 'none' : out[5].tone;
  seen.add(state);
  console.log(`t=${String(t).padStart(4)}s  ${String(v).padStart(6)}°  ${draw(v)}  (${state})`);
}

console.log('\n=== 覆盖状态统计 ===');
const names = { flat: '平路蓝', up: '上坡红', down: '下坡绿', none: '无数据' };
for (const s of ['flat', 'up', 'down']) {
  console.log(`${names[s]}: ${seen.has(s) ? '✅ 已覆盖' : '❌ 未覆盖'}`);
}

console.log('\n=== 关键值验证 ===');
[
  [0, 'flat'],
  [2.4, 'flat'],
  [2.6, 'up'],
  [-2.4, 'flat'],
  [-2.6, 'down'],
  [27.5, 'up'],
  [-27.5, 'down'],
  [28, 'up'],
  [-28, 'down'],
].forEach(([v, expect]) => {
  const { out } = slopeBar(v);
  const got = out[5].tone;
  console.log(`${got === expect ? '✅' : '❌'} ${String(v).padStart(6)}° → ${got.padEnd(5)} (期望 ${expect})  ${draw(v)}`);
});