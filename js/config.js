/* =========================================================================
 * config.js — 默认配置 / 常量 / 设置读写
 * ========================================================================= */
(function (root, factory) {
  const util = typeof module === 'object' && module.exports ? require('./util.js') : root.LVBU.util;
  const api = factory(util, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.LVBU = root.LVBU || {}).config = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util, root) {
  'use strict';

  /* ---------------- GATT UUID ---------------- */
  const UUID = {
    svcMain: '0000ffe0-0000-1000-8000-00805f9b34fb', // 主数据服务
    chMain: '0000ffe1-0000-1000-8000-00805f9b34fb', // 读写/通知主通道
    chCtrl: '0000ffe2-0000-1000-8000-00805f9b34fb', // 控制命令
    chStatus: '0000ffe3-0000-1000-8000-00805f9b34fb', // 状态上报
    svcBattery: '0000180f-0000-1000-8000-00805f9b34fb',
    chBatteryLevel: '00002a19-0000-1000-8000-00805f9b34fb',
    svcDeviceInfo: '0000180a-0000-1000-8000-00805f9b34fb',
    chManufacturer: '00002a29-0000-1000-8000-00805f9b34fb',
    chModel: '00002a24-0000-1000-8000-00805f9b34fb',
    chSerial: '00002a25-0000-1000-8000-00805f9b34fb',
    chHwRev: '00002a27-0000-1000-8000-00805f9b34fb',
    chFwRev: '00002a28-0000-1000-8000-00805f9b34fb',
  };

  /** 可在「设置 → 协议参数」里覆盖的连接目标 */
  const CONNECTION_DEFAULTS = {
    serviceUuid: UUID.svcMain,
    writeUuid: UUID.chMain,
    notifyUuid: UUID.chMain,
    writeMode: 'auto', // auto | withResponse | withoutResponse
    notifyMode: 'notify', // notify | indicate
    useCtrlCharForMode: false, // 助力模式类命令是否改走 FFE2
  };

  /** 帧结构默认值（依据真实协议 README） */
  const PROTOCOL_DEFAULTS = {
    header: [0xaa, 0x55],
    lenMode: 'cmd_payload', // len = 1(命令字) + 数据长度
    lenFieldAdjust: 0,
    cmdSize: 1,
    checksum: 'invsum', // 累加和取反：0xFF - (sum & 0xFF)，覆盖整帧含帧头
    checksumIncludesHeader: true, // invsum 恒覆盖帧头
    littleEndian: false,
    maxFrame: 512,
  };

  /** 显示/用车设置 */
  const PREF_DEFAULTS = {
    unit: 'kmh', // kmh | mph
    wheelInch: 27.5,
    sliderStep: 5,
    frameGapMs: 40,
    keepScreenOn: true,
    simulateWhenDisconnected: false,
    protocol: util.deepMerge(PROTOCOL_DEFAULTS, {}),
    connection: util.deepMerge(CONNECTION_DEFAULTS, {}),
    commands: {}, // 用户覆盖的命令字
    autoConnect: { id: '', name: '' },
  };

  /** 骑行模式 */
  const RIDE_MODES = [
    { key: 'commute', label: '通勤', icon: 'commute', assist: 1 },
    { key: 'exercise', label: '运动', icon: 'exercise', assist: 2 },
    { key: 'climbing', label: '爬坡', icon: 'climbing', assist: 3 },
    { key: 'leisure', label: '休闲', icon: 'leisure', assist: 0 },
    { key: 'manual', label: '手动', icon: 'manual', assist: null }, // 手动模式用 percent
  ];

  /** 轮径（英寸）→ 周长（mm）常用规格 */
  const WHEEL_CIRCUMFERENCE = {
    12: 970, 14: 1080, 16: 1230, 18: 1380,
    20: 1520, 22: 1680, 24: 1800, 25: 1905,
    26: 1985, 27: 2110, 27.5: 2165, 28: 2205, 29: 2280,
  };

  function wheelCircumferenceMm(inch) {
    const key = Number(inch);
    if (WHEEL_CIRCUMFERENCE[key] != null) return WHEEL_CIRCUMFERENCE[key];
    // 非标规格：按直径×π 估算
    return Math.round(inch * 25.4 * Math.PI);
  }

  const STORAGE_PREFIX = 'lvbu-ble:';
  const isNode = typeof module === 'object' && module.exports;
  const memoryStore = {};

  function storageGet(key) {
    try {
      if (isNode) return memoryStore[key] ?? null;
      return root.localStorage.getItem(STORAGE_PREFIX + key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      if (isNode) {
        memoryStore[key] = value;
        return;
      }
      root.localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch (_) {
      /* 隐私模式下 localStorage 可能抛错，忽略 */
    }
  }

  function loadPrefs() {
    const raw = storageGet('prefs');
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = null;
      }
    }
    return migrate(util.deepMerge(JSON.parse(JSON.stringify(PREF_DEFAULTS)), parsed || {}));
  }

  function savePrefs(prefs) {
    storageSet('prefs', JSON.stringify(prefs));
  }

  /** 旧版本迁移入口（当前无破坏性变更） */
  function migrate(prefs) {
    if (!Array.isArray(prefs.protocol.header)) prefs.protocol.header = PROTOCOL_DEFAULTS.header.slice();
    return prefs;
  }

  function resetPrefs() {
    storageSet('prefs', '');
    return loadPrefs();
  }

  return {
    UUID,
    CONNECTION_DEFAULTS,
    PROTOCOL_DEFAULTS,
    PREF_DEFAULTS,
    RIDE_MODES,
    WHEEL_CIRCUMFERENCE,
    wheelCircumferenceMm,
    loadPrefs,
    savePrefs,
    resetPrefs,
    storageGet,
    storageSet,
    isNode,
  };
});