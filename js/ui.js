/* =========================================================================
 * ui.js — 视图层：渲染 + 交互（码表 / 设备 / 设置）
 *
 * 原则：
 *   - 驱动真实用户输入的控件（滑杆）由用户手势独占，不在 tick 中重设 value
 *   - 所有渲染函数都是幂等的，状态变化时整体刷新
 *   - “停车确认”是硬门槛：速度 ≥ 0.5 时禁止确认，模式按钮只改草稿
 * ========================================================================= */
(function (root) {
  'use strict';
  const { app, util, icons, config, adapter, ble } = root.LVBU;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const els = {};
  let pendingPreviewFrame = null;
  let toastTimer = null;
  let stickDemo = null;

  /* ======================= 启动 ======================= */
  function boot() {
    cacheEls();
    paintIcons();
    buildModeRow();
    // 事件绑定容错：任一元素缺失不应阻断后续绑定（导航等核心功能优先）
    try {
      bindEvents();
    } catch (err) {
      console.error('[boot] bindEvents 失败：', err);
    }
    try {
      bindAppEvents();
    } catch (err) {
      console.error('[boot] bindAppEvents 失败：', err);
    }
    try {
      syncSettingsInputs();
    } catch (err) {
      console.error('[boot] syncSettingsInputs 失败：', err);
    }

    // 传输层：Web Bluetooth（助力控制器）
    app.attachTransport(ble.createTransport(app.state.prefs));
    if (!(ble.supported && ble.supported()) && !app.state.transport.supported()) {
      app._internal.log('warn', '当前浏览器不支持 Web Bluetooth。iOS 请使用 Bluefy 打开。');
    }

    // BR80 闪控（独立蓝牙设备，可与控制器同时连接）
    if (root.LVBU.remote) {
      app.attachRemote(root.LVBU.remote.createRemote());
    }

    // 演示数据：开关开启且未连接时，启动循环演示（电量/温度/速度等自动变化）
    if (root.LVBU.sim) {
      const syncDemo = () => {
        const on = app.state.prefs.simulateWhenDisconnected && app.state.conn.status !== 'ready';
        if (on && !root.LVBU.sim.running) {
          root.LVBU.sim.start(); // 启动动态循环演示
        } else if (!on && root.LVBU.sim.running) {
          root.LVBU.sim.stop(); // 已连接或关闭开关 → 停止演示
        }
      };
      syncDemo();
      stickDemo = setInterval(syncDemo, 1000);
    }

    wireSlider();
    renderAll();
    app.startClock();

    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.lock) {
      /* 保持竖屏由 manifest/系统控制；此处不强制，避免 iOS 抛错 */
    }
  }

  function cacheEls() {
    els.connBadge = $('#connBadge');
    els.connBadgeText = $('#connBadgeText');
    els.rssiText = $('#rssiText');
    els.signalBars = $('#signalBars');
    // 主速度：整数位 / 小数位分离（七段数码管）
    els.speedInt = $('#speedInt');
    els.speedFrac = $('#speedFrac');
    els.speedUnit = $('#speedUnit');
    // 副表：整数 / 小数分离
    els.statAvgInt = $('#statAvgInt');
    els.statAvgFrac = $('#statAvgFrac');
    els.statMaxInt = $('#statMaxInt');
    els.statMaxFrac = $('#statMaxFrac');
    els.statTripInt = $('#statTripInt');
    els.statTripFrac = $('#statTripFrac');
    els.panel = $('#assistPanel');
    
    els.note = $('#assistNote');
    
    els.modeRow = $('#modeRow');
    els.slider = $('#assistSlider');
    els.assistValue = $('#assistValue');
    els.btnMinus = $('#btnMinus');
    els.btnPlus = $('#btnPlus');
    els.toast = $('#toast');
    els.btnPower = $('#btnPower');
    els.headDevName = $('#devName');
    els.remoteChip = $('#remoteChip');
    
    els.remoteName = $('#remoteName');
    els.remoteStatus = $('#remoteStatus');
    els.btnRemoteConnect = $('#btnRemoteConnect');
    els.btnRemoteDisconnect = $('#btnRemoteDisconnect');
    els.devName = $('#devNameCard');
    els.devStatus = $('#devStatus');
    els.devId = $('#devId');
    els.devRssi = $('#devRssi');
    els.devWrite = $('#devWrite');
    els.devNotify = $('#devNotify');
    els.btnReconnect = $('#btnReconnect');
    els.btnDisconnect = $('#btnDisconnect');
    els.logView = $('#logView');
    els.rawInput = $('#rawInput');
    els.rawPreview = $('#rawPreview');
  }

  function paintIcons() {
    $$('[data-icon]').forEach((el) => {
      el.innerHTML = icons.svg(el.dataset.icon, { size: Number(el.dataset.size) || 18 });
    });
  }

  /* ======================= 模式行 ======================= */
  function buildModeRow() {
    els.modeRow.innerHTML = config.RIDE_MODES.map(
      (m) => `<button class="mode" type="button" data-mode="${m.key}" role="radio" aria-checked="false">
        <span class="i" data-icon="${m.icon}" data-size="17"></span><span>${m.label}</span>
      </button>`
    ).join('');
    paintIcons($('#modeRow'));
  }

  function buildWheelOptions() {
    // 已移除：轮径固定 26 寸，不再需要动态选项
  }

  /* ======================= 事件绑定 ======================= */
  function bindEvents() {
    // 底部导航最先绑定：即使后续元素缺失也不影响页面切换
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => app.go(tab.dataset.tab));
    });

    // 顶栏设备名：点击跳转到设备页（替代旧的 brandBtn）
    const headNameEl = $('#devName');
    if (headNameEl) {
      headNameEl.addEventListener('click', () => app.go('device'));
      headNameEl.style.cursor = 'pointer';
    }

    els.btnPower.addEventListener('click', () => {
      const st = app.state.conn.status;
      if (st === 'ready' || st === 'connecting' || st === 'discovering') app.disconnect();
      else app.go('device');
    });

    // 助力：点击模式按钮立即下发
    els.modeRow.addEventListener('click', async (e) => {
      const btn = e.target.closest('.mode');
      if (!btn) return;
      if (!requireConnected()) {
        toast('请先连接设备', 'error');
        return;
      }
      const key = btn.dataset.mode;
      const def = config.RIDE_MODES.find((m) => m.key === key);
      const draft = { mode: key };
      if (def && def.assist != null) draft.value = def.assist;
      app.setDraft(draft);
      await app.applyAssistMode();
    });

    // 档位按钮（非手动模式）立即下发
    $('#levelRow').addEventListener('click', async (e) => {
      const btn = e.target.closest('.level-btn');
      if (!btn) return;
      if (!requireConnected()) {
        toast('请先连接设备', 'error');
        return;
      }
      app.setDraft({ value: Number(btn.dataset.level) });
      await app.applyAssistMode();
    });

    els.btnMinus.addEventListener('click', () => nudge(-1));
    els.btnPlus.addEventListener('click', () => nudge(+1));

    // 设备页
    const doScan = async () => {
      // 打开系统设备选择器（Web Bluetooth 必须由用户手势触发）
      try {
        await app.scan();
      } catch (err) {
        toast('连接失败：' + (err.message || err), 'error');
      }
    };
    $('#btnScan').addEventListener('click', doScan);
    // 首页未连接引导按钮：与「选择设备」功能一致
    $('#btnGuideConnect').addEventListener('click', doScan);
    $('#btnReconnect').addEventListener('click', () => app.reconnect());
    $('#btnDisconnect').addEventListener('click', () => app.disconnect());
    // 闪控
    $('#btnRemoteConnect').addEventListener('click', async () => {
      try {
        await app.connectRemote();
      } catch (err) {
        toast('闪控连接失败：' + (err.message || err), 'error');
      }
    });
    $('#btnRemoteDisconnect').addEventListener('click', () => app.disconnectRemote());
    $('#btnRemotePing').addEventListener('click', () => app.remotePing());
    $('#btnRemoteResub').addEventListener('click', () => app.remoteResubscribe());
    $('#btnRemoteDump').addEventListener('click', () => app.remoteDump());
    $('#btnRemoteForce').addEventListener('click', () => app.remoteForceNotify());
    $('#btnRemoteInspect').addEventListener('click', () => app.remoteInspect());
    $('#btnRemoteSendRaw').addEventListener('click', () => {
      const inp = $('#remoteRawInput');
      if (inp) app.remoteSendRaw(inp.value);
    });
    $('#btnClearLog').addEventListener('click', () => {
      app.clearLogs();
      renderLog(true);
    });
    $('#btnSendRaw').addEventListener('click', onSendRaw);
    els.rawInput.addEventListener('input', renderRawPreview);

    // 设置页
    $('#setStep').addEventListener('change', (e) => {
      app.updatePrefs({ sliderStep: Number(e.target.value) });
      applySliderStep();
    });
    $('#setGap').addEventListener('change', (e) => app.updatePrefs({ frameGapMs: Number(e.target.value) }));
    $('#setKeepScreen').addEventListener('change', (e) => app.updatePrefs({ keepScreenOn: e.target.checked }));
    $('#setDemo').addEventListener('change', (e) => app.updatePrefs({ simulateWhenDisconnected: e.target.checked }));
    $('#setImei').addEventListener('change', (e) => app.updatePrefs({ imei: e.target.value.trim() }));
    $('#btnCalibrate').addEventListener('click', () => {
      if (!requireParked('陀螺仪校准')) return;
      app.calibrateGyro();
    });
    $('#btnResetRide').addEventListener('click', () => {
      if (!confirm('确定清零平均速度、最高速度和里程？')) return;
      app.resetRide();
    });
    $('#btnRestart').addEventListener('click', async () => {
      if (app.state.conn.status !== 'ready') {
        toast('请先连接设备', 'error');
        return;
      }
      if (!confirm('确定重启控制器？重启期间会短暂断开连接。')) return;
      await app.restartDevice();
    });

    $('#setService').addEventListener('change', (e) =>
      app.updatePrefs({ connection: { serviceUuid: e.target.value.trim() } })
    );
    $('#setWriteUuid').addEventListener('change', (e) =>
      app.updatePrefs({ connection: { writeUuid: e.target.value.trim() } })
    );
    $('#setNotifyUuid').addEventListener('change', (e) =>
      app.updatePrefs({ connection: { notifyUuid: e.target.value.trim() } })
    );
    $('#setWriteMode').addEventListener('change', (e) =>
      app.updatePrefs({ connection: { writeMode: e.target.value } })
    );

    $('#btnReset').addEventListener('click', () => {
      app.resetPrefs();
      syncSettingsInputs();
      applySliderStep();
    });
    $('#btnExportLogs').addEventListener('click', exportLogs);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') renderAll();
    });
  }

  function bindAppEvents() {
    app.on('change', onAppChange);
    // 有待发送的助力调整时，刷新提示行
    app.on('tick', () => {
      if (app.getRemoteState && app.getRemoteState().pending) renderAssist();
    });
    app.on('toast', (t) => toast(t.text, t.level));
    app.on('log', (entry) => appendLogLine(entry));
    app.on('page', renderPage);
    app.on('stale', () => {
      if (!els.staleShown) {
        els.staleShown = true;
        app._internal.log('warn', '已连接但 10 秒未收到设备数据（检查通知特征/协议参数）');
        setTimeout(() => (els.staleShown = false), 15000);
      }
    });
  }

  /* ======================= 陀螺仪校准：停车门槛 ======================= */
  // 仅校准这类会改变电机标定的操作要求停车；助力调整已放开限制
  function requireParked(action) {
    const speed = app.state.bike.speed || 0;
    const sim = root.LVBU.sim;
    if (app.state.conn.status !== 'ready' && !(sim && sim.running)) return false;
    if (!app.parkedNow()) {
      toast(`${action}需停车：当前 ${util.fixed(app.displaySpeed(speed), 1)} ${app.speedLabel()}`, 'error');
      return false;
    }
    return true;
  }

  /**
   * 是否允许操作助力控件。
   * 已连接 → true；演示模式（开关打开且未连接）→ 也可操作，但不会真正发送。
   */
  function requireConnected() {
    const st = app.state;
    if (st.conn.status === 'ready') return true;
    if (st.prefs.simulateWhenDisconnected) return true;
    return false;
  }

  /** 当前是否为纯演示（未连接但允许交互） */
  function isDemoMode() {
    return app.state.conn.status !== 'ready' && !!app.state.prefs.simulateWhenDisconnected;
  }

  /** 助力百分比有效范围 0~99（100% 由设备边界处理，不主动下发） */
  const PCT_MAX = 99;

  /** 仅演示模式：直接改状态，不用连接设备 */
  function simConfirm() {
    const d = app.state.draft;
    app.state.confirmed = { ...d };
    app.state.mode = d.mode;
    d.dirty = false;
    app._internal.changed();
    toast('（演示）参数已应用', 'success');
  }

  async function nudge(dir) {
    const step = app.state.prefs.sliderStep || 5;
    const cur = app.state.draft.value || 0;
    const next = util.clamp(cur + dir * step, 0, PCT_MAX);
    if (next === cur) return;
    if (!requireConnected()) return;
    app.setDraft({ value: next, mode: 'manual' });
    // 延迟 1 秒下发：连续点击只发送最终值
    app.scheduleAssistSend('percent');
    els.assistValue.textContent = String(next);
  }

  function wireSlider() {
    let startValue = 0;
    els.slider.addEventListener('pointerdown', () => {
      startValue = Number(els.slider.value);
      els.slider.dataset.touched = '1';
    });
    els.slider.addEventListener('input', () => {
      els.assistValue.textContent = els.slider.value;
    });
    els.slider.addEventListener('change', () => {
      const v = Math.min(PCT_MAX, Number(els.slider.value));
      els.slider.dataset.touched = '0';
      if (v === startValue) return;
      if (!requireConnected()) {
        els.slider.value = startValue;
        els.assistValue.textContent = startValue;
        return;
      }
      app.setDraft({ value: v, mode: 'manual' });
      // 松手后延迟 1 秒下发（连续微调只发最终值）
      app.scheduleAssistSend('percent');
    });
    applySliderStep();
  }

  function applySliderStep() {
    els.slider.step = String(app.state.prefs.sliderStep || 5);
  }

  /* ======================= 渲染 ======================= */
  function onAppChange() {
    renderConn();
    renderSpeed();
    renderAssist();
    renderCards();
    renderDevice();
    renderDashVisibility();
  }

  /** 首页可见性：已连接或开启演示数据时显示完整面板，否则显示连接引导 */
  function renderDashVisibility() {
    const { conn, prefs } = app.state;
    const connected = conn.status === 'ready';
    const demoOn = !!prefs.simulateWhenDisconnected;
    const showFull = connected || demoOn;

    const guide = $('#emptyGuide');
    const speedBlock = $('#speedBlock');
    const statsRow = $('#statsRow');
    const panel = $('#assistPanel');
    const cards = $('.cards');

    if (guide) guide.hidden = showFull;
    [speedBlock, statsRow, panel, cards].forEach((el) => {
      if (el) el.hidden = !showFull;
    });
  }

  function renderAll() {
    onAppChange();
    renderLog(true);
    syncSettingsInputs();
    renderRawPreview();
    renderPage(app.state.page);
    applyKeepAwake();
  }

  /* ======================= 屏幕常亮（Web API 能力探测） ======================= */
  function applyKeepAwake() {
    const want = app.state.prefs.keepScreenOn;
    if (!('wakeLock' in navigator)) return;
    if (want && !els.wakeLock) {
      navigator.wakeLock
        .request('screen')
        .then((lock) => {
          els.wakeLock = lock;
          lock.addEventListener('release', () => {
            els.wakeLock = null;
          });
        })
        .catch(() => {
          app._internal.log('info', '屏幕常亮不可用（需要用户手势触发，Bluefy 可能不支持）');
        });
    } else if (!want && els.wakeLock) {
      els.wakeLock.release().catch(() => {});
      els.wakeLock = null;
    }
  }

  function renderPage(page) {
    $$('.view').forEach((v) => (v.hidden = v.dataset.page !== page));
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === page;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (page === 'device') {
      renderLog(true);
      renderRawPreview();
    }
  }

  function renderConn() {
    const { conn } = app.state;
    const demo = !!app.state.prefs.simulateWhenDisconnected && root.LVBU.sim && root.LVBU.sim.running;
    const ready = conn.status === 'ready' || demo;
    const busy = conn.status === 'connecting' || conn.status === 'discovering' || conn.status === 'requesting';
    els.connBadge.classList.toggle('is-connected', ready);
    els.connBadgeText.textContent = ready
      ? demo
        ? '演示模式'
        : '已连接'
      : busy
      ? '连接中'
      : conn.status === 'disconnected' || conn.status === 'error'
      ? '已断开'
      : '未连接';
    els.btnPower.classList.toggle('is-on', ready);

    // 信号：iOS 无 RSSI 通道时显示全部熄灭
    const rssi = conn.rssi;
    const level = rssi == null ? 0 : rssi > -60 ? 4 : rssi > -70 ? 3 : rssi > -80 ? 2 : rssi > -90 ? 1 : 0;
    $$('i', els.signalBars).forEach((bar, i) => bar.classList.toggle('on', i < level && ready));
    els.signalBars.dataset.level = String(level);
    els.rssiText.textContent = ready ? (rssi == null ? '-- dBm' : `${rssi} dBm`) : '-- dBm';
  }

  /**
   * 把数值拆成「整数位 / 小数位」两段。
   * @param {number} v 数值
   * @param {number} intDigits 整数最少位数（补零）
   * @param {object} fallback 空值占位
   * @param {number} maxInt 整数最大位数（超出则截断，默认 2）
   */
  function splitNum(v, intDigits, fallback, maxInt) {
    if (v == null || !isFinite(v)) return fallback;
    const cap = Math.pow(10, maxInt || 2) - 0.1;
    const clamped = Math.max(0, Math.min(cap, Number(v)));
    const s = clamped.toFixed(1);
    const [ip, fp] = s.split('.');
    // 不足补零；超出则保留末尾 maxInt 位
    const want = Math.max(intDigits, maxInt || 2);
    const padded = ip.padStart(intDigits, '0');
    return { int: maxInt ? padded.slice(-maxInt) : padded, frac: fp };
  }

  function renderSpeed() {
    const b = app.state.bike;
    // 主速度：整数 2 位 + 小数 1 位（0.0 ~ 99.9）
    const sp = splitNum(b.speed, 2, { int: '00', frac: '0' });
    els.speedInt.textContent = sp.int;
    els.speedFrac.textContent = sp.frac;
    els.speedUnit.textContent = 'km/h';

    // 副表：AVG / MAX 补零到 2 位
    const avg = splitNum(b.avgSpeed, 2, { int: '00', frac: '0' }, 2);
    const max = splitNum(b.maxSpeed, 2, { int: '00', frac: '0' }, 2);
    // 里程：<100 补 1 个 0（2 位）；≥100 显示 3 位
    const tripNum = b.trip != null && isFinite(b.trip) ? Math.max(0, b.trip) : null;
    const tripDigits = tripNum == null ? 2 : tripNum >= 100 ? 3 : 2;
    const trip = splitNum(tripNum, tripDigits, { int: '00', frac: '0' }, 3);

    els.statAvgInt.textContent = avg.int;
    els.statAvgFrac.textContent = avg.frac;
    els.statMaxInt.textContent = max.int;
    els.statMaxFrac.textContent = max.frac;
    els.statTripInt.textContent = trip.int;
    els.statTripFrac.textContent = trip.frac;

    // ghost 底纹同步位数：显式设置文本（2 位 <100，3 位 ≥100）
    const tripBox = els.statTripInt.closest('.s-int');
    const tripGhost = tripBox ? tripBox.querySelector('.ghost') : null;
    if (tripGhost) {
      const want = tripDigits === 3 ? '888' : '88';
      if (tripGhost.textContent !== want) tripGhost.textContent = want;
    }
  }

  function renderAssist() {
    const { conn, draft, confirmed, prefs } = app.state;
    // 演示模式：开关打开且未连接时，控件照常可交互（仅本地生效，不发送）
    const demo = !!prefs.simulateWhenDisconnected && conn.status !== 'ready';
    const live = conn.status === 'ready';
    const ready = live || demo;

    // 模式按钮
    $$('.mode', els.modeRow).forEach((btn) => {
      const key = btn.dataset.mode;
      btn.classList.toggle('is-active', draft.mode === key);
      btn.classList.toggle('is-draft', draft.mode === key && confirmed.mode !== key);
      btn.setAttribute('aria-checked', String(draft.mode === key));
    });

    // 滑杆：用户正在拖动时不覆盖
    if (els.slider.dataset.touched !== '1') els.slider.value = String(draft.value);
    els.assistValue.textContent = els.slider.dataset.touched === '1' ? els.slider.value : String(draft.value);

    // 根据模式显示档位按钮或滑杆
    const isManual = draft.mode === 'manual';
    const levelsWrap = document.getElementById('levelRow');
    const manualWrap = document.getElementById('manualSliderWrap');
    if (levelsWrap) levelsWrap.style.display = isManual ? 'none' : 'flex';
    if (manualWrap) manualWrap.style.display = isManual ? 'grid' : 'none';

    // 未连接时禁用所有助力控件；连接后随时可用（无停车限制）
    els.slider.disabled = !ready;
    els.btnMinus.disabled = !ready || draft.value <= 0;
    els.btnPlus.disabled = !ready || draft.value >= PCT_MAX;
    els.slider.max = String(PCT_MAX);

    $$('.level-btn', levelsWrap).forEach((btn) => {
      const lvl = Number(btn.dataset.level);
      btn.classList.toggle('is-active', draft.value === lvl && !isManual);
      btn.disabled = !ready;
    });

    // 提示行
    let note = '';
    if (ready) {
      els.panel.classList.remove('is-locked');
      els.panel.classList.add('is-parked-ready');
      if (demo && !live) {
        note = '演示模式 · 可自由操作，不会发送到设备';
      } else if (app.getRemoteState) {
        const rs = app.getRemoteState();
        if (rs.stopped) {
          note = `已停止助力 · 按闪控 ▲/▼ 恢复${rs.savedPower ? ` ${rs.savedPower}%` : ''}`;
        } else if (rs.pending) {
          note = '调整中 · 松开 1 秒后下发到设备';
        }
      }
    } else {
      els.panel.classList.add('is-locked');
      els.panel.classList.remove('is-parked-ready');
    }
    els.note.textContent = note;
    els.note.hidden = !note;

    renderRemoteChip();
    els.note.classList.remove('is-warn');
  }

  /* ---------------- 陀螺仪滑动中位数滤波 ---------------- */
  const GYRO_WINDOW = 5;        // 保留最近 5 次读数
  const GYRO_MAX_DELTA = 15;    // 与中位数偏差超过 15° 视为尖峰，直接丢弃
  const gyroBuf = [];

  function pushGyroSample(v) {
    if (!isFinite(v)) return;
    // 先与当前中位数比较，偏差过大则不入缓冲（避免尖峰污染）
    const cur = median(gyroBuf);
    if (cur != null && Math.abs(v - cur) > GYRO_MAX_DELTA) return;
    gyroBuf.push(v);
    if (gyroBuf.length > GYRO_WINDOW) gyroBuf.shift();
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function getFilteredGyro() {
    return median(gyroBuf);
  }

  /** 渲染 10 格进度条 */
  function renderBars(field, ratio, level) {
    const grid = $(`[data-field="${field}"]`);
    if (!grid) return;
    const cells = $$('i', grid);
    const filled = ratio == null ? 0 : Math.min(10, Math.max(0, Math.floor(ratio * 10)));
    cells.forEach((cell, i) => cell.classList.toggle('on', i < filled));
    grid.dataset.level = level || 'high';
  }

  function renderCards() {
    const b = app.state.bike;

    // ===== 陀螺仪角度（带中位数滤波）=====
    // 设备返回的 BD 值在颠簸瞬间会剧烈跳变（实测平路 raw≈52，颠簸 raw≈1119），
    // 属于传感器受冲击的瞬时尖峰。这里用滑动中位数滤波，得到稳定的车身倾角。
    const rawAngle = b.gyro != null && isFinite(b.gyro) ? b.gyro : null;
    if (rawAngle != null) pushGyroSample(rawAngle);
    const angle = getFilteredGyro();
    // 单位由 HTML 的 <em class="u"> 提供，这里只输出数值
    setCard('cardGyro', angle, (v) => util.fixed(v, 1));
    // 进度条：角度绝对值 0~90° 映射到 10 格
    renderBars('slopeGrid', angle == null ? null : util.clamp(Math.abs(angle) / 90, 0, 1), 'high');

    // ===== 电量 =====
    const battCard = document.getElementById('cardBattery');
    const voltEl = $('[data-field="voltage"]');
    const hasVolt = b.voltage != null && isFinite(b.voltage);
    voltEl.innerHTML = (hasVolt ? util.fixed(b.voltage, 1) : '--') + '<em class="u">V</em>';
    battCard.classList.toggle('is-empty', !hasVolt);

    const pct = b.battery != null && isFinite(b.battery) ? Math.round(b.battery) : null;
    $('[data-field="batterySub"]').textContent = pct == null ? '--%' : `${pct}%`;
    renderBars('batteryGrid', pct == null ? null : pct / 100);
    // 电量配色：>80 绿 / 50~80 蓝 / 20~50 橙 / <20 红
    battCard.dataset.tone =
      pct == null ? 'none' : pct > 80 ? 'green' : pct >= 50 ? 'blue' : pct >= 20 ? 'orange' : 'red';

    // ===== 温度 =====
    const tempCard = document.getElementById('cardTemp');
    const temp = b.controllerTemp != null && isFinite(b.controllerTemp) ? b.controllerTemp : null;
    setCard('cardTemp', temp, (v) => util.fixed(v, 1));
    // 温度进度条：0~100℃ 映射到 10 格
    renderBars('tempGrid', temp == null ? null : util.clamp(temp / 100, 0, 1));
    // 温度配色：<30 绿 / 30~50 黄 / >50 红
    tempCard.dataset.tone =
      temp == null ? 'none' : temp < 30 ? 'green' : temp <= 50 ? 'yellow' : 'red';
  }

  function setCard(id, value, fmt) {
    const card = document.getElementById(id);
    const val = card.querySelector('.card__value');
    // 保留单位后缀 <em class="u">（V / ℃ / °），只替换数值部分
    const unit = val.querySelector('.u');
    const unitHtml = unit ? unit.outerHTML : '';
    const empty = value == null || !isFinite(value);
    card.classList.toggle('is-empty', empty);
    val.innerHTML = (empty ? '--' : fmt(value)) + unitHtml;
  }

  function renderDevice() {
    const { conn } = app.state;
    els.devName.textContent = conn.device ? conn.device.name : '未连接';
    // 顶部栏设备名同步（有设备显示设备名，否则显示品牌默认值）
    if (els.headDevName) {
      els.headDevName.textContent = conn.device ? conn.device.name : 'LvBu motor';
    }
    const map = {
      idle: ['未连接', ''],
      requesting: ['选择中…', 'is-busy'],
      connecting: ['连接中…', 'is-busy'],
      discovering: ['发现服务…', 'is-busy'],
      ready: ['已连接', 'is-ready'],
      disconnected: ['已断开', ''],
      error: ['错误', 'is-error'],
    };
    const [txt, cls] = map[conn.status] || map.idle;
    els.devStatus.textContent = txt;
    els.devStatus.className = 'pill ' + cls;
    els.devId.textContent = conn.device ? conn.device.id : '--';
    els.devRssi.textContent = conn.rssi == null ? '--' : `${conn.rssi} dBm`;
    els.devWrite.textContent = conn.chars ? `${conn.chars.write} (${conn.chars.writeMode})` : '--';
    els.devNotify.textContent = conn.chars ? conn.chars.notify : '--';
    els.btnDisconnect.disabled = conn.status !== 'ready' && conn.status !== 'disconnected';
    els.btnReconnect.disabled = !conn.device || conn.status === 'connecting' || conn.status === 'discovering' || conn.status === 'ready';
    renderRemote();
  }

  /** 首页助力面板里的闪控状态图标（绿=已连接，灰=未连接） */
  function renderRemoteChip() {
    if (!els.remoteChip) return;
    const r = (app.state.remote) || { status: 'idle' };
    const map = {
      idle: ['未连接', ''],
      requesting: ['选择中', 'is-busy'],
      connecting: ['连接中', 'is-busy'],
      ready: ['已连接', 'is-ready'],
      disconnected: ['已断开', ''],
      error: ['错误', ''],
    };
    const [label, cls] = map[r.status] || map.idle;
    els.remoteChip.className = 'remote-chip ' + cls;
    // 无文字，仅通过 title/aria 提供给读屏与长按提示
    els.remoteChip.title = 'BR80 闪控' + label;
    els.remoteChip.setAttribute('aria-label', 'BR80 闪控' + label);
  }

  /** 渲染 BR80 闪控状态 */
  function renderRemote() {
    if (!els.remoteName) return;
    const r = app.state.remote || { status: 'idle', device: null };
    const map = {
      idle: ['未连接', ''],
      requesting: ['选择中…', 'is-busy'],
      connecting: ['连接中…', 'is-busy'],
      ready: ['已连接', 'is-ready'],
      disconnected: ['已断开', ''],
      error: ['错误', 'is-error'],
    };
    const [txt, cls] = map[r.status] || map.idle;
    els.remoteName.textContent = r.device ? r.device.name : '未连接';
    els.remoteStatus.textContent = txt;
    els.remoteStatus.className = 'pill ' + cls;
    // 闪控电量
    const battEl = $('#remoteBattery');
    if (battEl) {
      const b = r.battery;
      if (b == null) battEl.textContent = '--';
      else battEl.textContent = `${b}%`;
      battEl.style.color = b == null ? '' : b > 50 ? 'var(--green)' : b > 20 ? 'var(--amber-hi)' : 'var(--red)';
    }
    const busy = r.status === 'requesting' || r.status === 'connecting';
    els.btnRemoteConnect.disabled = busy || r.status === 'ready';
    els.btnRemoteDisconnect.disabled = r.status !== 'ready';
    const pingBtn = $('#btnRemotePing');
    const resubBtn = $('#btnRemoteResub');
    const dumpBtn = $('#btnRemoteDump');
    const forceBtn = $('#btnRemoteForce');
    const rawBtn = $('#btnRemoteSendRaw');
    const inspBtn = $('#btnRemoteInspect');
    if (pingBtn) pingBtn.disabled = r.status !== 'ready';
    if (resubBtn) resubBtn.disabled = r.status !== 'ready';
    if (dumpBtn) dumpBtn.disabled = r.status !== 'ready';
    if (forceBtn) forceBtn.disabled = r.status !== 'ready';
    if (rawBtn) rawBtn.disabled = r.status !== 'ready';
    if (inspBtn) inspBtn.disabled = r.status !== 'ready';
  }

  /* ======================= 日志 ======================= */
  const DIR_SYMBOL = { tx: '→', rx: '←', ble: '≈', info: 'i', warn: '!', error: '×', tick: '·' };

  function appendLogLine(entry) {
    if (app.state.page !== 'device') {
      // 非设备页不渲染，切页时整体重绘
      els.logDirty = true;
      return;
    }
    if (!els.logView) return;
    const empty = $('.log__empty', els.logView);
    if (empty) empty.remove();
    const line = document.createElement('div');
    line.className = 'log__line';
    line.innerHTML =
      `<span class="log__t">${util.nowHMS(entry.t)}</span>` +
      `<span class="log__d" data-d="${entry.direction}">${DIR_SYMBOL[entry.direction] || '·'}</span>` +
      `<span class="log__m"></span>`;
    const msg = $('.log__m', line);
    if (entry.cmd != null && entry.direction === 'tx') {
      msg.innerHTML = `<em>[${entry.cmd.toString(16).padStart(2, '0')}]</em> `;
      msg.appendChild(document.createTextNode(entry.text));
    } else {
      msg.textContent = entry.text;
    }
    els.logView.appendChild(line);
    while (els.logView.children.length > 300) els.logView.removeChild(els.logView.firstChild);
    if ($('#autoScroll').checked) els.logView.scrollTop = els.logView.scrollHeight;
  }

  function renderLog(force) {
    if (!els.logView) return;
    if (app.state.page !== 'device' && !force) return;
    els.logView.innerHTML = '';
    if (!app.state.logs.length) {
      els.logView.innerHTML = '<div class="log__empty">尚无收发记录。连接设备后，收发帧会显示在这里。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    app.state.logs.forEach((e) => {
      const line = document.createElement('div');
      line.className = 'log__line';
      line.innerHTML =
        `<span class="log__t">${util.nowHMS(e.t)}</span>` +
        `<span class="log__d" data-d="${e.direction}">${DIR_SYMBOL[e.direction] || '·'}</span>` +
        `<span class="log__m"></span>`;
      $('.log__m', line).textContent = e.text;
      frag.appendChild(line);
    });
    els.logView.appendChild(frag);
    els.logView.scrollTop = els.logView.scrollHeight;
  }

  function exportLogs() {
    const { conn, prefs, logs } = app.state;
    const header = [
      '# LVBU BLE 日志',
      '# 设备: ' + (conn.device ? `${conn.device.name} (${conn.device.id})` : '未连接'),
      '# IMEI: ' + (prefs.imei || ''),
      '# 时间: ' + new Date().toISOString(),
      '',
    ].join('\n');
    const body = logs.map((e) => `${util.nowHMS(e.t)} [${e.direction}] ${e.text}`).join('\n');
    const blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lvbu-log-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    toast('日志已导出');
  }

  /* ======================= 原始命令发送（文本协议） ======================= */
  function buildRawFrame() {
    const text = els.rawInput.value.trim();
    if (!text) return { error: '请输入命令文本（示例：C0F866855030090179）' };
    // 自动补 IMEI：如果用户只输入命令码如 C0，自动拼接 F + IMEI
    let full = text;
    if (/^[A-Fa-f0-9]{2}$/.test(text)) {
      const imei = app.state.prefs.imei || '866855030090179';
      full = text.toUpperCase() + 'F' + imei;
    }
    return { frame: new TextEncoder().encode(full), note: '文本协议，直接发送', text: full };
  }

  function renderRawPreview() {
    if (!els.rawPreview) return;
    const r = buildRawFrame();
    pendingPreviewFrame = r.frame || null;
    els.rawPreview.textContent = r.error
      ? `预览：${r.error}`
      : `将发送：${r.text || ''}`;
  }

  async function onSendRaw() {
    const r = buildRawFrame();
    if (r.error) return toast(r.error, 'error');
    try {
      await app.sendRaw(r.text);
      toast('已发送 ' + r.text, 'success');
    } catch (err) {
      toast('发送失败：' + (err.message || err), 'error');
    }
  }

  /* ======================= 设置页同步 ======================= */
  function syncSettingsInputs() {
    const p = app.state.prefs;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = v;
    };
    const check = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!v;
    };
    if (!$('#setStep')) return;
    set('setStep', String(p.sliderStep));
    set('setGap', String(p.frameGapMs));
    check('setKeepScreen', p.keepScreenOn);
    check('setDemo', p.simulateWhenDisconnected);
    set('setImei', p.imei);

    set('setService', p.connection.serviceUuid);
    set('setWriteUuid', p.connection.writeUuid);
    set('setNotifyUuid', p.connection.notifyUuid);
    set('setWriteMode', p.connection.writeMode);
  }

  /* ======================= Toast ======================= */
  function toast(text, level) {
    if (!els.toast) return;
    // 确保 text 是字符串
    const safeText = typeof text === 'string' ? text : JSON.stringify(text);
    els.toast.textContent = safeText;
    els.toast.dataset.level = level || 'info';
    els.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-show'), 2400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);