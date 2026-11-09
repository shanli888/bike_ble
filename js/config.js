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

  /** 连接目标（可在设置中覆盖） */
  const CONNECTION_DEFAULTS = {
    serviceUuid: UUID.svcMain,
    writeUuid: UUID.chMain,
    notifyUuid: UUID.chMain,
    ctrlUuid: UUID.chCtrl,
    writeMode: 'withoutResponse',
  };

  /** 显示/用车设置 */
  const PREF_DEFAULTS = {
    sliderStep: 5,
    frameGapMs: 40,
    keepScreenOn: true,
    simulateWhenDisconnected: false, // 未连接时是否显示示例数据（默认关闭）
    wheelInch: 26, // 固定 26 寸
    imei: '866855030090179', // 电机 IMEI，必填
    connection: util.deepMerge(CONNECTION_DEFAULTS, {}),
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

  /** 旧版本迁移入口 */
  function migrate(prefs) {
    if (prefs.imei == null) prefs.imei = '866855030090179';
    prefs.wheelInch = 26; // 固定 26 寸，覆盖旧值
    delete prefs.unit; // 移除旧的速度单位选项
    // 演示数据由用户在设置页手动开关，不再强制开启
    if (typeof prefs.simulateWhenDisconnected !== 'boolean') prefs.simulateWhenDisconnected = false;
    return prefs;
  }

  function resetPrefs() {
    storageSet('prefs', '');
    return loadPrefs();
  }

  return {
    UUID,
    CONNECTION_DEFAULTS,
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