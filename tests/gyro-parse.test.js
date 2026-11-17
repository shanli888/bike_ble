// 陀螺仪 BD 回包解析验证（对照文档 §3）

const IMEI = '123456789012345'; // 占位，非真实值
const CMDS = { gyro: 'BD' };

function parseGyro(hexReply) {
  const clean = hexReply.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const prefix = CMDS.gyro + 'F' + IMEI;
  if (!clean.startsWith(prefix) || clean.length < 26) return null;
  const state = clean.substr(18, 2);
  if (state !== '01') return null;
  const digits = clean.substr(20, 6);
  if (!/^\d{6}$/.test(digits)) return null;
  let n = parseInt(digits, 10);
  if (n >= 100000) n = 100000 - n;
  return n / 1000;
}

// 构造回包：BD F<15位IMEI> + 状态(2) + 数值(6) = 24 字符
function makeFrame(value6, state = '01') {
  return CMDS.gyro + 'F' + IMEI + state + value6;
}

let pass = 0;
let fail = 0;

function check(name, frame, expected) {
  const got = parseGyro(frame);
  const ok = got === expected ||
    (got !== null && expected !== null && Math.abs(got - expected) < 1e-9) ||
    (got === null && expected === null);
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  console.log(`   帧: ${frame}`);
  console.log(`   期望: ${expected}  实际: ${got}`);
  if (!ok) fail++;
  else pass++;
  console.log('');
}

console.log('=== 文档 §3 实测样例 ===');
// 文档：回包尾部 01 113844 → -13.844°
check('尾部 01 113844 → -13.844°', makeFrame('113844'), -13.844);

console.log('=== 正角度 ===');
check('000000 → 0°', makeFrame('000000'), 0);
check('003200 → 3.2°（演示值）', makeFrame('003200'), 3.2);
check('012345 → 12.345°', makeFrame('012345'), 12.345);
check('050000 → 50°', makeFrame('050000'), 50);
check('090000 → 90°', makeFrame('090000'), 90);

console.log('=== 负角度（偏移编码：n >= 100000 时 100000-n 自然为负）===');
// 100000 是零点偏移。n 越大于 100000，100000-n 越负。
check('100001 → -0.001°', makeFrame('100001'), -0.001);
check('102000 → -2°', makeFrame('102000'), -2);
check('112000 → -12°', makeFrame('112000'), -12);
check('113844 → -13.844°（文档样例）', makeFrame('113844'), -13.844);
check('140000 → -40°', makeFrame('140000'), -40);
check('199999 → -99.999°', makeFrame('199999'), -99.999);

console.log('=== 状态位非 01 → 作废 ===');
check('状态 00', makeFrame('003200', '00'), null);
check('状态 02', makeFrame('003200', '02'), null);
check('状态 FF', makeFrame('003200', 'FF'), null);

console.log('=== 非法数值 → 作废 ===');
check('含字母', makeFrame('00320A'), null);
check('帧太短（少于 26 字符）', 'BDF' + IMEI + '0100', null);
check('前缀不匹配', 'CDF' + IMEI + '01003200', null);

console.log('=== 帧长度校验 ===');
console.log(`标准帧长度: ${makeFrame('003200').length} 字符（文档要求 26 字符 = 13 字节 x2）`);
console.log(`当前实现采样位置: substr(18,2)=状态 "${makeFrame('003200').substr(18, 2)}", substr(20,6)=数值 "${makeFrame('003200').substr(20, 6)}"`);
console.log('');

console.log(`=== 结果：${pass} 通过，${fail} 失败 ===`);
if (fail > 0) process.exit(1);