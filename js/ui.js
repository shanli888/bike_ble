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
    bindEvents();
    bindAppEvents();
    syncSettingsInputs();

    // 传输层：Web Bluetooth（助力控制器）
    app.attachTransport(ble.createTransport(app.state.prefs));
    if (!(ble.supported && ble.supported()) && !app.state.transport.supported()) {
      app._internal.log('warn', '当前浏览器不支持 Web Bluetooth。iOS 请使用 Bluefy 打开。');
    }

    // BR80 闪控（独立蓝牙设备，可与控制器同时连接）
    if (root.LVBU.remote) {
      app.attachRemote(root.LVBU.remote.createRemote());
    }

    // 演示数据：开关开启且未连接时，填充固定示例数据
    if (root.LVBU.sim) {
      let demoSeeded = false;
      const applyDemo = () => {
        const on = app.state.prefs.simulateWhenDisconnected && app.state.conn.status !== 'ready';
        if (on && !demoSeeded) {
          root.LVBU.sim.seed(); // 填充固定示例值
          demoSeeded = true;
          app._internal.changed();
        }
        if (!on) demoSeeded = false; // 连接或关闭开关后，允许下次重新填充
        if (root.LVBU.sim.running) root.LVBU.sim.stop(); // 不跑动态模拟
      };
      applyDemo();
      stickDemo = setInterval(applyDemo, 1500);
    }

    wireSlider();
    renderAll();
    app.startClock();

    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.lock) {
      /* 保持竖屏由 manifest/系统控制；此处不强制，避免 iOS 抛错 */
    }
  }

  function cacheEls() {
    els.connLeft = $('#connLeft');
    els.connText = $('#connText');
    els.connRight = $('#connRight');
    els.rssiText = $('#rssiText');
    els.signalBars = $('#signalBars');
    els.speedValue = $('#speedValue');
    els.speedUnit = $('#speedUnit');
    els.statAvg = $('#statAvg');
    els.statMax = $('#statMax');
    els.statTrip = $('#statTrip');
    els.panel = $('#assistPanel');
    
    els.note = $('#assistNote');
    
    els.modeRow = $('#modeRow');
    els.slider = $('#assistSlider');
    els.assistValue = $('#assistValue');
    els.btnMinus = $('#btnMinus');
    els.btnPlus = $('#btnPlus');
    els.toast = $('#toast');
    els.btnPower = $('#btnPower');
    els.assistPct = $('#assistPct');
    els.remoteChip = $('#remoteChip');
    
    els.remoteName = $('#remoteName');
    els.remoteStatus = $('#remoteStatus');
    els.btnRemoteConnect = $('#btnRemoteConnect');
    els.btnRemoteDisconnect = $('#btnRemoteDisconnect');
    els.devName = $('#devName');
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
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => app.go(tab.dataset.tab));
    });

    $('#brandBtn').addEventListener('click', () => {
      const d = app.state.conn.device;
      toast(d ? `已连接：${d.name}` : '点击「设备」页选择码表');
      app.go('device');
    });

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
    // 闪控冻结倒计时需要持续刷新
    app.on('tick', () => {
      if (app.getRemoteState && app.getRemoteState().frozenMs > 0) renderAssist();
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

  /** 助力百分比可随时调整，只需已连接 */
  function requireConnected() {
    const sim = root.LVBU.sim;
    return app.state.conn.status === 'ready' || (sim && sim.running);
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
    await app.applyAssist(); // 立即下发
  }

  function wireSlider() {
    let startValue = 0;
    els.slider.addEventListener('pointerdown', () => {
      startValue = Number(els.slider.value);
      els.slider.dataset.touched = '1';
    });
    els.slider.addEventListener('input', () => {
      els.assistValue.textContent = els.slider.value;
      // 拖动过程中标题后的百分比同步跳动
      if (els.assistPct) {
        els.assistPct.textContent = `${els.slider.value}%`;
        els.assistPct.classList.toggle('is-off', Number(els.slider.value) === 0);
      }
    });
    els.slider.addEventListener('change', async () => {
      const v = Math.min(PCT_MAX, Number(els.slider.value));
      els.slider.dataset.touched = '0';
      if (v === startValue) return;
      if (!requireConnected()) {
        els.slider.value = startValue;
        els.assistValue.textContent = startValue;
        return;
      }
      app.setDraft({ value: v, mode: 'manual' });
      await app.applyAssist(); // 松手立即下发
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
    els.connLeft.classList.toggle('is-connected', ready);
    els.connText.textContent = ready
      ? demo
        ? '演示模式'
        : '已连接'
      : busy
      ? '连接中…'
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

  function renderSpeed() {
    const b = app.state.bike;
    // 直接显示设备返回速度（km/h），无单位换算
    const sp = b.speed;
    els.speedValue.textContent = util.fixed(sp, 1);
    els.speedUnit.textContent = 'km/h';
    els.statAvg.textContent = util.fixed(b.avgSpeed, 1);
    els.statMax.textContent = util.fixed(b.maxSpeed, 1);
    els.statTrip.textContent = `${util.fixed(b.trip, 1)} km`;
    // 数字宽度自适应，避免超长时溢出
    const len = els.speedValue.textContent.length;
    els.speedValue.style.fontSize = len >= 5 ? '96px' : len >= 4 ? '112px' : '';
  }

  function renderAssist() {
    const { conn, draft, confirmed, prefs } = app.state;
    const sim = root.LVBU.sim;
    const demo = !!prefs.simulateWhenDisconnected && sim && sim.running;
    const ready = conn.status === 'ready' || demo;

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
    // 标题后的实时百分比
    if (els.assistPct) {
      const shown = els.slider.dataset.touched === '1' ? els.slider.value : String(draft.value);
      els.assistPct.textContent = `${shown}%`;
      els.assistPct.classList.toggle('is-off', !ready || Number(shown) === 0);
    }

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

    // 提示行仅在闪控有状态时出现，平时隐藏
    let note = '';
    if (ready) {
      els.panel.classList.remove('is-locked');
      els.panel.classList.add('is-parked-ready');
      if (app.getRemoteState) {
        const rs = app.getRemoteState();
        if (rs.stopped) {
          note = `已停止助力 · 按闪控 ▲/▼ 恢复${rs.savedPower ? ` ${rs.savedPower}%` : ''}`;
        } else if (rs.frozenMs > 0) {
          note = `闪控操作冻结中 · ${Math.ceil(rs.frozenMs / 1000)} 秒后可再按`;
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
    setCard('cardGyro', angle, (v) => `${util.fixed(v, 1)}°`);
    // 进度条：角度绝对值 0~90° 映射到 10 格
    renderBars('slopeGrid', angle == null ? null : util.clamp(Math.abs(angle) / 90, 0, 1), 'high');

    // ===== 电量 =====
    const voltEl = $('[data-field="voltage"]');
    const hasVolt = b.voltage != null && isFinite(b.voltage);
    voltEl.textContent = hasVolt ? `${util.fixed(b.voltage, 1)}V` : '--';
    document.getElementById('cardBattery').classList.toggle('is-empty', !hasVolt);

    const pct = b.battery != null && isFinite(b.battery) ? Math.round(b.battery) : null;
    $('[data-field="batterySub"]').textContent = pct == null ? '--%' : `${pct}%`;
    renderBars('batteryGrid', pct == null ? null : pct / 100, pct == null ? 'low' : pct > 50 ? 'high' : pct > 20 ? 'mid' : 'low');

    // ===== 温度 =====
    const temp = b.controllerTemp != null && isFinite(b.controllerTemp) ? b.controllerTemp : null;
    setCard('cardTemp', temp, (v) => util.fixed(v, 1));
    // 温度进度条：0~100℃ 映射到 10 格
    renderBars('tempGrid', temp == null ? null : util.clamp(temp / 100, 0, 1), 'mid');
  }

  function setCard(id, value, fmt) {
    const card = document.getElementById(id);
    const val = card.querySelector('.card__value');
    const empty = value == null || !isFinite(value);
    card.classList.toggle('is-empty', empty);
    val.textContent = empty ? '--' : fmt(value);
  }

  function renderDevice() {
    const { conn } = app.state;
    els.devName.textContent = conn.device ? conn.device.name : '未连接';
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
    const busy = r.status === 'requesting' || r.status === 'connecting';
    els.btnRemoteConnect.disabled = busy || r.status === 'ready';
    els.btnRemoteDisconnect.disabled = r.status !== 'ready';
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