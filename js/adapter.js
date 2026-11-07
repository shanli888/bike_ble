/* =========================================================================
 * adapter.js — LVBU / WePower 协议适配层
 *
 * ⚠️ 这是唯一需要按真实协议修改的文件。
 * 拿到协议文档后：
 *   1. 修正 CMDS 命令字
 *   2. 修正 REPORT_FIELDS 字段偏移（或在「设置」里用实验字段表覆盖）
 *   3. 若帧格式特殊，覆盖 encode()/decode()
 * 设置页里的「协议参数」会实时覆盖 header/len/checksum/字节序，无需改代码。
 *
 * 纯函数 + 无 DOM 依赖，可在 Node 中做契约测试。
 * ========================================================================= */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const base = isNode ? root : root.LVBU;
  const util = isNode ? null : base.util;
  const protocol = isNode ? null : base.protocol;
  const api = factory({
    util: isNode ? null : util,
    protocol: isNode ? null : protocol,
    requireLocal: isNode
      ? (name) => require('./' + name + '.js')
      : null,
  });
  if (isNode) module.exports = api;
  else base.adapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  // 兜底：Node 下延迟 require，浏览器下用全局
  const U = deps.util || deps.requireLocal('util');
  const P = deps.protocol || deps.requireLocal('protocol');

  /* ======================= 1. 命令字 ======================= */
  // 逆向文档中的“推测帧”已解出命令字；载荷待实测确认。
  const CMDS = {
    restart: 0x01, // AA 55 01 01 FE
    setWheel: 0x02, // AA 55 04 02 <inch> <dia_hi> <dia_lo> <cs>
    queryGyro: 0x10, // AA 55 01 10 EF
    calibrateGyro: 0x11, // AA 55 01 11 EE
    // 助力相关（依据真实协议 README）
    assistLevel: 0x20, // 助力等级 0~5（0=关闭助力）
    assistMode: 0x21, // 骑行模式：通勤/运动/爬坡/休闲/手动
    assistStop: 0x22, // 停止助力
    assistPercent: 0x23, // 手动模式下的助力百分比 0~100
    speedLimit: 0x30, // 限速
    headLamp: 0x31, // 头灯
  };

  /** 命令字中文名（日志与调试页显示用） */
  const CMD_NAMES = {
    [CMDS.restart]: '重启设备',
    [CMDS.setWheel]: '设置轮径',
    [CMDS.queryGyro]: '查询陀螺仪',
    [CMDS.calibrateGyro]: '校准陀螺仪',
    [CMDS.assistLevel]: '助力档位',
    [CMDS.assistMode]: '助力模式',
    [CMDS.assistStop]: '停止助力',
    [CMDS.assistPercent]: '手动助力%',
    [CMDS.speedLimit]: '限速',
    [CMDS.headLamp]: '头灯',
  };

  /* ======================= 2. 上报字段表 ======================= */
  // 字段来源：逆向文档 4.x 的功能项。偏移为占位，需实测校正。
  // 在设置页可粘贴实验字段表 JSON 覆盖，无需改代码。
  const REPORT_FIELDS = [
    { key: 'speed', type: 'u16', offset: 0, scale: 0.1 }, // km/h ×10
    { key: 'avgSpeed', type: 'u16', offset: 2, scale: 0.1 },
    { key: 'maxSpeed', type: 'u16', offset: 4, scale: 0.1 },
    { key: 'cadence', type: 'u8', offset: 6 },
    { key: 'trip', type: 'u16', offset: 7, scale: 0.1 }, // km ×10
    { key: 'odo', type: 'u32', offset: 9, scale: 0.001 }, // km，单位 m
    { key: 'battery', type: 'u8', offset: 13, clamp: [0, 100] },
    { key: 'voltage', type: 'u16', offset: 14, scale: 0.1 }, // V ×10
    { key: 'assistLevel', type: 'u8', offset: 16 },
    { key: 'assistPower', type: 'u16', offset: 17 }, // W
    { key: 'motorPower', type: 'u16', offset: 19 }, // W
    { key: 'gyro', type: 'i16', offset: 21, scale: 0.1 }, // °
    { key: 'controllerTemp', type: 'i8', offset: 23 }, // °C
    { key: 'motorTemp', type: 'i8', offset: 24 },
  ];

  /* ======================= 3. 编码 ======================= */

  /**
   * @param command { kind:'wheel'|'mode'|'level'|'stop'|'gyro'|'calibrate'|'restart'|'status'|'raw', ... }
   * @param prefs  LvBu prefs（含 protocol / commands 覆盖）
   * @returns { frames: Uint8Array[], meta: object }
   */
  function encode(command, prefs) {
    // 允许调用方直接传 prefs.protocol / prefs 缺失
    const prefsSafe = prefs || {};
    const proto = Object.assign({}, prefsSafe.protocol);
    // 兼容裸调用：把 prefs 的其它键传进来时避免 undefined
    if (!Array.isArray(proto.header)) proto.header = [0xaa, 0x55];
    if (!proto.lenMode) proto.lenMode = 'frame';
    if (!proto.checksum) proto.checksum = 'crc16modbus';
    if (!proto.cmdSize) proto.cmdSize = 1;
    if (proto.lenFieldAdjust == null) proto.lenFieldAdjust = 0;
    const cmdTable = Object.assign({}, CMDS, prefsSafe.commands || {});
    const meta = { command: command.kind, cmd: null, name: '' };

    const frameOf = (cmd, payload) => {
      meta.cmd = cmd;
      meta.name = CMD_NAMES[cmd] || '';
      return { frames: [P.buildFrame(proto, { cmd, payload })], meta };
    };

    switch (command.kind) {
      case 'wheel': {
        const inch = Number(command.inch || 0);
        const dia = Number(command.diameterMm || Math.round(inch * 25.4));
        return frameOf(cmdTable.setWheel, [inch & 0xff, (dia >> 8) & 0xff, dia & 0xff]);
      }
      case 'gyro':
        return frameOf(cmdTable.queryGyro, []);
      case 'calibrate':
        return frameOf(cmdTable.calibrateGyro, []);
      case 'restart':
        return frameOf(cmdTable.restart, []);
      case 'mode': {
        const index = MODE_CODES[command.mode];
        if (index == null) throw new Error('未知骑行模式: ' + command.mode);
        return frameOf(cmdTable.assistMode, [index]);
      }
      case 'level': {
        // 助力等级 0~5（0=关闭助力）
        const level = U.clamp(Math.round(Number(command.level || 0)), 0, 5);
        return frameOf(cmdTable.assistLevel, [level]);
      }
      case 'percent': {
        // 手动模式下的助力百分比 0~100
        const percent = U.clamp(Math.round(Number(command.percent || 0)), 0, 100);
        return frameOf(cmdTable.assistPercent, [percent]);
      }
      case 'stop':
        return frameOf(cmdTable.assistStop, [0x00]);
      case 'raw': {
        // 调试页直接发送；noChecksum 支持贴原始完整帧
        return { frames: [U.toBytes(command.bytes)], meta: { command: 'raw', cmd: null, name: '原始帧' } };
      }
      default:
        throw new Error('未知命令类型: ' + command.kind);
    }
  }

  const MODE_CODES = { commute: 1, exercise: 2, climbing: 3, leisure: 4, manual: 5 };
  const MODE_BY_CODE = Object.fromEntries(Object.entries(MODE_CODES).map(([k, v]) => [v, k]));

  /* ======================= 4. 解码 ======================= */

  /**
   * 解析一帧，返回归一化的数据补丁 { speed, battery, ... }
   * @param frame { cmd, payload, raw }
   * @param prefs
   * @returns { update:object, kind:string }
   */
  function decode(frame, prefs) {
    const cmdTable = Object.assign({}, CMDS, (prefs && prefs.commands) || {});
    const littleEndian = !!(prefs && prefs.protocol && prefs.protocol.littleEndian);
    const fields = (prefs && prefs.reportFields) || REPORT_FIELDS;

    // 上报帧：按字段表解析（私有帧）
    if (frame.cmd === cmdTable.report) {
      const { values } = P.parseFields(frame.payload, fields, littleEndian);
      return { update: sanitize(values), kind: 'report' };
    }

    // 助力应答：回显档位/模式/百分比
    if (frame.cmd === cmdTable.assistLevel && frame.payload.length >= 1) {
      return { update: { assistLevel: frame.payload[0] }, kind: 'ack' };
    }
    if (frame.cmd === cmdTable.assistMode && frame.payload.length >= 1) {
      const mode = MODE_BY_CODE[frame.payload[0]];
      return { update: mode ? { mode } : {}, kind: 'ack' };
    }
    if (frame.cmd === cmdTable.assistPercent && frame.payload.length >= 1) {
      return { update: { assistPercent: frame.payload[0] }, kind: 'ack' };
    }

    // 其它帧：交给 UI 提示为“收到应答”
    return { update: {}, kind: 'other' };
  }

  /** 过滤明显不合理的值，避免占位字段表把界面刷成乱码 */
  const SANITY = {
    speed: [0, 120],
    avgSpeed: [0, 120],
    maxSpeed: [0, 120],
    cadence: [0, 250],
    trip: [0, 1000],
    odo: [0, 500000],
    battery: [0, 100],
    voltage: [0, 100],
    assistLevel: [0, 100],
    assistPower: [0, 2000],
    motorPower: [0, 5000],
    gyro: [-180, 180],
    controllerTemp: [-40, 150],
    motorTemp: [-40, 150],
  };

  function sanitize(values) {
    const out = {};
    for (const k of Object.keys(values)) {
      const r = SANITY[k];
      if (r && (values[k] < r[0] || values[k] > r[1])) continue;
      out[k] = Math.round(values[k] * 100) / 100;
    }
    return out;
  }

  /* ======================= 5. 连接后初始化序列 ======================= */
  // 每次连接成功后按顺序下发；失败不阻塞其它项。
  function initSequence(prefs) {
    return [
      { delay: 300, command: { kind: 'gyro' } },
    ];
  }

  return {
    CMDS,
    CMD_NAMES,
    REPORT_FIELDS,
    MODE_CODES,
    MODE_BY_CODE,
    SANITY,
    encode,
    decode,
    initSequence,
  };
});