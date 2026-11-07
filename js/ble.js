/* =========================================================================
 * ble.js — Web Bluetooth 传输层（Bluefy / Chrome / Edge）
 *
 * 只负责“字节进、字节出”和连接生命周期，所有业务语义都在 adapter.js。
 * 暴露一个最小接口，便于 DemoTransport 复用同一套上层逻辑：
 *   connect() / disconnect() / write(bytes) / read(uuid)
 *   事件：log / state / drop / frame
 *
 * Bluefy 关键约束（Web Bluetooth 标准行为）：
 *   1. 必须由用户手势（tap）触发 requestDevice
 *   2. 选中的设备名在页面生命周期内不可复用——换设备必须刷新页面
 *   3. 授权在 App 前台存活期间有效
 *   4. 不支持 getDevices()（无法“无提示重连”）
 *   5. iOS 不向网页暴露蓝牙 MAC 地址（只有随机 device.id）
 * ========================================================================= */
(function (root) {
  'use strict';
  const { util, protocol, adapter } = root.LVBU;

  const SERVICE_NAME_PREFIXES = [
    'LVBU', 'WEPOWER', 'VIRVOLT', 'EASIFIT', 'HIGHWING',
    'EGREEN', 'VERTTIRE', 'GEROAD', 'BT-', 'EB-', 'BIKE-', 'MOTOR',
  ];

  function createTransport(prefs) {
    const state = {
      kind: 'ble',
      status: 'idle', // idle | requesting | connecting | discovering | ready | error | disconnected
      device: null, // { id, name }
      rssi: null,
      chars: null, // { write, notify, ctrl, status }
      error: null,
      writeMode: null,
    };
    const listeners = {};
    const writeQueue = util.createQueue();
    let server = null;
    let notifyChar = null;
    let writeChar = null;
    let parser = null;
    let lastGattUuid = null;
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
          console.error('[listener error]', evt, e);
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

    /** 仅在主动扫描时提示缺少 Web Bluetooth */
    function ensureApi() {
      if (supported()) return true;
      log('error', '此浏览器不支持 Web Bluetooth。iOS 请用 Bluefy 打开本页面（Safari 不支持）。');
      setStatus('error', 'Web Bluetooth 不可用');
      return false;
    }

    /**
     * 用户手势内调用。
     * @param opts { allDevices:boolean }
     */
    async function connect(opts = {}) {
      if (!ensureApi()) throw new Error('Web Bluetooth 不可用');
      if (state.status === 'ready') {
        emit('toast', { text: '已连接 ' + (state.device && state.device.name) });
        return state.device;
      }
      setStatus('requesting');
      // 默认显示所有蓝牙设备（不过滤）
      const filters = opts.allDevices ? [] : [];
      let device;
      try {
        device = await root.navigator.bluetooth.requestDevice({
          filters,
          optionalServices: [
            prefs.connection.serviceUuid,
            root.LVBU.config.UUID.svcMain,
            root.LVBU.config.UUID.svcBattery,
            root.LVBU.config.UUID.svcDeviceInfo,
          ],
        });
      } catch (err) {
        setStatus('idle');
        if (err && err.name === 'NotFoundError') {
          log('info', '已取消设备选择');
        } else {
          log('error', '选择设备失败: ' + (err && err.message ? err.message : err));
        }
        throw err;
      }

      // 服务端支持 getDevices()（Chrome/Edge）时缓存授权，便于无提示重连；
      // Bluefy(iOS) 不支持，只能用内存中的 device 对象。
      try {
        if (typeof device.gatt.connect === 'function' && !root.LVBU.ble._lastDevice) {
          root.LVBU.ble._lastDevice = device;
        }
        if (root.navigator.bluetooth.getDevices) {
          const granted = await root.navigator.bluetooth.getDevices().catch(() => []);
          root.LVBU.ble._lastDevice = granted.find((d) => d.id === device.id) || device;
        }
      } catch (_) {
        root.LVBU.ble._lastDevice = device;
      }

      state.device = { id: device.id, name: device.name || '(未命名)' };
      lastGattUuid = device.id;
      emit('device', state.device);
      log('info', `已选择设备 ${state.device.name} (${state.device.id})`);

      device.addEventListener('gattserverdisconnected', () => {
        log('warn', '蓝牙已断开');
        setStatus('disconnected');
        if (rssiTimer) clearInterval(rssiTimer);
        rssiTimer = null;
        state.rssi = null;
      });

      await openGatt();
      return state.device;
    }

    async function openGatt() {
      const device = currentDevice();
      if (!device) throw new Error('没有已授权的设备');
      setStatus('connecting');
      log('ble', '正在连接 GATT…');
      server = await util.withTimeout(device.gatt.connect(), 15000, 'GATT 连接');
      if (device.gatt && device.gatt.connected === false) throw new Error('GATT 连接未建立');

      setStatus('discovering');
      const conn = prefs.connection;
      log('ble', '正在发现服务…');
      const svc = await server.getPrimaryService(conn.serviceUuid);
      const services = await server.getPrimaryServices().catch(() => [svc]);
      log('info', `发现 ${services.length} 个服务: ` + services.map((s) => util.shortUuid(s.uuid)).join(', '));

      const notifyUuid = conn.notifyUuid || conn.writeUuid;
      notifyChar = await svc.getCharacteristic(notifyUuid);
      writeChar = await findWritable(svc, conn);

      await startNotifications(notifyChar);
      state.chars = {
        write: writeChar ? util.shortUuid(writeChar.uuid) : null,
        notify: util.shortUuid(notifyChar.uuid),
        service: util.shortUuid(svc.uuid),
        writeMode: state.writeMode,
      };

      // 可选辅助通道
      try {
        await svc.getCharacteristic(conn.ctrlUuid || root.LVBU.config.UUID.chCtrl);
      } catch (_) {}
      try {
        await svc.getCharacteristic(root.LVBU.config.UUID.chStatus);
      } catch (_) {}

      parser = protocol.createParser(prefs.protocol, (frame) => {
        emit('frame', frame);
        try {
          const res = adapter.decode(frame, prefs);
          emit('update', res.update);
        } catch (e) {
          log('error', '帧解析异常: ' + e.message);
        }
      });

      setStatus('ready');
      log('info', `已连接 · 写 ${state.chars.write} / 通知 ${state.chars.notify} (${state.writeMode})`);
      startRssiPoll();
      readBatteryLevel();
    }

    async function findWritable(svc, conn) {
      try {
        const ch = await svc.getCharacteristic(conn.writeUuid);
        const props = ch.properties || {};
        if (props.writeWithoutResponse && !props.write) state.writeMode = 'withoutResponse';
        else if (props.write) state.writeMode = 'withResponse';
        else state.writeMode = 'withoutResponse';
        if (conn.writeMode === 'withResponse' || conn.writeMode === 'withoutResponse') {
          state.writeMode = conn.writeMode;
        }
        return ch;
      } catch (err) {
        log('warn', '指定写特征不可用，改为遍历查找: ' + err.message);
        const all = await svc.getCharacteristics();
        const cand = all.find((c) => c.properties && (c.properties.write || c.properties.writeWithoutResponse));
        if (!cand) throw new Error('未找到可写特征');
        state.writeMode = cand.properties.write ? 'withResponse' : 'withoutResponse';
        return cand;
      }
    }

    async function startNotifications(ch) {
      if (!ch.properties || (!ch.properties.notify && !ch.properties.indicate)) {
        log('warn', `特征 ${util.shortUuid(ch.uuid)} 不支持通知，仅能主动读取`);
        return;
      }
      ch.addEventListener('characteristicvaluechanged', onNotify);
      await ch.startNotifications();
      log('ble', '已订阅通知 ' + util.shortUuid(ch.uuid));
    }

    function onNotify(evt) {
      const value = evt.target.value;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      emit('drop', { dir: 'rx', bytes });
      if (parser) parser.push(bytes);
    }

    function currentDevice() {
      return root.LVBU.ble._lastDevice || null;
    }

    /** 连接中设备的 RSSI：标准 Web Bluetooth 无 readRssi，
     *  Android Chrome 有 watchAdvertisements 时可用，iOS/Bluefy 下返回 null（界面显示 --）。 */
    function startRssiPoll() {
      if (rssiTimer) clearInterval(rssiTimer);
      rssiTimer = null;
      const d = currentDevice();
      if (!d || typeof d.watchAdvertisements !== 'function') return;
      d.addEventListener('advertisementreceived', (evt) => {
        if (evt.rssi != null && evt.rssi !== state.rssi) {
          state.rssi = evt.rssi;
          emit('rssi', evt.rssi);
        }
      });
      d.watchAdvertisements().catch(() => {
        log('info', 'RSSI 监测不可用（iOS 限制），信号强度显示为 --');
      });
    }

    async function readBatteryLevel() {
      try {
        const bsvc = await server.getPrimaryService(root.LVBU.config.UUID.svcBattery);
        const bch = await bsvc.getCharacteristic(root.LVBU.config.UUID.chBatteryLevel);
        const v = await bch.readValue();
        if (v.byteLength >= 1) emit('update', { battery: v.getUint8(0) });
      } catch (_) {
        /* 设备未提供标准电池服务，忽略 */
      }
    }

    /**
     * 写入（串行化 + 自动分包，默认 BLE 20 字节 MTU）
     * @param bytes Uint8Array
     */
    function write(bytes) {
      return writeQueue(async () => {
        if (!writeChar || state.status !== 'ready') throw new Error('蓝牙未连接');
        const gap = Math.max(0, Number(prefs.frameGapMs) || 0);
        const chunk = 20;
        for (let i = 0; i < bytes.length; i += chunk) {
          const part = bytes.slice(i, i + chunk);
          emit('drop', { dir: 'tx', bytes: part });
          try {
            if (state.writeMode === 'withoutResponse') await writeChar.writeValueWithoutResponse(part);
            else await writeChar.writeValueWithResponse(part);
          } catch (err) {
            log('error', '写入失败: ' + (err && err.message ? err.message : err));
            throw err;
          }
          if (gap > 0 && i + chunk < bytes.length) await util.sleep(gap);
        }
      });
    }

    async function read(uuid) {
      if (!server) throw new Error('未连接');
      const ch = await server.getPrimaryService(prefs.connection.serviceUuid).then((s) => s.getCharacteristic(uuid));
      const v = await ch.readValue();
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }

    function disconnect() {
      if (rssiTimer) clearInterval(rssiTimer);
      rssiTimer = null;
      const d = currentDevice();
      if (notifyChar) {
        notifyChar.removeEventListener('characteristicvaluechanged', onNotify);
        notifyChar.stopNotifications().catch(() => {});
      }
      if (d && d.gatt && d.gatt.connected) d.gatt.disconnect();
      server = null;
      writeChar = null;
      notifyChar = null;
      setStatus('disconnected');
      log('info', '已断开连接');
    }

    /** 断线重连：Bluefy 不支持 getDevices()，只能依赖现有 device 对象 */
    async function reconnect() {
      if (!currentDevice()) throw new Error('无法自动重连：请重新在设备页选择设备');
      await openGatt();
    }

    return {
      kind: 'ble',
      state,
      on,
      supported,
      connect,
      reconnect,
      disconnect,
      write,
      read,
      get lastGattUuid() {
        return lastGattUuid;
      },
    };
  }

  root.LVBU.ble = { createTransport, SERVICE_NAME_PREFIXES };
})(typeof globalThis !== 'undefined' ? globalThis : this);