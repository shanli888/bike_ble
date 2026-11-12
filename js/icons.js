/* =========================================================================
 * icons.js — 内联 SVG 图标（无外部依赖，离线可用）
 * 用法：icons.svg('battery', {size:18})
 * ========================================================================= */
(function (root) {
  'use strict';

  const P = {
    // 助力面板
    assist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h18"/><circle cx="6" cy="13" r="2.6"/><circle cx="17" cy="10" r="2.2"/><path d="M8.6 13l4-4.5 3 2 2.4-2.5"/><path d="M3 16c2.5-1.5 5.5-2 9-2s6.5.5 9 2"/></svg>',
    commute:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="16" r="3.4"/><circle cx="18" cy="16" r="3.4"/><path d="M6 16l3.6-6h4L18 16"/><path d="M9.6 10l-1.2-2.4M13.6 10l1.8-2.8"/></svg>',
    exercise:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/><circle cx="6.5" cy="6.5" r="1.1"/><circle cx="17.5" cy="17.5" r="1.1"/><path d="M3.5 8.5l2-2M18.5 15.5l2-2"/></svg>',
    climbing:
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 19l6.5-10 3.5 5 2.5-3.5L22 19z"/></svg>',
    leisure:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l6.5 10.5h-13z"/><path d="M12 14v6"/><path d="M9.5 20h5"/></svg>',
    manual:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V7"/><path d="M5 16h5"/><path d="M10 16l5-9"/><path d="M13 20h7"/><path d="M16.5 20v-5"/><path d="M13 13h4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',

    // 卡片
    gyro: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.5 18.5L8.5 9l3 4.5L13.8 10l7.7 8.5z"/></svg>',
    battery: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="8" width="17" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="10" width="12" height="4.5" rx="1"/><rect x="20.2" y="10.4" width="1.8" height="3.6" rx=".7"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 13.8V5.5a2 2 0 014 0v8.3a4 4 0 11-4 0z" fill="currentColor" stroke="none"/><circle cx="12" cy="17.5" r="2.2" fill="#1a1e33" stroke="none"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2L5 13.5h5.5L10 22l8.5-11.5H13z"/></svg>',
    motorBolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.8h5.8L9.5 22 19 10.2h-5.9z"/></svg>',
    odo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 5c0 4.5 12 4.5 12 9s-12 4.5-12 9" opacity=".85"/><path d="M18 5c0 4.5-12 4.5-12 9s12 4.5 12 9" opacity=".85"/></svg>',

    // 导航 / 状态栏
    gauge:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.2 17.5a8.6 8.6 0 1115.6 0"/><path d="M12 13.2l4.2-4.4"/><circle cx="12" cy="14.2" r="1.5" fill="currentColor" stroke="none"/></svg>',
    bluetooth:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 7.5l9 9L12 21V3l4.5 4.5-9 9"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.6 1.6 0 00.32 1.77l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.6 1.6 0 00-1.77-.32 1.6 1.6 0 00-.97 1.47V21a2 2 0 11-4 0v-.09A1.6 1.6 0 009.18 19.4a1.6 1.6 0 00-1.77.32l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.6 1.6 0 004.9 15a1.6 1.6 0 00-1.47-.97H3.3a2 2 0 110-4h.09A1.6 1.6 0 004.9 9a1.6 1.6 0 00-.32-1.77l-.06-.06a2 2 0 112.83-2.83l.06.06A1.6 1.6 0 009.18 4.9h.09A1.6 1.6 0 0010.74 3.4V3.3a2 2 0 114 0v.09a1.6 1.6 0 00.97 1.47 1.6 1.6 0 001.77-.32l.06-.06a2 2 0 112.83 2.83l-.06.06A1.6 1.6 0 0019.4 9v.09a1.6 1.6 0 001.47.97h.09a2 2 0 110 4h-.09a1.6 1.6 0 00-1.47.94z"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 01-12 0z"/><path d="M12 18v3"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r=".9" fill="currentColor"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L21 19H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.8" r=".9" fill="currentColor"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-7-7 16-2.2-6.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    // 遥控器 / 闪控
    remote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><path d="M10 12.5h4"/><path d="M10 16h4"/><circle cx="9.2" cy="19" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r=".9" fill="currentColor" stroke="none"/><circle cx="14.8" cy="19" r=".9" fill="currentColor" stroke="none"/></svg>',
  };

  function svg(name, opts) {
    const o = opts || {};
    const s = o.size || 18;
    const src = P[name] || P.info;
    const sized = src.replace('<svg ', `<svg width="${s}" height="${s}" aria-hidden="true" focusable="false" `);
    return o.cls ? sized.replace('<svg ', `<svg class="${o.cls}" `) : sized;
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.icons = { svg, names: Object.keys(P) };
})(typeof globalThis !== 'undefined' ? globalThis : this);