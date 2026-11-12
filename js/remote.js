/* =========================================================================
 * remote.js — BR80 闪控（LIVALL）蓝牙遥控器
 *
 * 协议（见 BR80闪控_蓝牙协议逆向.md）：
 *   服务  0000A2A0-0000-1000-8000-00805F9B34FB
 *   通知  0000A2A4（收按键事件）
 *   写入  0000A2A3（发命令）
 *
 * 按键帧: 55AA 0A A2 A0 00 01 <key> 02
 *   上键按下  ...0107    上键抬起  ...0108
 *   下键按下  ...0122    下键抬起  ...011D
 *   右键按下  ...0105    右键抬起  ...0109
 *   左键按下  ...010B    左键抬起  ...010B
 *   主键按下  ...0106    主键抬起  ...0102
 *
 * 只使用「按下沿」触发，避免一次按键产生两次动作。
 * ========================================================================= */
(function (root) {
  'use strict';

  const UUID = {
    svc: '0000a2a0-0000-1000-8000-00805f9b34fb',
    noti: '0000a2a4-0000-1000-8000-00805f9b34fb',
    write: '0000a2a3-0000-1000-8000-00805f9b34fb',
  };

  /** 按键码 → 语义（仅按下沿） */
  const KEY_DOWN = {
    '07': 'up',
    '22': 'down',
    '05': 'right',
    '0B': 'left',
    '06': 'home',
  };
  const KEY_UP_SET = new Set(['08', '1D', '09', '02']);

  function createRemote() {
    const state = {
      status: 'idle', // idle | requesting | connecting | ready | disconnected | error
      device: null,
      error: null,
    };
    const listeners = {};
    let device = null;
    let notifyCh = null;
    let buf = ''; // 分片拼接缓冲

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
          console.error('[remote] listener error', evt, e);
        }
      });
    }
    function log(text) {
      emit('log', text);
    }
    function setStatus(status, error) {
      state.status = status;
      state.error = error || null;
      emit('state', { ...state });
    }

    function supported() {
      return !!(root.navigator && root.navigator.bluetooth && root.navigator.bluetooth.requestDevice);
    }

    /**
     * 弹出设备选择器并连接闪控。
     * 注意：必须在用户手势里调用（点击事件）。
     */
    async function connect() {
      if (!supported()) throw new Error('Web Bluetooth 不可用');
      if (state.status === 'ready') return state.device;

      setStatus('requesting');
      try {
        device = await root.navigator.bluetooth.requestDevice({
          filters: [
            { services: [UUID.svc] },
            { namePrefix: 'BR80' },
            { namePrefix: 'BR' },
            { namePrefix: 'LIVALL' },
          ],
          optionalServices: [UUID.svc, '0000180a-0000-1000-8000-00805f9b34fb'],
        });
      } catch (err) {
        setStatus('idle');
        const msg = (err && err.message) || JSON.stringify(err);
        if (err && err.name === 'NotFoundError') log('已取消选择闪控');
        else log('选择闪控失败: ' + msg);
        throw err;
      }

      state.device = { id: device.id, name: device.name || '闪控' };
      emit('device', state.device);
      log(`已选择 ${state.device.name}`);

      device.addEventListener('gattserverdisconnected', () => {
        log('闪控已断开');
        setStatus('disconnected');
      });

      setStatus('connecting');
      const server = await device.gatt.connect();
      const svc = await server.getPrimaryService(UUID.svc);
      notifyCh = await svc.getCharacteristic(UUID.noti);

      // 写 CCCD 打开通知
      try {
        await notifyCh.startNotifications();
      } catch (e) {
        // 某些实现需要手动写 CCCD
      }
      notifyCh.addEventListener('characteristicvaluechanged', onNotify);

      setStatus('ready');
      log('闪控已连接，按键可用');
      return state.device;
    }

    function onNotify(evt) {
      const v = evt.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      emit('raw', hex);

      // 拼接分片：帧以 "02" 结尾才算完整
      buf += hex;
      // 防止缓冲无限增长
      if (buf.length > 512) buf = buf.slice(-128);

      // 逐帧提取：寻找 55AA 开头、02 结尾的完整段
      let guard = 0;
      while (guard++ < 20) {
        const start = buf.indexOf('55AA');
        if (start < 0) {
          buf = '';
          break;
        }
        if (start > 0) buf = buf.slice(start);
        // 闪控按键帧固定 9 字节 = 18 hex 字符，且以 02 结尾
        if (buf.length < 18) break;
        const frame = buf.slice(0, 18);
        if (!frame.endsWith('02')) {
          // 不是按键帧，尝试找下一帧
          buf = buf.slice(2);
          continue;
        }
        buf = buf.slice(18);
        decodeFrame(frame);
      }
    }

    /** 解析按键帧并派发事件 */
    function decodeFrame(frame) {
      // 55AA0AA2A0000107
      // 0123456789...
      if (!frame.startsWith('55AA0AA2A00001')) {
        emit('other', frame);
        return;
      }
      const key = frame.substr(14, 2);
      if (KEY_UP_SET.has(key)) {
        emit('release', { key });
        return;
      }
      const name = KEY_DOWN[key];
      if (name) {
        log(`按键: ${name}`);
        emit('key', { key, name });
      } else {
        emit('other', frame);
      }
    }

    function disconnect() {
      if (notifyCh) {
        notifyCh.removeEventListener('characteristicvaluechanged', onNotify);
        try {
          notifyCh.stopNotifications();
        } catch (_) {}
      }
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      notifyCh = null;
      buf = '';
      state.device = null;
      setStatus('disconnected');
      log('闪控已断开');
    }

    return { state, on, connect, disconnect, supported, UUID, KEY_DOWN };
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.remote = { createRemote, UUID, KEY_DOWN };
})(typeof globalThis !== 'undefined' ? globalThis : this);