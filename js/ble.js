/* =========================================================================
 * ble.js — Web Bluetooth 传输层（Bluefy / iOS WebView）
 *
 * 协议：LVBU 3.4.0 文本协议
 *   服务：FFE0
 *   写入/通知：FFE1（同一特征，双向）
 *   控制/重启：FFE2
 *
 * 所有通知以十六进制字符串形式返回，adapter 负责解析。
 * ========================================================================= */
(function (root) {
  'use strict';
  const { util, adapter, config } = root.LVBU;

  function createTransport(prefs) {
    const state = {
      kind: 'ble',
      status: 'idle',
      device: null,
      rssi: null,
      chars: null,
      writeMode: 'withoutResponse',
      error: null,
    };

    const listeners = {};
    let device = null;
    let server = null;
    let ffe1 = null;
    let ffe2 = null;
    let rssiTimer = null;

    function on(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
      return () => {
        listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
      };
    }
    function emit(evt, data) {
      (listeners[evt] || []).forEach((fn) => {
        try {
          fn(data);
        } catch (e) {
          console.error('[BLE listener error]', evt, e);
        }
      });
    }
    function log(direction, text, extra) {
      emit('log', { direction, text, ...(extra || {}) });
    }
    function setStatus(status, error) {
      state.status = status;
      state.error = error || null;
      emit('state', { ...state });
    }

    function supported() {
      return !!(root.navigator && root.navigator.bluetooth && root.navigator.bluetooth.requestDevice);
    }

    function ensureApi() {
      if (supported()) return true;
      log('error', '此浏览器不支持 Web Bluetooth。iOS 请用 Bluefy 打开。');
      setStatus('error', 'Web Bluetooth 不可用');
      return false;
    }

    async function connect(opts = {}) {
      if (!ensureApi()) throw new Error('Web Bluetooth 不可用');
      if (state.status === 'ready') {
        emit('toast', { text: '已连接 ' + (state.device && state.device.name) });
        return state.device;
      }
      setStatus('requesting');

      try {
        // 按名称前缀过滤（LvBu motor 相关设备），避免列表里全是无关设备
        device = await root.navigator.bluetooth.requestDevice({
          filters: [
            { namePrefix: 'LvBu' },
            { namePrefix: 'LVBU' },
            { namePrefix: 'lvbu' },
            { services: [config.UUID.svcMain] },
          ],
          optionalServices: [config.UUID.svcMain, config.UUID.svcBattery, config.UUID.svcDeviceInfo],
        });
      } catch (err) {
        setStatus('idle');
        const errorMsg = err && err.message ? err.message : JSON.stringify(err);
        if (err && err.name === 'NotFoundError') {
          log('info', '已取消设备选择');
        } else {
          log('error', '选择设备失败: ' + errorMsg);
          emit('toast', { text: '选择设备失败: ' + errorMsg, level: 'error' });
        }
        throw err;
      }

      state.device = { id: device.id, name: device.name || '(未命名)' };
      emit('device', state.device);
      log('info', `已选择设备 ${state.device.name}`);

      device.addEventListener('gattserverdisconnected', () => {
        log('warn', '蓝牙已断开');
        setStatus('disconnected');
        if (rssiTimer) clearInterval(rssiTimer);
        rssiTimer = null;
      });

      await openGatt();
      return state.device;
    }

    async function openGatt() {
      setStatus('connecting');
      log('ble', '正在连接 GATT…');
      server = await device.gatt.connect();

      setStatus('discovering');
      const svc = await server.getPrimaryService(config.UUID.svcMain);
      ffe1 = await svc.getCharacteristic(config.UUID.chMain);
      try {
        ffe2 = await svc.getCharacteristic(config.UUID.chCtrl);
      } catch (_) {
        ffe2 = null;
      }

      state.chars = {
        write: 'ffe1',
        notify: 'ffe1',
        ctrl: ffe2 ? 'ffe2' : null,
        writeMode: 'withoutResponse',
      };

      // 订阅 FFE1 通知
      await ffe1.startNotifications();
      ffe1.addEventListener('characteristicvaluechanged', onNotify);
      log('ble', '已订阅 FFE1 通知');

      setStatus('ready');
      log('info', `已连接 · FFE1 已订阅${ffe2 ? ' · FFE2 可用' : ''}`);
      startRssiPoll();
    }

    function onNotify(evt) {
      const value = evt.target.value;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      // 文本协议回复：字节 → 十六进制字符串
      const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      emit('drop', { dir: 'rx', bytes, hex });
      log('rx', hex, { bytes: hex });
      try {
        const res = adapter.parseReply(hex, prefs);
        if (Object.keys(res.update).length) emit('update', res.update);
        emit('frame', { raw: hex, ...res });
      } catch (e) {
        log('warn', '解析回复失败: ' + e.message);
      }
    }

    async function write(data) {
      if (!ffe1 || state.status !== 'ready') throw new Error('蓝牙未连接');
      let bytes;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else {
        bytes = new Uint8Array(data);
      }
      emit('drop', { dir: 'tx', bytes });
      // 文本协议通常用无应答写；FFE2 重启写也用无应答
      const writeFn = ffe1.writeValueWithoutResponse ? ffe1.writeValueWithoutResponse.bind(ffe1) : ffe1.writeValue.bind(ffe1);
      await writeFn(bytes);
      // 等待下一帧间隔
      if (prefs.frameGapMs > 0) await util.sleep(prefs.frameGapMs);
    }

    async function writeCtrl(data) {
      if (!ffe2 || state.status !== 'ready') throw new Error('FFE2 不可用');
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      await ffe2.writeValueWithoutResponse ? ffe2.writeValueWithoutResponse(bytes) : ffe2.writeValue(bytes);
    }

    async function read(uuid) {
      if (!server) throw new Error('未连接');
      const svc = await server.getPrimaryService(config.UUID.svcMain);
      const ch = await svc.getCharacteristic(uuid);
      const v = await ch.readValue();
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }

    function disconnect() {
      if (rssiTimer) clearInterval(rssiTimer);
      rssiTimer = null;
      if (ffe1) ffe1.removeEventListener('characteristicvaluechanged', onNotify);
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      server = null;
      ffe1 = null;
      ffe2 = null;
      setStatus('disconnected');
      log('info', '已断开连接');
    }

    function startRssiPoll() {
      if (rssiTimer) clearInterval(rssiTimer);
      rssiTimer = null;
      if (!device || typeof device.watchAdvertisements !== 'function') return;
      device.addEventListener('advertisementreceived', (evt) => {
        if (evt.rssi != null && evt.rssi !== state.rssi) {
          state.rssi = evt.rssi;
          emit('rssi', evt.rssi);
        }
      });
      device.watchAdvertisements().catch(() => {});
    }

    return {
      kind: 'ble',
      state,
      on,
      connect,
      disconnect,
      write,
      writeCtrl,
      read,
    };
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.ble = { createTransport, supported: () => !!(root.navigator && root.navigator.bluetooth && root.navigator.bluetooth.requestDevice) };
})(typeof globalThis !== 'undefined' ? globalThis : this);