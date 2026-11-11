/* =========================================================================
 * adapter.js — LVBU 3.4.0 文本协议适配层
 *
 * 协议格式（已实机验证）：
 *   命令帧：`<CMD>F<IMEI>[<DATA>]` 以 ASCII/UTF-8 字节写入 FFE1
 *   回复帧：十六进制字符串，同样格式
 *
 * 说明：\ *   - IMEI 是电机 IMEI，不是手机 IMEI；文档中已确认固定为 866855030090179
 *   - 写入/通知均为 FFE1 同一特征
 *   - 回复匹配：前 `len` 字符包含命令码 + F + IMEI
 *   - 电压 C0 回复：总长 24 个十六进制字符，状态在 19-20 位，末 4 位 /10
 *
 * 纯函数 + 无 DOM 依赖，可在 Node 中做契约测试。
 * ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.LVBU = root.LVBU || {}).adapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 固定的电机 IMEI（可在设置中覆盖） */
  const DEFAULT_IMEI = '866855030090179';

  /* ======================= 命令表 ======================= */
  const CMDS = {
    voltage: 'C0', // 电压查询
    speed: 'BF', // 速度查询
    temperature: 'C1', // 控制器温度查询
    trip: 'B1', // 本次骑行记录
    gyro: 'BD', // 陀螺仪角度
    climb: 'C6', // 爬坡参数
    setMode: 'C4', // 设置助力模式
    setPower: 'A5', // 设置手动功率百分比（边界有疑，当前禁用）
    setTire: 'AB', // 设置轮胎周长
    calibrateGyro: 'BE', // 陀螺仪校准
    restart: '33', // 通过 FFE2 写单字节 33
  };

  const CMD_NAMES = {
    [CMDS.voltage]: '查询电压',
    [CMDS.speed]: '查询速度',
    [CMDS.temperature]: '查询温度',
    [CMDS.trip]: '查询里程',
    [CMDS.gyro]: '查询陀螺仪',
    [CMDS.climb]: '查询爬坡',
    [CMDS.setMode]: '设置模式',
    [CMDS.setPower]: '设置功率',
    [CMDS.setTire]: '设置轮胎',
    [CMDS.calibrateGyro]: '校准陀螺仪',
    [CMDS.restart]: '重启设备',
  };

  /** 助力模式码（原厂 3.4.0 已确认） */
  const MODE_CODES = { commute: 4, exercise: 3, climbing: 5, leisure: 2, manual: 1 };
  const MODE_BY_CODE = Object.fromEntries(Object.entries(MODE_CODES).map(([k, v]) => [v, k]));

  /* ======================= 工具函数 ======================= */
  function padHex(n, width) {
    return n.toString(16).toUpperCase().padStart(width, '0');
  }

  function hexStrToBytes(hexStr) {
    const clean = hexStr.replace(/[^0-9A-Fa-f]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    return bytes;
  }

  function bytesToHexStr(bytes) {
    return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }

  function textToHex(text) {
    return Array.from(new TextEncoder().encode(text), (b) => padHex(b, 2)).join(' ');
  }

  function hexToText(hexStr) {
    // 去除空格，转 Uint8Array
    const clean = hexStr.replace(/[^0-9A-Fa-f]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }

  function getImei(prefs) {
    return (prefs && prefs.imei) || DEFAULT_IMEI;
  }

  /* ======================= 编码 ======================= */
  function buildCommand(cmd, imei, data) {
    let frame = cmd + 'F' + imei;
    if (data != null) frame += String(data);
    return frame;
  }

  function encode(command, prefs) {
    const imei = getImei(prefs);
    const meta = { command: command.kind, cmd: null, name: '' };

    let cmd;
    let data = null;

    switch (command.kind) {
      case 'voltage':
        cmd = CMDS.voltage;
        break;
      case 'speed':
        cmd = CMDS.speed;
        break;
      case 'temperature':
        cmd = CMDS.temperature;
        break;
      case 'trip':
        cmd = CMDS.trip;
        break;
      case 'gyro':
        cmd = CMDS.gyro;
        break;
      case 'climb':
        cmd = CMDS.climb;
        break;
      case 'mode':
        cmd = CMDS.setMode;
        data = padHex(MODE_CODES[command.mode] || command.mode, 2);
        break;
      case 'percent':
        // A5 手动助力百分比，范围 0~99（100% 边界原厂有疑，不主动下发）
        cmd = CMDS.setPower;
        data = padHex(Math.min(99, Math.max(0, Math.round(Number(command.percent) || 0))), 2);
        break;
      case 'wheel':
        cmd = CMDS.setTire;
        // 周长 mm，4 位十进制
        data = String(command.diameterMm).padStart(4, '0');
        break;
      case 'calibrate':
        cmd = CMDS.calibrateGyro;
        break;
      case 'restart':
        // 通过 FFE2 写单字节 0x33
        return { frames: [new Uint8Array([0x33])], meta: { command: 'restart', cmd: '33', name: CMD_NAMES.restart, ctrl: true } };
      case 'raw':
        return { frames: [new TextEncoder().encode(String(command.text))], meta: { command: 'raw', cmd: null, name: '原始帧' } };
      default:
        throw new Error('未知命令类型: ' + command.kind);
    }

    const text = buildCommand(cmd, imei, data);
    meta.cmd = cmd;
    meta.name = CMD_NAMES[cmd] || cmd;
    // 协议：hex 字符串经 string2Hex 转成原始字节写入（非 ASCII）
    return { frames: [hexStrToBytes(text)], meta };
  }

  /* ======================= 解码 ======================= */
  function parseReply(hexReply, prefs) {
    const imei = getImei(prefs);
    // 回复以十六进制字符串形式呈现；数值部分按原厂「十进制数字」解析
    const clean = hexReply.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const update = {};
    const prefix = (cmd) => cmd + 'F' + imei;

    // 通用读取：状态在 18-20 位，数值在 20-24 位
    function readValue(cmd, scale) {
      if (!clean.startsWith(prefix(cmd)) || clean.length < 24) return null;
      const state = clean.substr(18, 2);
      if (state !== '01') return null; // 状态非 01 视为失败
      const raw = parseInt(clean.substr(20, 4), 10); // 十进制
      return raw / scale;
    }

    // 电压 C0
    const voltage = readValue(CMDS.voltage, 10);
    if (voltage != null) {
      update.voltage = voltage;
      // 由电压估算电量百分比（10S 锂电：30V=0% ~ 42V=100%）
      update.battery = voltageToPercent(voltage);
    }

    // 速度 BF
    const speed = readValue(CMDS.speed, 10);
    if (speed != null) update.speed = speed;

    // 温度 C1
    const temperature = readValue(CMDS.temperature, 10);
    if (temperature != null) update.controllerTemp = temperature;

    // 陀螺仪/坡度 BD
    const gyro = readValue(CMDS.gyro, 10);
    if (gyro != null) {
      update.gyro = gyro;
      // 保留原始十六进制数值，便于实机比对缩放系数
      update.gyroRaw = clean.substr(20, 4);
    }

    // 里程 B1：米转公里
    const trip = readValue(CMDS.trip, 10);
    if (trip != null) update.trip = trip / 100;

    // 爬坡 C6（字段含义待确认，暂不解析）

    // 设置模式 C4 回包
    if (clean.startsWith(prefix(CMDS.setMode))) {
      const state = clean.substr(18, 2);
      if (state === '01') {
        const modeCode = parseInt(clean.substr(20, 2), 16);
        update.mode = MODE_BY_CODE[modeCode];
      }
    }

    const isAck = clean.startsWith('C4') || clean.startsWith('A5') || clean.startsWith('AB') || clean.startsWith('BE');
    return { update, kind: isAck ? 'ack' : 'report' };
  }

  /* ======================= 连接后初始化序列 ======================= */
  function initSequence(prefs) {
    return [
      { delay: 200, command: { kind: 'voltage' } },
      { delay: 200, command: { kind: 'speed' } },
      { delay: 200, command: { kind: 'temperature' } },
      { delay: 200, command: { kind: 'gyro' } },
    ];
  }

  /** 定时轮询的命令序列（连接后周期性执行） */
  function pollSequence(prefs) {
    return [
      { kind: 'voltage' },
      { kind: 'temperature' },
      { kind: 'speed' },
      { kind: 'gyro' },
    ];
  }

  /** 电压 → 电量百分比估算（36V 标称锂电池，10 串，满电 42V）
   *  采用分段线性拟合锂电放电曲线：
   *    42.0V = 100%  40.1V = 90%  36.0V = 45%  30.0V = 0%
   */
  function voltageToPercent(voltage) {
    if (voltage == null || !isFinite(voltage)) return null;
    // 分段端点：[电压, 百分比]
    const CURVE = [
      [42.0, 100],
      [40.1, 90],
      [36.0, 45],
      [30.0, 0],
    ];
    if (voltage >= CURVE[0][0]) return 100;
    if (voltage <= CURVE[CURVE.length - 1][0]) return 0;
    for (let i = 0; i < CURVE.length - 1; i++) {
      const [v1, p1] = CURVE[i];
      const [v2, p2] = CURVE[i + 1];
      if (voltage <= v1 && voltage >= v2) {
        const ratio = (voltage - v2) / (v1 - v2);
        return Math.round(p2 + ratio * (p1 - p2));
      }
    }
    return 0;
  }

  return {
    CMDS,
    CMD_NAMES,
    MODE_CODES,
    MODE_BY_CODE,
    DEFAULT_IMEI,
    encode,
    parseReply,
    initSequence,
    pollSequence,
    voltageToPercent,
    buildCommand,
    getImei,
    hexStrToBytes,
    bytesToHexStr,
    textToHex,
    hexToText,
  };
});