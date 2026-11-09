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

    // 传输层：Web Bluetooth
    app.attachTransport(ble.createTransport(app.state.prefs));
    if (!(ble.supported && ble.supported()) && !app.state.transport.supported()) {
      app._internal.log('warn', '当前浏览器不支持 Web Bluetooth。iOS 请使用 Bluefy 打开。');
    }

    // 演示数据：未连接时填充固定的示例数据（不动态改变）
    if (root.LVBU.sim) {
      // 仅填充一次静态示例数据，不启动动态模拟循环
      const applyDemo = () => {
        const on = app.state.prefs.simulateWhenDisconnected && app.state.conn.status !== 'ready';
        if (on) {
          root.LVBU.sim.seed(); // 每次重填固定示例值
          if (root.LVBU.sim.running) root.LVBU.sim.stop();
        }
      };
      applyDemo();
      stickDemo = setInterval(applyDemo, 2000); // 兜底：切回断开状态时重新填充
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
    els.hint = $('#assistHint');
    els.note = $('#assistNote');
    els.confirmChip = $('#confirmChip');
    els.modeRow = $('#modeRow');
    els.slider = $('#assistSlider');
    els.assistValue = $('#assistValue');
    els.btnMinus = $('#btnMinus');
    els.btnPlus = $('#btnPlus');
    els.toast = $('#toast');
    els.btnPower = $('#btnPower');
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

    // 助力：模式按钮只改草稿
    els.modeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode');
      if (!btn) return;
      const key = btn.dataset.mode;
      const def = config.RIDE_MODES.find((m) => m.key === key);
      const draft = { mode: key };
      if (def && def.assist != null) draft.value = def.assist;
      app.setDraft(draft);
    });

    // 档位按钮（非手动模式）
    $('#levelRow').addEventListener('click', (e) => {
      const btn = e.target.closest('.level-btn');
      if (!btn) return;
      const level = Number(btn.dataset.level);
      if (!requireParked('选择档位')) return;
      app.setDraft({ value: level });
    });

    els.btnMinus.addEventListener('click', () => nudge(-1));
    els.btnPlus.addEventListener('click', () => nudge(+1));

    els.confirmChip.addEventListener('click', onConfirmChip);

    // 设备页
    $('#btnScan').addEventListener('click', async () => {
      // 打开系统设备选择器（Web Bluetooth 必须由用户手势触发）
      try {
        await app.scan();
      } catch (err) {
        toast('连接失败：' + (err.message || err), 'error');
      }
    });
    $('#btnReconnect').addEventListener('click', () => app.reconnect());
    $('#btnDisconnect').addEventListener('click', () => app.disconnect());
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

  /* ======================= 助力：停车门槛 ======================= */
  function requireParked(action) {
    const speed = app.state.bike.speed || 0;
    const sim = root.LVBU.sim;
    if (app.state.conn.status !== 'ready' && !(sim && sim.running)) return false; // 未连接时按钮本应禁用
    if (!app.parkedNow()) {
      toast(`${action}需停车确认：当前 ${util.fixed(app.displaySpeed(speed), 1)} ${app.speedLabel()}`, 'error');
      return false;
    }
    return true;
  }

  /** 仅演示模式：直接改状态，不用连接设备 */
  function simConfirm() {
    const d = app.state.draft;
    app.state.confirmed = { ...d };
    app.state.mode = d.mode;
    d.dirty = false;
    app._internal.changed();
    toast('（演示）参数已应用', 'success');
  }

  function nudge(dir) {
    const step = app.state.prefs.sliderStep || 5;
    const cur = app.state.draft.value || 0;
    const next = util.clamp(cur + dir * step, 0, 100);
    if (next === cur) return;
    if (!requireParked('调整助力')) return;
    app.setDraft({ value: next });
  }

  function wireSlider() {
    let startValue = 0;
    els.slider.addEventListener('pointerdown', () => {
      startValue = Number(els.slider.value);
      els.slider.dataset.touched = '1';
    });
    els.slider.addEventListener('input', () => {
      els.assistValue.textContent = els.slider.value;
      const manual = app.state.draft.mode === 'manual';
      $('#assistHint').textContent = manual ? '手动 0~100%' : '手动 0~100%';
    });
    els.slider.addEventListener('change', () => {
      const v = Number(els.slider.value);
      els.slider.dataset.touched = '0';
      if (v === startValue) return;
      if (!requireParked('调整助力')) {
        els.slider.value = startValue;
        els.assistValue.textContent = startValue;
        return;
      }
      app.setDraft({ value: v });
    });
    applySliderStep();
  }

  function applySliderStep() {
    els.slider.step = String(app.state.prefs.sliderStep || 5);
  }

  async function onConfirmChip() {
    const d = app.state.draft;
    const c = app.state.confirmed;
    const sim = root.LVBU.sim;
    if (app.state.conn.status === 'ready') {
      if (d.mode === c.mode && d.value === c.value) {
        if (d.mode === 'manual') {
          if (!requireParked('手动控制')) return;
        } else {
          toast('参数未修改，无需确认');
          return;
        }
      }
      await app.confirmParked();
      return;
    }
    if (sim && sim.running) {
      if (!requireParked('演示确认')) return;
      simConfirm();
      return;
    }
    toast('请先连接设备', 'error');
  }

  /* ======================= 渲染 ======================= */
  function onAppChange() {
    renderConn();
    renderSpeed();
    renderAssist();
    renderCards();
    renderDevice();
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
    els.statAvg.textContent = `${util.fixed(b.avgSpeed, 1)} km/h`;
    els.statMax.textContent = `${util.fixed(b.maxSpeed, 1)} km/h`;
    els.statTrip.textContent = `${util.fixed(b.trip, 1)} km`;
    // 数字宽度自适应，避免超长时溢出
    const len = els.speedValue.textContent.length;
    els.speedValue.style.fontSize = len >= 5 ? '96px' : len >= 4 ? '112px' : '';
  }

  function renderAssist() {
    const { conn, draft, confirmed, bike, prefs } = app.state;
    const sim = root.LVBU.sim;
    const demo = !!prefs.simulateWhenDisconnected && sim && sim.running;
    const ready = conn.status === 'ready' || demo;
    const parked = app.parkedNow();

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

    // 禁用状态
    els.slider.disabled = !ready || !parked;
    els.btnMinus.disabled = !ready || !parked || draft.value <= 0;
    els.btnPlus.disabled = !ready || !parked || draft.value >= 100;

    // 档位按钮状态
    $$('.level-btn', levelsWrap).forEach((btn) => {
      const lvl = Number(btn.dataset.level);
      btn.classList.toggle('is-active', draft.value === lvl && !isManual);
      btn.disabled = !ready || !parked;
    });

    // 顶部提示文案
    els.hint.textContent = isManual ? '手动 0~100%' : `${app.modeLabel(draft.mode)} · 档位 ${draft.value}`;

    if (!ready) {
      els.note.textContent = '未连接设备 · 连接后可在停车状态下调整助力';
      els.panel.classList.add('is-locked');
      els.panel.classList.remove('is-parked-ready');
    } else if (!parked) {
      els.note.textContent = `调整助力需停车：当前 ${util.fixed(app.displaySpeed(bike.speed), 1)} ${app.speedLabel()}（< 0.5 可确认）`;
      els.panel.classList.add('is-locked');
      els.panel.classList.remove('is-parked-ready');
    } else if (draft.dirty) {
      els.note.textContent = '已停车 · 点击右侧按钮确认下发新参数';
      els.panel.classList.remove('is-locked');
      els.panel.classList.add('is-parked-ready');
    } else {
      els.note.textContent = '已停车 · 可直接调整助力档位';
      els.panel.classList.remove('is-locked');
      els.panel.classList.add('is-parked-ready');
    }

    // 确认胶囊
    const modeName = app.modeLabel(confirmed.mode);
    els.confirmChip.classList.remove('is-ready', 'is-done');
    if (draft.dirty) {
      els.confirmChip.textContent = parked ? '确认下发' : '待停车确认';
      els.confirmChip.classList.toggle('is-ready', parked);
    } else if (ready) {
      els.confirmChip.textContent = `${modeName} · 已确认`;
      els.confirmChip.classList.add('is-done');
    } else {
      els.confirmChip.textContent = `${modeName} · 未连接`;
    }

    // 方案 B 备用样式：未确认时顶部提示语改为 amber 警示
    els.note.classList.toggle('is-warn', draft.dirty && !parked);
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

    // ===== 坡度 =====
    const slope = b.gyro != null ? Math.round(Math.tan((b.gyro * Math.PI) / 180) * 100) : null;
    $('[data-field="slopeHl"]').textContent = slope == null ? '--%' : `${slope}%`;
    setCard('cardGyro', slope, (v) => `${v}%`);
    // 坡度进度条：0~30% 映射到 10 格
    renderBars('slopeGrid', slope == null ? null : util.clamp(slope / 30, 0, 1), 'high');

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
    $('[data-field="tempHl"]').textContent = temp == null ? '--℃' : `${util.fixed(temp, 1)}℃`;
    setCard('cardTemp', temp, (v) => util.fixed(v, 1));
    // 温度进度条：0~60℃ 映射到 10 格
    renderBars('tempGrid', temp == null ? null : util.clamp(temp / 60, 0, 1), 'mid');
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