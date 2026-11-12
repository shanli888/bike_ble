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
    t: 0,
  };

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function start() {
    if (script.timer) return;
    script.running = true;
    let last = performance.now();
    script.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(1, (now - last) / 1000);
      last = now;
      step(dt);
    }, 400);
  }

  function stop() {
    script.running = false;
    if (script.timer) clearInterval(script.timer);
    script.timer = null;
  }

  function step(dt) {
    const s = app.state;
    const b = s.bike;
    script.t += dt;

    // 速度：围绕目标值做平滑逼近 + 小抖动
    const wobble = Math.sin(script.t * 0.7) * 0.4 + Math.sin(script.t * 2.3) * 0.15;
    const target = (s.confirmed.value || 0) > 0 ? 12 + (s.confirmed.value || 0) * 0.12 : 0;
    const cur = b.speed || 0;
    const next = Math.max(0, cur + (target - cur) * Math.min(1, dt * 0.8) + wobble * dt * 1.5);
    // 交给 app 的统计模块统一计算里程/平均/最高速度
    app.markSpeedSample(Math.round(next * 10) / 10);
    b.odo = 1284.6 + (b.trip || 0);

    // 电量缓慢下降，温度/坡度缓慢变化
    if (b.battery != null) b.battery = Math.max(0, Math.round((b.battery - next * dt * 0.02) * 10) / 10);
    if (script.t % 3 < dt) {
      b.controllerTemp = Math.round(rand(20, 26) * 10) / 10;
      b.motorTemp = b.controllerTemp + rand(1, 3);
      b.gyro = Math.round(rand(0.5, 3) * 10) / 10; // 陀螺仪角度 0.5~3°
      b.voltage = Math.round((37.6 + rand(-0.3, 0.3)) * 10) / 10;
    }

    // 助力功率（仅演示显示，不依赖字段）
    if ((s.confirmed.value || 0) > 0) {
      const base = (s.confirmed.value || 0) * 2.2;
      b.assistPower = Math.round(base + Math.sin(script.t * 1.7) * 6 + rand(-3, 3));
      b.motorPower = Math.round(b.assistPower * rand(1.6, 2.1));
    } else {
      b.assistPower = 0;
      b.motorPower = 0;
    }

    b.cadence = (s.confirmed.value || 0) > 0 ? Math.round(52 + Math.sin(script.t / 3) * 8) : 0;

    app._internal.changed();
  }

  /** 首次启动时铺一组示例数据，便于预览界面效果 */
  function seed() {
    const b = app.state.bike;
    Object.assign(b, {
      speed: 18.6,
      // avgSpeed / maxSpeed / trip 由 app 的统计模块实时累加，这里不预设
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