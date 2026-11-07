/* 协议层单元测试：node lvbu-ble/tests/protocol.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const util = require(path.join(__dirname, '../js/util.js'));
const protocol = require(path.join(__dirname, '../js/protocol.js'));
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
const hex = (b) => util.bytesToHex(b);
const fromHex = (s) => util.hexToBytes(s);

/* ---------------- util ---------------- */
test('hexToBytes 解析空格/逗号/0x 前缀', () => {
  assert.strictEqual(hex(util.hexToBytes('AA 55 04')), 'AA 55 04');
  assert.strictEqual(hex(util.hexToBytes('0xAA,0x55')), 'AA 55');
  assert.strictEqual(hex(util.hexToBytes('aa55')), 'AA 55');
  assert.strictEqual(util.hexToBytes('AA 5'), null);
});

test('uuid 展开与等价比较', () => {
  assert.strictEqual(util.expandUuid('ffe1'), '0000ffe1-0000-1000-8000-00805f9b34fb');
  assert.ok(util.uuidEq('0xFFE1', '0000FFE1-0000-1000-8000-00805F9B34FB'));
  assert.strictEqual(util.shortUuid(config.UUID.chMain), 'ffe1');
});

test('deepMerge 不污染默认对象', () => {
  const base = { a: 1, nested: { x: 1, y: 2 } };
  const out = util.deepMerge(base, { nested: { y: 9 } });
  assert.deepStrictEqual(out, { a: 1, nested: { x: 1, y: 9 } });
  assert.strictEqual(base.nested.y, 2);
});

/* ---------------- CRC ---------------- */
test('CRC16-Modbus 已知向量 "123456789" = 0x4B37', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.strictEqual(protocol.crc16Modbus(bytes), 0x4b37);
});

/* ---------------- 构建 / 解析 ---------------- */
const cfg = util.deepMerge(config.PROTOCOL_DEFAULTS, {});

test('buildFrame: 帧头/长度/命令/校验 结构正确（invsum）', () => {
  const f = protocol.buildFrame(cfg, { cmd: 0x10, payload: [] });
  // AA 55 | len=01 | cmd=10 | invsum(1B)
  assert.strictEqual(f[0], 0xaa);
  assert.strictEqual(f[1], 0x55);
  assert.strictEqual(f[2], 1, 'len = 1(cmd) + 0(payload) = 1');
  assert.strictEqual(f[3], 0x10);
  assert.strictEqual(f.length, 5);
  // invsum 覆盖整帧含帧头：0xFF - (AA+55+01+10) & 0xFF
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += f[i];
  const expected = (0xff - (sum & 0xff)) & 0xff;
  assert.strictEqual(f[4], expected);
});

test('parse 往返：单帧', () => {
  const f = protocol.buildFrame(cfg, { cmd: 0x40, payload: [1, 2, 3] });
  let got = null;
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => (got = fr));
  p.push(f);
  assert.ok(got, '应解析出一帧');
  assert.strictEqual(got.cmd, 0x40);
  assert.deepStrictEqual(Array.from(got.payload), [1, 2, 3]);
  assert.ok(got.validChecksum);
});

test('parse 粘包：两帧一次到达', () => {
  const a = protocol.buildFrame(cfg, { cmd: 0x40, payload: [9] });
  const b = protocol.buildFrame(cfg, { cmd: 0x01 });
  const joined = new Uint8Array([...a, ...b]);
  const got = [];
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => got.push(fr));
  p.push(joined);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].cmd, 0x40);
  assert.strictEqual(got[1].cmd, 0x01);
});

test('parse 分包：逐字节到达仍能拼回', () => {
  const f = protocol.buildFrame(cfg, { cmd: 0x40, payload: [4, 5, 6, 7, 8] });
  const got = [];
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => got.push(fr));
  for (const b of f) p.push([b]);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(Array.from(got[0].payload), [4, 5, 6, 7, 8]);
});

test('parse 前导噪声：能重新同步到帧头', () => {
  const f = protocol.buildFrame(cfg, { cmd: 0x01 });
  const noisy = new Uint8Array([0x00, 0xff, 0xaa, 0x00, ...f]);
  const got = [];
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => got.push(fr));
  p.push(noisy);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].cmd, 0x01);
});

test('parse 校验失败：重新同步后只解析出真正有效的那一帧', () => {
  const bad = new Uint8Array([0xaa, 0x55, 0x06, 0x10, 0x00, 0x00]);
  const good = protocol.buildFrame(cfg, { cmd: 0x11 }); // AA 55 05 11 <crc> <crc>
  const got = [];
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => got.push(fr));
  p.push(new Uint8Array([...bad, ...good]));
  // 坏帧被丢弃；紧随其后的好帧必须完整解析出来（不能因长度字段被噪声误导而吞掉）
  assert.ok(got.some((fr) => fr.cmd === 0x11), '好帧 0x11 必须被解析');
  assert.ok(got.every((fr) => fr.validChecksum), '回调的帧校验都必须有效');
  assert.ok(p.stats.badChecksum >= 1);
});

test('parse 纯坏帧不产生回调', () => {
  const bad = new Uint8Array([0xaa, 0x55, 0x03, 0x10, 0x00, 0x00]);
  const got = [];
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => got.push(fr));
  p.push(bad);
  assert.strictEqual(got.length, 0);
});

test('parse 载荷中含帧头字节 AA 55 时不误切', () => {
  const f = protocol.buildFrame(cfg, { cmd: 0x40, payload: [0xaa, 0x55, 0x01] });
  const got = [];
  const p = protocol.createParser(util.deepMerge(cfg, {}), (fr) => got.push(fr));
  p.push(f);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(Array.from(got[0].payload), [0xaa, 0x55, 0x01]);
});

/* ---------------- 其它协议参数 ---------------- */
test('lenMode=payload + 累加和 + 1 字节帧头', () => {
  const c = util.deepMerge(config.PROTOCOL_DEFAULTS, {
    header: [0xbf],
    lenMode: 'payload',
    checksum: 'sum',
    checksumIncludesHeader: false, // sum 不覆盖帧头
    cmdSize: 1,
    littleEndian: false,
  });
  const f = protocol.buildFrame(c, { cmd: 0x21, payload: [0x64] });
  // BF | 01(载荷长度) | 21(cmd) | 64(data) | sum
  assert.strictEqual(f.length, 5);
  assert.strictEqual(f[1], 1, '载荷长度');
  const sum = (f[1] + f[2] + f[3]) & 0xff;
  assert.strictEqual(f[4], sum);
  const got = [];
  const p = protocol.createParser(util.deepMerge(c, {}), (fr) => got.push(fr));
  p.push(f);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].cmd, 0x21);
  assert.strictEqual(got[0].payload[0], 0x64);
});

test('无校验 + 无长度字段（定长命令）', () => {
  const c = util.deepMerge(config.PROTOCOL_DEFAULTS, { lenMode: 'none', checksum: 'none' });
  const f = protocol.buildFrame(c, { cmd: 0x30 });
  assert.strictEqual(hex(f), 'AA 55 30');
  const got = [];
  const p = protocol.createParser(util.deepMerge(c, {}), (fr) => got.push(fr));
  p.push(f);
  assert.strictEqual(got.length, 1);
});

/* ---------------- adapter ---------------- */
function prefsWith(patch) {
  return util.deepMerge(JSON.parse(JSON.stringify(config.PREF_DEFAULTS)), patch || {});
}
const dbg = adapter.encode({ kind: 'gyro' }, prefsWith({}));

test('adapter: 轮径命令 载荷 = inch,dia_hi,dia_lo', () => {
  const { frames, meta } = adapter.encode({ kind: 'wheel', inch: 27, diameterMm: 2110 }, prefsWith({}));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(meta.cmd, adapter.CMDS.setWheel);
  // len=4 (inch + dia_hi + dia_lo)
  assert.strictEqual(frames[0][2], 4, '长度字段应为 4');
  const payload = frames[0].slice(4, frames[0].length - 1); // exclude checksum
  assert.deepStrictEqual(Array.from(payload), [27, (2110 >> 8) & 0xff, 2110 & 0xff]);
});

test('adapter: 模式/档位编码与命令字覆盖', () => {
  const p = prefsWith({ commands: { assistMode: 0x55 } });
  const { frames, meta } = adapter.encode({ kind: 'mode', mode: 'climbing' }, p);
  assert.strictEqual(meta.cmd, 0x55);
  assert.strictEqual(frames[0][3], 0x55);
  const { frames: lv } = adapter.encode({ kind: 'level', level: 130 }, prefsWith({}));
  assert.strictEqual(lv[0][4], 5, '档位应被钳制到 0~5');
});

test('adapter: 手动百分比命令', () => {
  const { frames } = adapter.encode({ kind: 'percent', percent: 35 }, prefsWith({}));
  assert.strictEqual(frames[0][3], adapter.CMDS.assistPercent);
  assert.strictEqual(frames[0][4], 35);
});

test('adapter: 每条命令都能被同一解析器解回', () => {
  for (const kind of ['gyro', 'calibrate', 'restart']) {
    const { frames } = adapter.encode({ kind }, prefsWith({}));
    const got = [];
    const p = protocol.createParser(util.deepMerge(config.PROTOCOL_DEFAULTS, {}), (fr) => got.push(fr));
    p.push(frames[0]);
    assert.strictEqual(got.length, 1, kind + ' 应可解析');
    assert.ok(got[0].validChecksum, kind + ' 校验应通过');
  }
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