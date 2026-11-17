// 陀螺仪 11 格双向条：渲染规则验证（对照《首页陀螺仪坡度显示逻辑》§4.1/4.2）

const SLOPE_CENTER = 5;
const SLOPE_MAX_LEVEL = 5;
const SLOPE_DEG_PER_CELL = 5;

function renderSlopeBar(slope) {
  const cells = [];
  const hasData = slope != null && isFinite(slope);
  const abs = hasData ? Math.abs(slope) : 0;
  const level = hasData
    ? Math.min(SLOPE_MAX_LEVEL, Math.max(0, Math.round(abs / SLOPE_DEG_PER_CELL)))
    : 0;
  const side = !hasData || slope === 0 ? 0 : slope < 0 ? -1 : 1;

  for (let i = 0; i < 11; i++) {
    const isCenter = i === SLOPE_CENTER;
    const filled =
      hasData &&
      (isCenter ||
        (side < 0 && i >= SLOPE_CENTER - level && i < SLOPE_CENTER) ||
        (side > 0 && i > SLOPE_CENTER && i <= SLOPE_CENTER + level));
    const tone = !filled ? 'off' : level === 0 ? 'flat' : side < 0 ? 'down' : 'up';
    cells.push({ i, filled, tone, isCenter });
  }
  return { cells, level, side, hasData };
}

// 把格子渲染成可视字符串：中心格用方括号标出
function visualize(slope) {
  const { cells, level, side } = renderSlopeBar(slope);
  const sym = { off: '·', flat: 'B', down: 'G', up: 'R' };
  const s = cells
    .map((c) => {
      const ch = sym[c.tone];
      return c.isCenter ? `[${ch}]` : ` ${ch} `;
    })
    .join('');
  return { s, level, side };
}

let pass = 0;
let fail = 0;

function check(name, slope, expectFilled, expectTone, expectLevel) {
  const { cells, level } = renderSlopeBar(slope);
  const filled = cells.filter((c) => c.filled).map((c) => c.i);
  const tones = [...new Set(cells.filter((c) => c.filled).map((c) => c.tone))];

  const okFilled = JSON.stringify(filled) === JSON.stringify(expectFilled);
  const okTone = JSON.stringify(tones) === JSON.stringify(expectTone);
  const okLevel = level === expectLevel;
  const pass_ = okFilled && okTone && okLevel;

  const { s } = visualize(slope);
  console.log(`${pass_ ? '✅' : '❌'} ${name}`);
  console.log(`   角度 ${slope === null ? 'null' : slope + '°'}  level=${level}`);
  console.log(`   ${s}`);
  if (!pass_) {
    if (!okFilled) console.log(`   期望点亮 [${expectFilled}] 实际 [${filled}]`);
    if (!okTone) console.log(`   期望颜色 [${expectTone}] 实际 [${tones}]`);
    if (!okLevel) console.log(`   期望 level=${expectLevel} 实际 ${level}`);
  }
  console.log('');
  if (pass_) pass++;
  else fail++;
}

console.log('图例：· 熄灭  B 蓝(平)  G 绿(下坡)  R 红(上坡)   [ ] 中心格\n');

// 文档 §4.2 四种状态
check('无数据 → 11 格全灭', null, [], [], 0);
check('0 附近 0.4° → 仅中心蓝格', 0.4, [5], ['flat'], 0);
check('精确 0 → 仅中心蓝格', 0, [5], ['flat'], 0);
check('下坡 -12° → 中心+左侧2格，绿', -12, [3, 4, 5], ['down'], 2);
check('上坡 +12° → 中心+右侧2格，红', 12, [5, 6, 7], ['up'], 2);

console.log('--- 演示值 ---');
check('演示 3.2° → level=1，中心+右1格红', 3.2, [5, 6], ['up'], 1);

console.log('--- 边界 ---');
check('2.4° → round(0.48)=0 平路蓝', 2.4, [5], ['flat'], 0);
check('2.6° → round(0.52)=1 上坡红', 2.6, [5, 6], ['up'], 1);
check('-2.4° → 平路蓝（负值也按 level 判定）', -2.4, [5], ['flat'], 0);
check('27.5° → level 饱和到 5，右5格', 27.5, [5, 6, 7, 8, 9, 10], ['up'], 5);
check('-45° → level 饱和到 5，左5格', -45, [0, 1, 2, 3, 4, 5], ['down'], 5);
check('99° 极端值 → 仍饱和 5', 99, [5, 6, 7, 8, 9, 10], ['up'], 5);

console.log('--- 易错点复核（文档 §4.2 强调） ---');
const r = renderSlopeBar(0.4);
const centerTone = r.cells[5].tone;
console.log(
  `0.4°: side=${r.side} level=${r.level} 中心格颜色=${centerTone}  ${
    centerTone === 'flat' ? '✅ 用 level 判定，正确显示蓝色' : '❌ 误用 side 判定'
  }\n`
);
if (centerTone === 'flat') pass++;
else fail++;

console.log(`=== 结果：${pass} 通过，${fail} 失败 ===`);
if (fail > 0) process.exit(1);