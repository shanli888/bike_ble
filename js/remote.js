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
    let notifyChs = [];
    let writeCh = null;
    let buf = ''; // 分片拼接缓冲
    const bufs = {}; // 按特征分别缓冲

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

      /* ---- 枚举全部服务与特征，收集所有可通知/可写特征 ---- */
      const notifyList = [];   // [{ ch, label }]
      const writeList = [];    // [{ ch, label }]
      try {
        const all = await server.getPrimaryServices();
        const lines = [];
        for (const s of all) {
          const chars = await s.getCharacteristics().catch(() => []);
          const parts = [];
          for (const c of chars) {
            const p = c.properties || {};
            const flags = [];
            if (p.notify) flags.push('notify');
            if (p.indicate) flags.push('indicate');
            if (p.write) flags.push('write');
            if (p.writeWithoutResponse) flags.push('writeNR');
            if (p.read) flags.push('read');
            const label = c.uuid.slice(4, 8);
            parts.push(`${label}(${flags.join('+') || '-'})`);
            if (p.notify || p.indicate) notifyList.push({ ch: c, label });
            if (p.write || p.writeWithoutResponse) writeList.push({ ch: c, label });
          }
          lines.push(`${s.uuid.slice(4, 8)}: ${parts.join(' ') || '(无特征)'}`);
        }
        log('服务清单 → ' + lines.join(' | '));
        log(`可通知特征: ${notifyList.map((x) => x.label).join(', ') || '无'}`);
        log(`可写特征: ${writeList.map((x) => x.label).join(', ') || '无'}`);
      } catch (e) {
        log('枚举服务失败: ' + (e.message || e));
      }

      if (!notifyList.length) throw new Error('设备没有可通知的特征，无法接收按键');

      /* ---- 依次订阅所有可通知特征 ---- */
      notifyChs = [];
      for (const item of notifyList) {
        const ch = item.ch;
        let ok = false;
        try {
          await ch.startNotifications();
          ok = true;
        } catch (e) {
          // 兜底写 CCCD
          try {
            const descs = await ch.getDescriptors();
            const cccd = descs.find((d) => d.uuid.startsWith('00002902'));
            if (cccd) {
              await cccd.writeValue(new Uint8Array(ch.properties.indicate ? [2, 0] : [1, 0]));
              ok = true;
            }
          } catch (e2) {
            ok = false;
          }
        }
        if (ok) {
          ch._label = item.label;
          ch.addEventListener('characteristicvaluechanged', onNotify);
          notifyChs.push(ch);
          log(`已订阅 ${item.label} 通知`);
        } else {
          log(`订阅 ${item.label} 失败`);
        }
      }
      if (!notifyChs.length) throw new Error('所有通知特征订阅失败');

      // 兼容旧引用
      notifyCh = notifyChs[0];
      // 优先用 A2A3 作为写入特征，否则取第一个可写的
      const a2a3 = writeList.find((x) => x.label === 'A2A3');
      writeCh = (a2a3 || writeList[0] || {}).ch || null;
      log('写入特征: ' + (writeCh ? (writeCh._label || 'A2A3') : '无'));

      // 主动读一次（部分设备读后才推送）
      for (const ch of notifyChs) {
        if (!ch.properties.read) continue;
        try {
          const dv = await ch.readValue();
          const hex = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
            .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
          log(`主动读 ${ch._label}: ${hex}`);
        } catch (_) {}
      }

      setStatus('ready');
      log('闪控已连接，请按一下 ▲ 或 ▼ 键');
      return state.device;
    }

    function hexToBytes(hex) {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }

    function onNotify(evt) {
      const ch = evt.target;
      const label = ch._label || ch.uuid.slice(4, 8);
      const v = ch.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      // 任何收到的字节都记录，并标注来自哪个特征
      emit('raw', `[${label}] ${hex}`);
      log(`← ${label} ${bytes.length}B: ${hex}`);

      // 按特征分别缓冲，避免互相污染
      let b = (bufs[label] || '') + hex;
      if (b.length > 512) b = b.slice(-128);

      let guard = 0;
      while (guard++ < 20) {
        // 已知按键帧：55AA 0A A2 A0 00 01 <key> 02（9 字节）
        const keyIdx = b.indexOf('55AA0AA2A00001');
        if (keyIdx >= 0 && b.length >= keyIdx + 18) {
          const frame = b.slice(keyIdx, keyIdx + 18);
          if (frame.endsWith('02')) {
            b = b.slice(keyIdx + 18);
            decodeFrame(frame);
            continue;
          }
        }
        // 非按键帧：整段打印，供分析
        if (b.length >= 4) {
          emit('other', { label, hex: b });
          log(`其它数据 [${label}]: ${b}`);
          b = '';
        }
        break;
      }
      bufs[label] = b;
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
      for (const ch of notifyChs) {
        try {
          ch.removeEventListener('characteristicvaluechanged', onNotify);
          ch.stopNotifications();
        } catch (_) {}
      }
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      notifyChs = [];
      notifyCh = null;
      writeCh = null;
      buf = '';
      Object.keys(bufs).forEach((k) => delete bufs[k]);
      state.device = null;
      setStatus('disconnected');
      log('闪控已断开');
    }

    /** 诊断：向写入特征依次写几种候选帧，观察是否触发通知 */
    async function ping() {
      if (!writeCh) {
        log('写入特征不可用');
        return;
      }
      const candidates = [
        '55AA0AA2A0000102',
        '55AA0AA2A00001',
        '55AA0AA2A0',
        '55AA0AA2A0000107',
        '55AA0AA2A0000108',
      ];
      for (const hex of candidates) {
        try {
          await writeCh.writeValue(hexToBytes(hex));
          log('↑ 写入 ' + hex);
        } catch (e) {
          log('写入失败 ' + hex + ': ' + (e.message || e));
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      log('探测完成，看上面是否出现 ← 数据');
    }

    /** 诊断：重新订阅所有通知特征 */
    async function resubscribe() {
      if (!notifyChs.length) {
        log('没有已订阅的特征');
        return;
      }
      for (const ch of notifyChs) {
        const label = ch._label || '?';
        try {
          ch.removeEventListener('characteristicvaluechanged', onNotify);
        } catch (_) {}
        try {
          await ch.stopNotifications();
        } catch (_) {}
        delete bufs[label];
        try {
          await ch.startNotifications();
          log(`重新订阅 ${label} 成功`);
        } catch (e) {
          log(`重新订阅 ${label} 失败: ${e.message || e}`);
        }
        ch.addEventListener('characteristicvaluechanged', onNotify);
      }
      log('重新订阅完成，请按一下闪控按键');
    }

    return { state, on, connect, disconnect, ping, resubscribe, supported, UUID, KEY_DOWN, hexToBytes };
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.remote = { createRemote, UUID, KEY_DOWN };
})(typeof globalThis !== 'undefined' ? globalThis : this);