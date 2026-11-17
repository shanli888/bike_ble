/* =========================================================================
 * sim.js — 演示数据源（不占用蓝牙，可与真实连接同时运行）
 *
 * 用途：手工验收 UI（速度/电量/温度会缓慢变化），以及在没有设备时
 *       演示助力面板的“停车确认”交互。
 * ========================================================================= */
(function (root) {
  'use strict';
  const { app } = root.LVBU;

  const script = {
    targetSpeed: 0,
    level: 30,
    running: false,
    timer: null,
    raf: null,
    lastTick: 0,
    t: 0,
  };

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function start() {
    if (script.timer) return;
    script.running = true;
    script.debug = true; // 演示期间在标题栏显示 tick 计数，便于排查
    script.startedAt = Date.now();
    script.lastTick = Date.now();
    // 用 requestAnimationFrame + setInterval 双保险：
    // 移动端切后台时 rAF 会暂停，setInterval 可能被节流，任一恢复即可继续
    script.timer = setInterval(tick, 400);
    if (typeof requestAnimationFrame === 'function') {
      const raf = () => {
        if (!script.running) return;
        tick();
        script.raf = requestAnimationFrame(raf);
      };
      script.raf = requestAnimationFrame(raf);
    }
  }

  /** 单次推进：基于真实时间差，保证手机/电脑进度一致 */
  function tick() {
    if (!script.running) return;
    const now = Date.now();
    const elapsed = now - script.lastTick;
    // 双重定时器会重复触发，这里限制最小间隔 300ms
    if (elapsed < 300) return;
    const dt = Math.min(2, elapsed / 1000);
    script.lastTick = now;
    script.ticks = (script.ticks || 0) + 1;
    step(dt);
    // 诊断：标签页标题显示 tick 计数（便于确认循环是否在跑）
    if (script.debug) {
      document.title = `[${script.ticks}] ${Math.round(script.t)}s`;
    }
  }

  function stop() {
    script.running = false;
    if (script.timer) clearInterval(script.timer);
    script.timer = null;
    if (script.raf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(script.raf);
    }
    script.raf = null;
  }

  function step(dt) {
    const s = app.state;
    const b = s.bike;
    script.t += dt;

    /* ---------- 循环演示 ----------
     * 各指标按不同周期在完整取值区间内往返扫描，
     * 确保每个配色档位（电量 4 档 / 温度 3 档）都能被看到。
     * 周期：速度 20s，电量 45s，温度 30s，里程持续累加。
     */

    // 速度：3.0 ~ 42.5 km/h 三角波（20 秒一往复）
    const speedPhase = (script.t % 20) / 20;          // 0..1
    const speedTri = speedPhase < 0.5 ? speedPhase * 2 : (1 - speedPhase) * 2; // 0..1..0
    const speed = 3 + speedTri * 39.5;
    b.speed = Math.round(speed * 10) / 10;

    // 平均速度：缓慢爬升后回落（0 ~ 30）
    const avgTri = ((script.t % 60) / 60);
    const avgWave = avgTri < 0.5 ? avgTri * 2 : (1 - avgTri) * 2;
    b.avgSpeed = Math.round(avgWave * 30 * 10) / 10;

    // 最高速度：阶梯式增长，循环重置
    const maxCycle = Math.floor(script.t / 12) % 6;   // 0..5
    b.maxSpeed = Math.round((18 + maxCycle * 6.4) * 10) / 10;

    // 里程：持续累加，到 999.9 后回绕（验证 3 位整数排版）
    script.odo = (script.odo || 0) + (speed * dt) / 3600;
    if (script.odo > 999.9) script.odo = 0;
    b.trip = Math.round(script.odo * 10) / 10;
    b.odo = Math.round((1284.6 + script.odo) * 10) / 10;

    // 电量：0 ~ 100 往返扫描（45 秒），覆盖绿/蓝/橙/红四档
    const battPhase = (script.t % 45) / 45;
    const battTri = battPhase < 0.5 ? battPhase * 2 : (1 - battPhase) * 2;
    b.battery = Math.round(battTri * 100);
    // 电压与电量联动（10S 锂电 30V~42V）
    b.voltage = Math.round((30 + battTri * 12) * 10) / 10;

    // 温度：5 ~ 65℃ 往返扫描（30 秒），覆盖绿/黄/红三档
    const tempPhase = (script.t % 30) / 30;
    const tempTri = tempPhase < 0.5 ? tempPhase * 2 : (1 - tempPhase) * 2;
    b.controllerTemp = Math.round((5 + tempTri * 60) * 10) / 10;
    b.motorTemp = Math.round((b.controllerTemp + rand(1, 3)) * 10) / 10;

    // 陀螺仪角度固定 3.2°（文档 §5：演示数据不随时间变化，固定正坡度）
    b.gyro = 3.2;

    // 助力功率（仅演示显示）
    if ((s.confirmed.value || 0) > 0) {
      const base = (s.confirmed.value || 0) * 2.2;
      b.assistPower = Math.round(base + Math.sin(script.t * 1.7) * 6 + rand(-3, 3));
      b.motorPower = Math.round(b.assistPower * rand(1.6, 2.1));
      b.cadence = Math.round(52 + Math.sin(script.t / 3) * 8);
    } else {
      b.assistPower = 0;
      b.motorPower = 0;
      b.cadence = 0;
    }

    app._internal.changed();
  }

  /** 首次启动时铺一组示例数据，便于预览界面效果 */
  function seed() {
    const b = app.state.bike;
    Object.assign(b, {
      speed: 18.6,
      // 副表演示值（真实连接时由统计模块按实际速度覆盖）
      avgSpeed: 15.2,
      maxSpeed: 24.8,
      trip: 567.9,        // 用于验证两位数里程的排版
      odo: 1284.8,
      battery: 90,        // 电量百分比
      voltage: 40.1,      // 电压
      assistLevel: 30,
      assistPower: 440,
      motorPower: 630,
      gyro: 1.5,          // 陀螺仪角度（°）
      cadence: 58,
      controllerTemp: 20.4,
      motorTemp: 23.0,
    });
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.sim = {
    start,
    stop,
    seed,
    get running() {
      return script.running;
    },
    set level(v) {
      script.level = v;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);