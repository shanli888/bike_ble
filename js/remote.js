/* =========================================================================
 * remote.js — BR80 / BlingRemote 闪控（LIVALL）蓝牙遥控器
 *
 * 协议（见 BR80闪控_蓝牙协议逆向.md §4、§6.2）：
 *   服务  0000A2A0-0000-1000-8000-00805F9B34FB
 *   通知  0000A2A4（收按键事件）
 *   写入  0000A2A3（发 26 字节帧激活/握手）
 *
 * 按键帧 8 字节 = 16 个十六进制字符，无帧尾、无校验：
 *     55 AA 0A A2 A0 00 01 <key>
 *
 *   按下 / 抬起（抬起 = 按下码 + 0x20）：
 *     ▲ 上    0107 / 0127
 *     ▼ 下    0108 / 0128
 *     ◀ 左    0102 / 0122
 *     ▶ 右    0105 / 0125
 *     ● 主键  0106 / 0126
 *     📷 相机 0109 / 0129
 *     🎤 通话 010B / 012B
 *
 * 下发帧（26 字节）：55 AA C0 14 01 <payload 20B> 19
 * ========================================================================= */
(function (root) {
  'use strict';

  const UUID = {
    svc: '0000a2a0-0000-1000-8000-00805f9b34fb',
    noti: '0000a2a4-0000-1000-8000-00805f9b34fb',
    write: '0000a2a3-0000-1000-8000-00805f9b34fb',
  };

  const FRAME_PREFIX = '55AA0AA2A00001'; // 16 字符帧的前 14 位

  /* ===== BR80 直连实际协议（文档 §6.2A / §6.2B，优先级最高）=====
   * A2A4 通知只发单字节：
   *   按下 0x05~0x09  → fw2.T1 的 switch#1（5 个键）
   *   抬起 0x25~0x29  → switch#2（5 个键）
   * 具体「字节 → 键名」文档尚未 100% 钉死，这里按 *候选顺序* 映射，
   * 并把未知字节原样打日志，便于实机锁定。
   *
   * 电量：取通知串末 2 字符按 16 进制；"88" 表示电量充足（特殊标志）。
   */
  const BYTE_DOWN = {
    '05': 'up',
    '06': 'down',
    '07': 'left',
    '08': 'right',
    '09': 'home',
  };
  const BYTE_UP = {
    '25': 'up',
    '26': 'down',
    '27': 'left',
    '28': 'right',
    '29': 'home',
  };

  /** 按下码 → 语义（55AA 帧线路，仅作兼容保留） */
  const KEY_DOWN = {
    '07': 'up',
    '08': 'down',
    '02': 'left',
    '05': 'right',
    '06': 'home',
    '09': 'camera',
    '0B': 'talk',
  };
  /** 抬起码 = 按下码 + 0x20 */
  const KEY_UP = {
    '27': 'up',
    '28': 'down',
    '22': 'left',
    '25': 'right',
    '26': 'home',
    '29': 'camera',
    '2B': 'talk',
  };

  /** 组装 26 字节下发帧（§3.1）：55 AA C0 14 01 + 20B payload + 19 */
  function buildDownlink(payloadHex) {
    let p = (payloadHex || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    const payload = p.slice(0, 40).padEnd(40, '0'); // 20 字节 = 40 hex
    return '55AAC01401' + payload + '19';
  }

  function createRemote() {
    const state = {
      status: 'idle', // idle | requesting | connecting | ready | disconnected | error
      device: null,
      error: null,
      battery: null,    // 0~100（来自 180F/2A19）
      signal: null,     // 预留
    };
    const listeners = {};
    let device = null;
    let notifyCh = null;
    let notifyChs = [];
    let writeCh = null;
    let buf = ''; // 分片拼接缓冲
    const bufs = {}; // 按特征分别缓冲
    const chLabels = new WeakMap(); // characteristic → "服务/特征" 标签

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
            { namePrefix: 'BlingRemote' },   // 文档 §6.3 确认的设备名
            { namePrefix: 'BR80' },
            { namePrefix: 'BR' },
            { namePrefix: 'LIVALL' },
          ],
          optionalServices: [
            UUID.svc,
            '0000180a-0000-1000-8000-00805f9b34fb', // 180A 设备信息
            '0000180f-0000-1000-8000-00805f9b34fb', // 180F 电池
            '5833ff01-9b8b-5191-6142-22a4536ef123', // 私有透传通道
          ],
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
      const notifyList = [];   // [{ ch, label, svcLabel }]
      const writeList = [];    // [{ ch, label, svcLabel }]
      try {
        const all = await server.getPrimaryServices();
        const lines = [];
        for (const s of all) {
          const chars = await s.getCharacteristics().catch(() => []);
          const parts = [];
          const svcShort = s.uuid.length > 8 ? s.uuid.slice(4, 8).toUpperCase() : s.uuid;
          for (const c of chars) {
            const p = c.properties || {};
            const flags = [];
            if (p.notify) flags.push('notify');
            if (p.indicate) flags.push('indicate');
            if (p.write) flags.push('write');
            if (p.writeWithoutResponse) flags.push('writeNR');
            if (p.read) flags.push('read');
            const label = c.uuid.length > 8 ? c.uuid.slice(4, 8).toUpperCase() : c.uuid;
            parts.push(`${label}(${flags.join('+') || '-'})`);
            if (p.notify || p.indicate) notifyList.push({ ch: c, label, svcLabel: svcShort });
            if (p.write || p.writeWithoutResponse) writeList.push({ ch: c, label, svcLabel: svcShort });
          }
          lines.push(`${svcShort}: ${parts.join(' ') || '(无特征)'}`);
        }
        log('服务清单 → ' + lines.join(' | '));
        log(`可通知: ${notifyList.map((x) => x.svcLabel + '/' + x.label).join(', ') || '无'}`);
        log(`可写: ${writeList.map((x) => x.svcLabel + '/' + x.label).join(', ') || '无'}`);
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
          const short = item.ch.uuid.length > 8 ? item.ch.uuid.slice(4, 8).toUpperCase() : item.ch.uuid;
          chLabels.set(ch, `${item.svcLabel}/${short}`);
          ch.addEventListener('characteristicvaluechanged', onNotify);
          notifyChs.push(ch);
          log(`已订阅 ${item.svcLabel}/${short} 通知`);
        } else {
          log(`订阅 ${item.svcLabel}/${item.label} 失败`);
        }
      }
      if (!notifyChs.length) throw new Error('所有通知特征订阅失败');

      // 兼容旧引用
      notifyCh = notifyChs[0];
      // 优先用 A2A3 作为写入特征，否则取第一个可写的
      const a2a3 = writeList.find((x) => x.label === 'A2A3');
      const w = a2a3 || writeList[0] || {};
      writeCh = w.ch || null;
      if (writeCh) chLabels.set(writeCh, `${w.svcLabel}/${w.label}`);
      log('写入特征: ' + (writeCh ? (chLabels.get(writeCh) || '未知') : '无'));

      /* ===== 文档 §2.4A：必须做的激活序列 =====
       * 1) 对 A2A3（写特征）也开通知并写 CCCD（op=4）
       * 2) 向 A2A3 写单字节 0xFF（op=5，日志 rockWrite:）
       * 不做这一步，闪控不会主动推送按键。
       */
      if (writeCh) {
        const a2a3Label = chLabels.get(writeCh) || 'A2A3';
        // 1) 尝试对 A2A3 开通知
        try {
          await writeCh.startNotifications();
          if (!notifyChs.includes(writeCh)) {
            writeCh.addEventListener('characteristicvaluechanged', onNotify);
            notifyChs.push(writeCh);
          }
          log(`A2A3 已开启通知（rockWrite 通道）`);
        } catch (e) {
          log(`A2A3 开通知失败（一般正常，继续写 0xFF）: ${e.name || e.message || e}`);
        }

        // 2) 写单字节 0xFF 激活闪控
        let wrote = false;
        try {
          await writeCh.writeValue(new Uint8Array([0xff]));
          wrote = true;
          log('↑ A2A3 写入 0xFF（激活闪控）');
        } catch (e) {
          try {
            await writeCh.writeValueWithoutResponse(new Uint8Array([0xff]));
            wrote = true;
            log('↑ A2A3 写入 0xFF（无响应模式）');
          } catch (e2) {
            log('写 0xFF 失败: ' + (e.name || e.message || e));
          }
        }
        if (wrote) {
          // 稍等，让设备切换状态
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      // 主动读一次（部分设备读后才推送）
      for (const ch of notifyChs) {
        if (!ch.properties.read) continue;
        try {
          const dv = await ch.readValue();
          const hex = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
            .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
          log(`主动读 ${chLabels.get(ch)}: ${hex}`);
        } catch (_) {}
      }

      // 显式读一次电池电量
      try {
        const battSvc = await server.getPrimaryService('0000180f-0000-1000-8000-00805f9b34fb');
        const battCh = await battSvc.getCharacteristic('00002a19-0000-1000-8000-00805f9b34fb');
        const dv = await battCh.readValue();
        const pct = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)[0];
        if (pct != null && pct <= 100) {
          state.battery = pct;
          emit('battery', pct);
          log(`闪控电量: ${pct}%`);
        }
      } catch (e) {
        log('读取电池失败: ' + (e.message || e));
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
      const label = chLabels.get(ch) || '未知特征';
      const v = ch.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      emit('raw', `[${label}] ${hex}`);
      log(`← ${label} ${bytes.length}B: ${hex}`);

      /* ---- 1) 标准电池服务 180F/2A19：单字节百分比 ---- */
      if (/2A19/i.test(ch.uuid)) {
        if (bytes.length >= 1 && bytes[0] <= 100) {
          state.battery = bytes[0];
          emit('battery', bytes[0]);
          log(`闪控电量: ${bytes[0]}%`);
        }
        return;
      }

      /* ---- 2) A2A4：BR80 直连的单字节按键协议（文档 §6.2A）---- */
      if (/A2A4/i.test(ch.uuid) && bytes.length === 1) {
        handleSingleByte(bytes[0]);
        return;
      }

      /* ---- 3) A2A3 通知：电量取末 2 字符（文档 §6.2B）---- */
      if (/A2A3/i.test(ch.uuid) && hex.length > 3) {
        const tail = hex.slice(-2);
        if (tail === '88') {
          log('闪控电量: 充足标志(88)');
          if (state.battery == null || state.battery < 100) {
            state.battery = 100;
            emit('battery', 100);
          }
        } else {
          const pct = parseInt(tail, 16);
          if (isFinite(pct) && pct >= 0 && pct <= 100) {
            state.battery = pct;
            emit('battery', pct);
            log(`闪控电量(末2位): ${pct}%`);
          }
        }
        return;
      }

      /* ---- 4) 兼容：55AA 帧线路（头盔/SPP 路径）---- */
      let b = (bufs[label] || '') + hex;
      if (b.length > 512) b = b.slice(-128);

      let guard = 0;
      while (guard++ < 20) {
        const idx = b.indexOf(FRAME_PREFIX);
        if (idx < 0) {
          if (b.length >= 4) log(`[${label}] 未识别数据: ${b}`);
          b = '';
          break;
        }
        if (idx > 0) b = b.slice(idx);
        if (b.length < 16) break;
        const frame = b.slice(0, 16);
        b = b.slice(16);
        decodeFrame(frame);
      }
      bufs[label] = b;
    }

    /** BR80 单字节按键：0x05~0x09 按下 / 0x25~0x29 抬起 */
    function handleSingleByte(byteVal) {
      const key = byteVal.toString(16).toUpperCase().padStart(2, '0');
      const downName = BYTE_DOWN[key];
      const upName = BYTE_UP[key];

      if (downName) {
        log(`按键按下 0x${key} → ${downName}`);
        emit('key', { key, name: downName, edge: 'down', byte: byteVal });
        return;
      }
      if (upName) {
        emit('release', { key, name: upName, edge: 'up', byte: byteVal });
        return;
      }
      log(`未知单字节 0x${key} (${byteVal})`);
      emit('unknownByte', { key, byte: byteVal });
    }

    /** 解析 16 字符按键帧并派发事件 */
    function decodeFrame(frame) {
      // 形如 55AA0AA2A0000107（按下）或 55AA0AA2A0000127（抬起）
      if (!frame.startsWith(FRAME_PREFIX)) {
        log('非按键帧: ' + frame);
        return;
      }
      const key = frame.substr(14, 2);
      const downName = KEY_DOWN[key];
      const upName = KEY_UP[key];

      if (downName) {
        log(`按键按下: ${downName} (码 ${key})`);
        emit('key', { key, name: downName, edge: 'down', frame });
        return;
      }
      if (upName) {
        emit('release', { key, name: upName, edge: 'up', frame });
        return;
      }
      // 未识别的按键码：完整帧 + 码值都发出去，便于实测确认
      log(`未知按键码 ${key}，完整帧 ${frame}`);
      emit('unknownKey', { key, frame });
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

    /** 诊断：手动写入任意十六进制帧到 A2A3 */
    async function sendRaw(hex) {
      if (!writeCh) {
        log('写入特征不可用');
        return;
      }
      const clean = (hex || '').toUpperCase().replace(/[^0-9A-F]/g, '');
      if (!clean) {
        log('输入为空');
        return;
      }
      try {
        await writeCh.writeValue(hexToBytes(clean));
        log(`↑ 手动写入 ${clean.length / 2}B: ${clean}`);
      } catch (e) {
        try {
          await writeCh.writeValueWithoutResponse(hexToBytes(clean));
          log(`↑ 手动写入(无响应) ${clean.length / 2}B: ${clean}`);
        } catch (e2) {
          log('写入失败: ' + (e.message || e));
        }
      }
    }

    /** 诊断：强制用指定特征重新订阅 A2A4（含指示 indicate 模式） */
    async function forceNotify() {
      if (!notifyChs.length) {
        log('没有可用的通知特征');
        return;
      }
      for (const ch of notifyChs) {
        const label = chLabels.get(ch) || '未知';
        try { ch.removeEventListener('characteristicvaluechanged', onNotify); } catch (_) {}
        try { await ch.stopNotifications(); } catch (_) {}
        delete bufs[label];
        // 只对带 notify/indicate 的重新订阅
        try {
          await ch.startNotifications();
          ch.addEventListener('characteristicvaluechanged', onNotify);
          log(`强制重订 ${label} 成功`);
        } catch (e) {
          // 手动写 CCCD：优先试 indicate(02 00)，再试 notify(01 00)
          let done = false;
          for (const v of [[2, 0], [1, 0]]) {
            try {
              const descs = await ch.getDescriptors();
              const cccd = descs.find((d) => d.uuid.startsWith('00002902'));
              if (cccd) {
                await cccd.writeValue(new Uint8Array(v));
                ch.addEventListener('characteristicvaluechanged', onNotify);
                log(`强制重订 ${label} 写CCCD成功 [${v.join(',')}]`);
                done = true;
                break;
              }
            } catch (_) {}
          }
          if (!done) log(`强制重订 ${label} 失败: ${e.name || e.message || e}`);
        }
      }
      log('强制重订完成，按一下闪控按键试试');
    }

    /** 诊断：深入检查 A2A4 的 descriptor 与订阅状态 */
    async function inspectA2A4() {
      if (!device || !device.gatt || !device.gatt.connected) {
        log('设备未连接');
        return;
      }
      try {
        const server = await device.gatt.connect();
        const svc = await server.getPrimaryService(UUID.svc);
        const ch = await svc.getCharacteristic(UUID.noti);
        const p = ch.properties || {};
        log(`A2A4 属性: notify=${p.notify} indicate=${p.indicate} write=${p.write} writeNR=${p.writeWithoutResponse} read=${p.read}`);
        const descs = await ch.getDescriptors().catch(() => []);
        if (!descs.length) {
          log('A2A4 没有 descriptor（CCCD 缺失 → 无法订阅！）');
        } else {
          for (const d of descs) {
            let val = '?';
            if (d.uuid.startsWith('00002902')) {
              try {
                const dv = await d.readValue();
                val = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
                  .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
              } catch (e) {
                val = '(读失败)';
              }
            }
            log(`  descriptor ${d.uuid.slice(4, 8)} = ${val}`);
          }
        }
        // 尝试 indicate 模式订阅
        try {
          await ch.startNotifications();
          log('A2A4 startNotifications 成功');
        } catch (e) {
          log('A2A4 startNotifications 失败: ' + (e.name || e.message));
        }
        // 验证 CCCD 当前值
        try {
          const descs2 = await ch.getDescriptors();
          const cccd = descs2.find((d) => d.uuid.startsWith('00002902'));
          if (cccd) {
            const dv = await cccd.readValue();
            const v = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
              .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
            log(`订阅后 CCCD 值 = ${v} （01 00=notify, 02 00=indicate, 00 00=关闭）`);
          }
        } catch (_) {}
        log('A2A4 检查完成');
      } catch (e) {
        log('检查 A2A4 失败: ' + (e.message || e));
      }
    }

    /** 诊断：把设备所有特征读一遍，打印值与属性 */
    async function dumpAll() {
      if (!device || !device.gatt || !device.gatt.connected) {
        log('设备未连接');
        return;
      }
      try {
        const server = await device.gatt.connect();
        const all = await server.getPrimaryServices();
        for (const s of all) {
          const svcShort = s.uuid.length > 8 ? s.uuid.slice(4, 8).toUpperCase() : s.uuid;
          const chars = await s.getCharacteristics().catch(() => []);
          for (const c of chars) {
            const p = c.properties || {};
            const flags = [
              p.notify ? 'N' : '', p.indicate ? 'I' : '',
              p.write ? 'W' : '', p.writeWithoutResponse ? 'w' : '',
              p.read ? 'R' : '',
            ].join('') || '-';
            let val = '(不可读)';
            if (p.read) {
              try {
                const dv = await c.readValue();
                val = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
                  .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('') || '(空)';
              } catch (e) {
                val = '(读失败:' + (e.name || e) + ')';
              }
            }
            const short = c.uuid.length > 8 ? c.uuid.slice(4, 8).toUpperCase() : c.uuid;
            log(`${svcShort}/${short} [${flags}] ${val}`);
          }
        }
        log('全量读取完成');
      } catch (e) {
        log('全量读取失败: ' + (e.message || e));
      }
    }

    /** 诊断：重新执行激活序列（写 0xFF + 对 A2A3 开通知） */
    async function ping() {
      if (!writeCh) {
        log('写入特征不可用');
        return;
      }
      log('=== 重新执行激活序列 ===');
      // 1) A2A3 开通知
      try {
        await writeCh.startNotifications();
        if (!notifyChs.includes(writeCh)) {
          writeCh.addEventListener('characteristicvaluechanged', onNotify);
          notifyChs.push(writeCh);
        }
        log('A2A3 通知已开启');
      } catch (e) {
        log('A2A3 开通知失败: ' + (e.name || e.message || e));
      }
      // 2) 写 0xFF
      const seq = [
        ['0xFF（rockWrite 激活）', [0xff]],
        ['0xFF 再次', [0xff]],
      ];
      for (const [desc, arr] of seq) {
        try {
          await writeCh.writeValue(new Uint8Array(arr));
          log(`↑ A2A3 写入 ${desc}`);
        } catch (e) {
          try {
            await writeCh.writeValueWithoutResponse(new Uint8Array(arr));
            log(`↑ A2A3 写入 ${desc}（无响应）`);
          } catch (e2) {
            log(`写入 ${desc} 失败: ${e.name || e.message || e}`);
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      log('激活完成，请依次按 ▲ ▼ ◀ ▶ ● 键');
    }

    /** 诊断：重新订阅所有通知特征 */
    async function resubscribe() {
      if (!notifyChs.length) {
        log('没有已订阅的特征');
        return;
      }
      for (const ch of notifyChs) {
        const label = chLabels.get(ch) || '未知';
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

    return { state, on, connect, disconnect, ping, resubscribe, dumpAll, sendRaw, forceNotify, inspectA2A4, supported, UUID, KEY_DOWN, hexToBytes };
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.remote = { createRemote, UUID, KEY_DOWN };
})(typeof globalThis !== 'undefined' ? globalThis : this);