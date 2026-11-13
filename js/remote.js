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

      // 先枚举服务与特征，便于诊断
      try {
        const all = await server.getPrimaryServices();
        const svcList = [];
        for (const s of all) {
          const chars = await s.getCharacteristics().catch(() => []);
          svcList.push(
            s.uuid + (chars.length ? ` [${chars.map((c) => c.uuid.slice(4, 8) + ':' + c.properties.write + '/' + c.properties.notify + '/' + c.properties.indicate).join(', ')}]` : '')
          );
        }
        log('服务列表: ' + svcList.join(' | '));
      } catch (e) {
        log('枚举服务失败: ' + (e.message || e));
      }

      const svc = await server.getPrimaryService(UUID.svc);
      notifyCh = await svc.getCharacteristic(UUID.noti);
      log(`已获取通知特征 ${notifyCh.uuid.slice(4, 8)}`);

      // 打开通知：先尝试 startNotifications，失败则手动写 CCCD
      let subOk = false;
      try {
        await notifyCh.startNotifications();
        subOk = true;
        log('startNotifications 成功');
      } catch (e) {
        log('startNotifications 失败: ' + (e.message || e) + '，尝试手动写 CCCD');
        try {
          const cccd = await server
            .getPrimaryService('00002902-0000-1000-8000-00805f9b34fb')
            .catch(() => null);
          if (cccd) await cccd.getCharacteristic(notifyCh.uuid).writeValue(new Uint8Array([1, 0]));
        } catch (e2) {
          // 走 characteristic 自带的 descriptor 路径
          try {
            const descs = await notifyCh.getDescriptors();
            const c = descs.find((d) => d.uuid.startsWith('00002902'));
            if (c) {
              await c.writeValue(new Uint8Array([1, 0]));
              subOk = true;
              log('CCCD 写入成功（notify）');
            }
          } catch (e3) {
            log('CCCD 写入也失败: ' + (e3.message || e3));
          }
        }
      }

      notifyCh.addEventListener('characteristicvaluechanged', onNotify);

      setStatus('ready');
      log(subOk ? '闪控已连接，等待按键…' : '闪控已连接但通知可能未开启，请按一下按键看日志');
      return state.device;
    }

    function onNotify(evt) {
      const v = evt.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      // 任何收到的字节都记录，便于实机诊断
      emit('raw', hex);
      log(`收到通知 ${bytes.length} 字节: ${hex}`);

      // 拼接分片
      buf += hex;
      if (buf.length > 512) buf = buf.slice(-128);

      // 逐帧提取：以 55AA 开头，按已知帧长切分；不确定长度时按 02 结尾判定
      let guard = 0;
      while (guard++ < 20) {
        const start = buf.indexOf('55AA');
        if (start < 0) { buf = ''; break; }
        if (start > 0) buf = buf.slice(start);
        if (buf.length < 18) break;

        const frame = buf.slice(0, 18);
        // 已知按键帧：55AA 0A A2 A0 00 01 <key> 02
        if (frame.startsWith('55AA0AA2A00001') && frame.endsWith('02')) {
          buf = buf.slice(18);
          decodeFrame(frame);
          continue;
        }
        // 其它帧：找下一个 55AA 重新对齐
        const next = buf.indexOf('55AA', 2);
        if (next < 0) { buf = buf.slice(buf.length > 64 ? buf.length - 2 : 0); break; }
        emit('other', buf.slice(0, next));
        log('未知帧: ' + buf.slice(0, next));
        buf = buf.slice(next);
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
        // 未识别的按键码：完整帧 + 码值都发出去，便于实测确认
        log(`未知按键码 ${key}，完整帧 ${frame}`);
        emit('other', frame);
        emit('unknownKey', { key, frame });
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