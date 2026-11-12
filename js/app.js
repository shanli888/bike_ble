/* =========================================================================
 * app.js — 应用核心：状态、持久化、命令下发、模拟数据
 *
 * 对外 API（View 只读它，不直接碰 BLE）：
 *   App.state                    当前状态快照
 *   App.on(evt, fn)              订阅：change / log / toast / frame / page
 *   App.go(page)                 切页
 *   App.scan()                   打开系统设备选择器（需用户手势）
 *   App.reconnect() / App.disconnect()
 *   App.send(command)            经 adapter 编码后下发
 *   App.setDraft(key, value)     助力面板的“待确认”草稿
 *   App.confirmParked()          停车确认，下发已修改项
 *   App.updatePrefs(patch) / App.resetPrefs()
 * ========================================================================= */
(function (root) {
  'use strict';
  const { util, adapter, config } = root.LVBU;

  const MAX_LOG = 400;

  /* ---------------- 骑行统计（本地累加） ---------------- */
  // 统计规则：
  //   - 每次收到速度（BF 回复）记为一次采样
  //   - 里程：速度 × 采样间隔，累加（km）
  //   - 平均速度：总里程 / 有速度的累计时长（停车不计入，避免拉低均值）
  //   - 最高速度：所有采样的最大值
  const ride = {
    lastSampleAt: 0,   // 上次采样时间（ms）
    movingMs: 0,       // 有速度的累计时长（ms）
    distanceKm: 0,     // 累计里程（km）
    maxSpeed: 0,       // 最高速度
  };

  const state = {
    page: 'dash',
    prefs: config.loadPrefs(),
    transport: null,
    conn: { status: 'idle', device: null, error: null, rssi: null, chars: null, kind: null },
    remote: { status: 'idle', device: null, error: null },
    bike: {
      speed: 0, avgSpeed: 0, maxSpeed: 0, trip: 0, odo: 0,
      battery: null, voltage: null, assistLevel: 0, assistPower: null,
      motorPower: null, gyro: null, gyroRaw: null, cadence: null,
      controllerTemp: null, motorTemp: null,
    },
    mode: 'manual',
    confirmed: { mode: 'manual', value: 0 },
    draft: { mode: 'manual', value: 0, dirty: false },
    parkedConfirmed: false,
    logs: [],
    lastFrame: null,
    lastRxAt: 0,
    now: Date.now(),
    rideStartAt: Date.now(),
    autoReconnectTried: false,
  };

  const listeners = {};
  let saveTimer = null;
  let tickTimer = null;
  let pollTimer = null;
  let pollBusy = false;

  /* ---------------- 事件 ---------------- */
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
        console.error('[app] listener ' + evt + ' failed', e);
      }
    });
  }
  function changed() {
    emit('change', state);
  }
  function log(direction, text, extra) {
    const entry = { t: Date.now(), direction, text, ...(extra || {}) };
    state.logs.push(entry);
    if (state.logs.length > MAX_LOG) state.logs.splice(0, state.logs.length - MAX_LOG);
    emit('log', entry);
  }
  function toast(text, level) {
    // 确保 text 是字符串，避免 [object Object]
    const safeText = typeof text === 'string' ? text : JSON.stringify(text);
    emit('toast', { text: safeText, level: level || 'info' });
  }

  /* ---------------- 首选项 ---------------- */
  function savePrefsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => config.savePrefs(state.prefs), 250);
  }
  function updatePrefs(patch) {
    state.prefs = util.deepMerge(state.prefs, patch);
    config.savePrefs(state.prefs);
    changed();
  }
  function resetPrefs() {
    state.prefs = config.resetPrefs();
    changed();
    toast('已恢复默认设置');
  }

  /* ---------------- 单位换算 ---------------- */
  const KMH_TO_MPH = 0.621371;
  function unitFactor() {
    return state.prefs.unit === 'mph' ? KMH_TO_MPH : 1;
  }
  function speedLabel() {
    return state.prefs.unit === 'mph' ? 'mph' : 'km/h';
  }
  /** 内部统一用 km/h 存储，显示时换算 */
  function displaySpeed(v) {
    return v == null ? null : v * unitFactor();
  }

  /* ---------------- 传输层接入 ---------------- */
  function attachTransport(t) {
    state.transport = t;
    state.conn.kind = t.kind;
    t.on('state', (s) => {
      state.conn.status = s.status;
      state.conn.device = s.device;
      state.conn.error = s.error;
      if (s.status === 'ready') {
        state.conn.chars = s.chars;
        state.rideStartAt = Date.now();
        // 新一次连接：重置骑行统计，避免跨行程累加
        ride.lastSampleAt = 0;
        ride.movingMs = 0;
        ride.distanceKm = 0;
        ride.maxSpeed = 0;
        state.bike.avgSpeed = 0;
        state.bike.maxSpeed = 0;
        state.bike.trip = 0;
        onConnected();
        startPolling();
      }
      if (s.status === 'disconnected') {
        state.conn.chars = null;
        state.conn.rssi = null;
        ride.lastSampleAt = 0; // 断开后重置采样基准，重连后重新计时
        stopPolling();
      }
      changed();
    });
    t.on('log', (e) => log(e.direction || 'info', e.text));
    t.on('frame', (f) => {
      state.lastFrame = f;
      state.lastRxAt = Date.now();
    });
    t.on('drop', (d) => emit('drop', d));
    t.on('update', (u) => {
      applyBikeUpdate(u);
      // 设备回读的档位/模式视为“已确认”
      if (u.mode && !state.draft.dirty) {
        state.confirmed.mode = u.mode;
        state.mode = u.mode;
      }
      if (u.assistPercent != null && !state.draft.dirty) {
        state.confirmed.value = u.assistPercent;
      }
      changed();
    });
    t.on('rssi', (rssi) => {
      state.conn.rssi = rssi;
      changed();
    });
    t.on('device', (d) => {
      state.conn.device = d;
      updatePrefs({ autoConnect: { id: d.id, name: d.name } });
    });
    changed();
  }

  function applyBikeUpdate(u) {
    const b = state.bike;
    // 速度交给本地统计模块处理（计算里程/平均/最高）
    if (u.speed != null) markSpeedSample(u.speed);

    for (const k of Object.keys(u)) {
      if (!(k in b) && k !== 'mode') continue;
      // 这三个由本地统计产生，不接受设备直接覆盖
      if (k === 'speed' || k === 'avgSpeed' || k === 'maxSpeed' || k === 'trip') continue;
      b[k] = u[k];
    }
  }

  async function onConnected() {
    state.autoReconnectTried = false;
    toast('已连接 ' + ((state.conn.device && state.conn.device.name) || '设备'));
    // 初始化查询序列
    for (const step of adapter.initSequence(state.prefs)) {
      await util.sleep(step.delay);
      try {
        await send(step.command);
      } catch (_) {
        /* 单条失败不影响其它 */
      }
    }
    // 初始化“已确认状态”为本机当前值（协议未回读前）
    state.confirmed.value = state.draft.value = state.bike.assistLevel || 0;
  }

  /* ---------------- 定时轮询（电量/温度/速度/陀螺仪） ---------------- */
  const POLL_INTERVAL = 3000; // 每 3 秒轮询一轮

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(runPoll, POLL_INTERVAL);
    // 连接后立即先跑一轮（onConnected 已查过一次，这里作为后续持续刷新）
    runPoll();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function runPoll() {
    if (pollBusy) return;
    if (state.conn.status !== 'ready') return;
    pollBusy = true;
    try {
      for (const cmd of adapter.pollSequence(state.prefs)) {
        try {
          await send(cmd, { silent: true });
          await util.sleep(120); // 命令间留间隔，避免抢占
        } catch (_) {
          /* 单条失败继续下一条 */
        }
      }
    } finally {
      pollBusy = false;
    }
  }

  /* ---------------- 连接操作 ---------------- */
  async function scan(opts) {
    if (!state.transport) throw new Error('传输层未初始化');
    try {
      await state.transport.connect(opts || {});
    } catch (err) {
      if (err && err.name !== 'NotFoundError') toast('连接失败：' + (err.message || err), 'error');
      throw err;
    }
  }

  /** 自动连接固定设备（通过 device ID） */
  async function autoConnect(deviceId) {
    if (!state.transport) throw new Error('传输层未初始化');
    try {
      await state.transport.connect({ deviceId });
    } catch (err) {
      if (err && err.name !== 'NotFoundError') toast('连接失败：' + (err.message || err), 'error');
      throw err;
    }
  }

  async function reconnect() {
    if (!state.transport) return;
    try {
      await state.transport.reconnect();
    } catch (err) {
      toast('重连失败：' + (err.message || err), 'error');
    }
  }

  function disconnect() {
    if (state.transport) state.transport.disconnect();
  }

  /* ---------------- 命令下发 ---------------- */
  async function send(command, opts = {}) {
    const { frames, meta } = adapter.encode(command, state.prefs);
    let ok = 0;
    for (const frame of frames) {
      // frame is Uint8Array (text protocol ASCII bytes)
      const hex = util.bytesToHex(frame);
      log('tx', `${meta.name || command.kind}  ${hex}`, { cmd: meta.cmd, bytes: hex });
      try {
        if (meta.ctrl && state.transport.writeCtrl) {
          await state.transport.writeCtrl(frame);
        } else {
          await state.transport.write(frame);
        }
        ok++;
      } catch (err) {
        if (!opts.silent) toast('发送失败：' + (err.message || err), 'error');
        throw err;
      }
    }
    return { sent: ok, meta };
  }

  /** 原始帧发送（调试页用） */
  async function sendRaw(text) {
    return send({ kind: 'raw', text }, { silent: true });
  }

  /* ---------------- 助力控制（需停车确认） ---------------- */
  function setDraft(patch) {
    Object.assign(state.draft, patch);
    state.draft.dirty =
      state.draft.mode !== state.confirmed.mode || state.draft.value !== state.confirmed.value;
    // 手动档滑杆的实时显示
    if (state.draft.mode === 'manual' && patch.percent != null) {
      state.bike.assistLevel = patch.percent; // reuse for display
    }
    changed();
  }

  function parkedNow() {
    return (state.bike.speed || 0) < 0.5;
  }

  async function confirmParked() {
    if (!state.transport || state.transport.state.status !== 'ready') {
      toast('请先连接设备', 'error');
      return false;
    }
    if (!parkedNow()) {
      state.parkedConfirmed = false;
      changed();
      toast('请先停车（速度 < 0.5 ' + speedLabel() + '）再确认', 'error');
      return false;
    }
    state.parkedConfirmed = true;
    changed();
    const target = { mode: state.draft.mode, value: state.draft.value };
    try {
      // 模式变化时发送模式命令
      if (target.mode !== state.confirmed.mode) {
        await send({ kind: 'mode', mode: target.mode });
      }
      // 根据模式类型发送不同命令
      if (target.mode === 'manual') {
        await send({ kind: 'percent', percent: target.value });
      } else {
        await send({ kind: 'level', level: target.value });
      }
      state.confirmed = { ...target };
      state.mode = target.mode;
      state.draft.dirty = false;
      toast('参数已下发：' + modeLabel(target.mode) + ' · ' + target.value, 'success');
      changed();
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 仅下发手动助力百分比（随时可用，不要求停车），范围 0~99 */
  async function applyAssist() {
    if (!state.transport || state.transport.state.status !== 'ready') {
      toast('请先连接设备', 'error');
      return false;
    }
    const value = Math.min(99, Math.max(0, Math.round(state.draft.value || 0)));
    try {
      await send({ kind: 'percent', percent: value });
      state.draft.value = value;
      state.confirmed.value = value;
      state.mode = state.draft.mode;
      state.draft.dirty = false;
      toast('助力已调整：' + value + '%', 'success');
      changed();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function stopAssist() {
    try {
      await send({ kind: 'stop' });
      state.confirmed.value = 0;
      state.draft.value = 0;
      state.bike.assistLevel = 0;
      state.draft.dirty = false;
      toast('已发送停止助力', 'success');
      changed();
    } catch (_) {}
  }

  function levelForMode(mode, value) {
    const def = config.RIDE_MODES.find((m) => m.key === mode);
    if (def && def.assist != null && value == null) return def.assist;
    return value;
  }

  function modeLabel(key) {
    const m = config.RIDE_MODES.find((x) => x.key === key);
    return m ? m.label : key;
  }

  /* ---------------- 页面 ---------------- */
  function go(page) {
    if (state.page === page) return;
    state.page = page;
    emit('page', page);
    changed();
  }

  /* ---------------- BR80 闪控接入 ---------------- */
  let remoteCtl = null;

  /** 接入闪控控制器（由 ui.js 在 boot 时调用） */
  function attachRemote(rm) {
    remoteCtl = rm;
    rm.on('state', (s) => {
      state.remote = { status: s.status, device: s.device, error: s.error };
      changed();
    });
    rm.on('device', (d) => {
      state.remote.device = d;
      changed();
    });
    rm.on('log', (text) => log('info', '[闪控] ' + text));
    rm.on('raw', (hex) => log('rx', '[闪控] ' + hex));
    rm.on('key', ({ name }) => onRemoteKey(name));
    changed();
  }

  /* 闪控按键状态 */
  const remoteCtlState = {
    frozenUntil: 0,     // 冻结截止时间戳（ms），期间忽略按键
    stopped: false,     // 是否处于「停止助力」状态
    savedPower: null,   // 停止前记录的助力百分比，用于恢复
  };
  const REMOTE_FREEZE_MS = 5000; // 按键后冻结 5 秒

  function remoteFrozen() {
    return Date.now() < remoteCtlState.frozenUntil;
  }

  /** 闪控按键 → 调整助力 / 停止 / 恢复 */
  async function onRemoteKey(name) {
    if (state.conn.status !== 'ready') {
      toast('请先连接助力控制器', 'error');
      return;
    }

    // 冻结期内忽略（防止误触连发）
    if (remoteFrozen()) {
      const left = Math.ceil((remoteCtlState.frozenUntil - Date.now()) / 1000);
      toast(`操作已冻结，请 ${left} 秒后再按`);
      return;
    }

    // ---- 停止键：停止助力 ----
    if (name === 'home') {
      const cur = state.draft.value || 0;
      if (cur <= 0 && remoteCtlState.stopped) {
        return; // 已经是停止状态
      }
      // 记录当前助力值用于恢复
      remoteCtlState.savedPower = cur;
      remoteCtlState.stopped = true;
      state.draft.value = 0;
      state.draft.mode = 'manual';
      state.draft.dirty = true;
      changed();
      const ok = await applyAssist();
      if (ok) {
        remoteCtlState.frozenUntil = Date.now() + REMOTE_FREEZE_MS;
        toast(`已停止助力（原 ${cur}%，按 ▲/▼ 恢复）`, 'success');
      }
      return;
    }

    // ---- 上/下键 ----
    if (name !== 'up' && name !== 'down') return;

    // 停止状态下按上下键：恢复原有助力
    if (remoteCtlState.stopped) {
      const saved = remoteCtlState.savedPower;
      remoteCtlState.stopped = false;
      remoteCtlState.savedPower = null;
      if (saved != null && saved > 0) {
        state.draft.value = saved;
        state.draft.mode = 'manual';
        state.draft.dirty = true;
        changed();
        const ok = await applyAssist();
        if (ok) {
          remoteCtlState.frozenUntil = Date.now() + REMOTE_FREEZE_MS;
          toast(`已恢复助力 ${saved}%`, 'success');
        }
      } else {
        // 没有记录值，按正常步进处理
        const step = state.prefs.sliderStep || 5;
        const next = name === 'up' ? step : 0;
        state.draft.value = next;
        changed();
        const ok = await applyAssist();
        if (ok) remoteCtlState.frozenUntil = Date.now() + REMOTE_FREEZE_MS;
      }
      return;
    }

    // ---- 正常调整 ----
    const step = state.prefs.sliderStep || 5;
    const cur = state.draft.value || 0;
    const next = Math.max(0, Math.min(99, cur + (name === 'up' ? step : -step)));
    if (next === cur) {
      toast(next >= 99 ? '已到最大助力 99%' : '已到最小助力 0%');
      return;
    }
    state.draft.value = next;
    state.draft.mode = 'manual';
    state.draft.dirty = true;
    changed();
    const ok = await applyAssist();
    if (ok) {
      remoteCtlState.frozenUntil = Date.now() + REMOTE_FREEZE_MS;
      toast(`助力 ${next}%（${Math.ceil(REMOTE_FREEZE_MS / 1000)} 秒内不再响应）`, 'success');
    }
  }

  async function connectRemote() {
    if (!remoteCtl) throw new Error('闪控模块未加载');
    await remoteCtl.connect();
  }

  function disconnectRemote() {
    if (remoteCtl) remoteCtl.disconnect();
  }

  /** 收到一次速度采样（来自设备 BF 回复） */
  function markSpeedSample(speed) {
    const b = state.bike;
    const now = Date.now();
    const v = Number(speed);
    if (!isFinite(v) || v < 0) return;

    const prev = ride.lastSampleAt;
    b.speed = v;

    if (prev) {
      let dt = (now - prev) / 1000; // 秒
      // 间隔过长（>10s，如断线/切后台）视为无效时间段，不计入
      if (dt > 0 && dt <= 10) {
        ride.distanceKm += (v * dt) / 3600; // km/h × s ÷ 3600
        if (v > 0.5) ride.movingMs += dt * 1000;
      }
    }
    ride.lastSampleAt = now;

    if (v > ride.maxSpeed) ride.maxSpeed = v;

    // 平均速度 = 距离 / 移动时间
    const hours = ride.movingMs / 3600000;
    b.avgSpeed = hours > 0.0001 ? ride.distanceKm / hours : 0;
    b.maxSpeed = ride.maxSpeed;
    b.trip = ride.distanceKm;

    changed();
  }

  /** 重置本次骑行统计（用户主动清零） */
  function resetRide() {
    ride.lastSampleAt = 0;
    ride.movingMs = 0;
    ride.distanceKm = 0;
    ride.maxSpeed = 0;
    state.bike.avgSpeed = 0;
    state.bike.maxSpeed = 0;
    state.bike.trip = 0;
    changed();
    toast('骑行数据已清零');
  }

  /* ---------------- 定时刷新（超时提示） ---------------- */
  function startClock() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      state.now = Date.now();
      emit('tick', state);
      // 连接但 10s 无数据：提示（不报警）
      if (state.conn.status === 'ready' && state.lastRxAt && state.now - state.lastRxAt > 10000) {
        emit('stale', state.now - state.lastRxAt);
      }
    }, 250);
  }

  /* ---------------- 轮径设置 ---------------- */
  async function setWheel(inch) {
    updatePrefs({ wheelInch: inch });
    try {
      await send({ kind: 'wheel', inch, diameterMm: config.wheelCircumferenceMm(inch) });
      toast(`轮径已下发：${inch}"`, 'success');
    } catch (_) {}
  }

  async function calibrateGyro() {
    try {
      await send({ kind: 'calibrate' });
      toast('已发送陀螺仪校准命令', 'success');
    } catch (_) {}
  }

  async function restartDevice() {
    try {
      await send({ kind: 'restart' });
      toast('已发送重启命令', 'success');
    } catch (_) {}
  }

  function clearLogs() {
    state.logs = [];
    changed();
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.app = {
    state,
    on,
    go,
    scan,
    autoConnect,
    reconnect,
    disconnect,
    send,
    sendRaw,
    setDraft,
    confirmParked,
    applyAssist,
    stopAssist,
    parkedNow,
    setWheel,
    calibrateGyro,
    restartDevice,
    updatePrefs,
    resetPrefs,
    clearLogs,
    applyBikeUpdate,
    markSpeedSample,
    resetRide,
    attachRemote,
    connectRemote,
    disconnectRemote,
    /** 闪控状态（供 UI 显示冻结/停止） */
    getRemoteState() {
      return {
        frozenMs: Math.max(0, remoteCtlState.frozenUntil - Date.now()),
        stopped: remoteCtlState.stopped,
        savedPower: remoteCtlState.savedPower,
      };
    },
    displaySpeed,
    speedLabel,
    modeLabel,
    attachTransport,
    startClock,
    _internal: { savePrefsSoon, emit, changed, log, toast },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);