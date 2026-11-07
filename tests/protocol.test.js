/* 协议层单元测试：node lvbu-ble/tests/protocol.test.js
 * 覆盖 LVBU 3.4.0 文本协议（命令帧 / 回复解析） */
'use strict';
const assert = require('assert');
const path = require('path');
const util = require(path.join(__dirname, '../js/util.js'));
const config = require(path.join(__dirname, '../js/config.js'));
const adapter = require(path.join(__dirname, '../js/adapter.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, error: e });
  }
}

/* ---------------- util 基础 ---------------- */
test('hexToBytes / bytesToHex', () => {
  assert.strictEqual(util.bytesToHex(new Uint8Array([0xaa, 0x55])), 'AA 55');
  assert.deepStrictEqual(Array.from(util.hexToBytes('AA 55')), [0xaa, 0x55]);
});

/* ---------------- adapter 编码 ---------------- */
function prefs(over = {}) {
  return Object.assign({}, config.PREF_DEFAULTS, over);
}

test('命令帧：命令码 + F + IMEI（hex 字符串转字节）', () => {
  const { frames, meta } = adapter.encode({ kind: 'voltage' }, prefs());
  assert.strictEqual(meta.cmd, 'C0');
  // C0F866855030090179 → 字节 C0 F8 66 85 50 30 09 01 79
  assert.deepStrictEqual(Array.from(frames[0]), [0xC0, 0xF8, 0x66, 0x85, 0x50, 0x30, 0x09, 0x01, 0x79]);
});

test('命令帧：速度 BF / 温度 C1 / 陀螺仪 BD', () => {
  const cases = {
    speed: [0xBF, 0xF8, 0x66, 0x85, 0x50, 0x30, 0x09, 0x01, 0x79],
    temperature: [0xC1, 0xF8, 0x66, 0x85, 0x50, 0x30, 0x09, 0x01, 0x79],
    gyro: [0xBD, 0xF8, 0x66, 0x85, 0x50, 0x30, 0x09, 0x01, 0x79],
  };
  for (const [kind, expected] of Object.entries(cases)) {
    const { frames } = adapter.encode({ kind }, prefs());
    assert.deepStrictEqual(Array.from(frames[0]), expected, kind);
  }
});

test('设置模式：C4 + 模式码（手动=01 休闲=02 运动=03 通勤=04 爬坡=05）', () => {
  const mapping = { manual: 0x01, leisure: 0x02, exercise: 0x03, commute: 0x04, climbing: 0x05 };
  for (const [mode, code] of Object.entries(mapping)) {
    const { frames } = adapter.encode({ kind: 'mode', mode }, prefs());
    // C4F866855030090179<mode> → 最后字节是 mode 码
    const arr = Array.from(frames[0]);
    assert.strictEqual(arr[arr.length - 1], code, mode);
    assert.strictEqual(arr[0], 0xC4, mode + ' 命令码');
  }
});

test('设置轮胎：AB + 周长', () => {
  const { frames } = adapter.encode({ kind: 'wheel', inch: 27.5, diameterMm: 2165 }, prefs());
  const arr = Array.from(frames[0]);
  assert.strictEqual(arr[0], 0xAB);
});

test('重启：单字节 0x33 走控制通道', () => {
  const { frames, meta } = adapter.encode({ kind: 'restart' }, prefs());
  assert.strictEqual(frames[0][0], 0x33);
  assert.strictEqual(meta.ctrl, true);
});

test('自定义 IMEI 覆盖', () => {
  const { frames } = adapter.encode({ kind: 'voltage' }, prefs({ imei: '123456789012345' }));
  // C0F123456789012345 → C0 F1 23 45 67 89 01 23 45
  assert.deepStrictEqual(Array.from(frames[0]), [0xC0, 0xF1, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23, 0x45]);
});

/* ---------------- adapter 回复解析（十进制数值） ---------------- */
test('C0 电压回复：状态 01，末四位十进制 /10', () => {
  // 字节 C0 F8 ... 01 03 85 → hex 字符串 ...010385，0385 十进制=385 → 38.5V
  const hex = 'C0F866855030090179010385';
  const { update } = adapter.parseReply(hex, prefs());
  assert.strictEqual(update.voltage, 38.5);
});

test('C0 电压回复：分隔符空格也能解析', () => {
  const hex = 'C0 F8 66 85 50 30 09 01 79 01 03 85';
  const { update } = adapter.parseReply(hex, prefs());
  assert.strictEqual(update.voltage, 38.5);
});

test('BF 速度回复：状态 01 末四位十进制', () => {
  const hex = 'BFF866855030090179010000';
  const { update } = adapter.parseReply(hex, prefs());
  assert.strictEqual(update.speed, 0); // 静止样本
});

test('C4 模式回复：状态 01 + 模式码（十六进制）', () => {
  const hex = 'C4F8668550300901790103';
  const { update, kind } = adapter.parseReply(hex, prefs());
  assert.strictEqual(kind, 'ack');
  assert.strictEqual(update.mode, 'exercise'); // 03 = 运动
});

test('状态非 01 不解析数值', () => {
  const hex = 'C0F866855030090179000385';
  const { update } = adapter.parseReply(hex, prefs());
  assert.strictEqual(update.voltage, undefined);
});

test('不匹配的回复被忽略', () => {
  const hex = 'C0F000000000000000010385';
  const { update } = adapter.parseReply(hex, prefs());
  assert.deepStrictEqual(update, {});
});

/* ---------------- 结果 ---------------- */
console.log(`\n通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}\n  ${f.error.message}`);
  }
  process.exit(1);
}
console.log('全部通过 ✓');