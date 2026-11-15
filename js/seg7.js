/* =========================================================================
 * seg7.js — 七段数码管渲染（纯 SVG，无外部字体依赖）
 *
 * 每个数字由 7 个斜切多边形段组成：
 *     ─A─
 *    │   │
 *    F   B
 *    │   │
 *     ─G─
 *    │   │
 *    E   C
 *    │   │
 *     ─D─
 *
 * 用法：
 *   seg7.digits('18.6', { h: 200 })   → <svg> 字符串
 *   seg7.digits('06.9', { h: 54, on: 'dim' })  → 小尺寸灰色数码管
 * ========================================================================= */
(function (root) {
  'use strict';

  /* 每个数字点亮哪些段 */
  const MAP = {
    '0': 'ABCDEF',
    '1': 'BC',
    '2': 'ABGED',
    '3': 'ABGCD',
    '4': 'FGBC',
    '5': 'AFGCD',
    '6': 'AFGEDC',
    '7': 'ABC',
    '8': 'ABCDEFG',
    '9': 'ABCDFG',
    '-': 'G',
    ' ': '',
  };

  /* 单段几何（以 0..W × 0..H 为坐标系，斜切角 T） */
  const W = 60;    // 位宽
  const H = 120;   // 位高
  const T = 7;     // 斜切尺寸
  const G = 3;     // 段与段之间的缝隙

  function seg(x, y, w, h, o) {
    // 生成带斜切角的六边形段
    const t = T;
    let pts;
    switch (o) {
      case 'h': // 水平段
        pts = [
          [x + t, y], [x + w - t, y], [x + w, y + h / 2],
          [x + w - t, y + h], [x + t, y + h], [x, y + h / 2],
        ];
        break;
      case 'v': // 垂直段
        pts = [
          [x + w / 2, y], [x + w, y + t], [x + w, y + h - t],
          [x + w / 2, y + h], [x, y + h - t], [x, y + t],
        ];
        break;
      default:
        pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
    return pts.map((p) => p.join(',')).join(' ');
  }

  /**
   * 生成一个数字/符号的 SVG 组。
   * @param {string} ch 字符
   * @param {number} ox 该位的 x 偏移
   * @param {string} onColor 点亮色
   * @param {string} offColor 熄灭色
   * @param {number} opacity 未点亮段的透明度
   */
  function glyph(ch, ox, onColor, offColor, offOpacity) {
    const lit = MAP[ch] != null ? MAP[ch] : '';
    const sw = W / 2;              // 段的粗细
    const hw = (W - sw) / 2;       // 水平段半宽外沿
    const vh = (H - 3 * sw) / 2 + sw / 2; // 垂直段高度

    // 各段的矩形区域（x, y, w, h, 方向）
    const rects = {
      A: [ox + G, 0, W - 2 * G, sw, 'h'],
      B: [ox + W - sw, sw / 2 + G / 2, sw, vh - G, 'v'],
      C: [ox + W - sw, H / 2 + sw / 2 + G, sw, vh - G, 'v'],
      D: [ox + G, H - sw, W - 2 * G, sw, 'h'],
      E: [ox, H / 2 + sw / 2 + G, sw, vh - G, 'v'],
      F: [ox, sw / 2 + G / 2, sw, vh - G, 'v'],
      G: [ox + G, H / 2 - sw / 2, W - 2 * G, sw, 'h'],
    };

    let out = '';
    for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const r = rects[key];
      const isOn = lit.includes(key);
      const fill = isOn ? onColor : offColor;
      const op = isOn ? 1 : offOpacity;
      out += `<polygon points="${seg(r[0], r[1], r[2], r[3], r[4])}" fill="${fill}" opacity="${op}"/>`;
    }
    return out;
  }

  /**
   * 渲染数码管字符串。
   * @param {string} text 要显示的文本（支持 0-9 . - 空格）
   * @param {object} opts
   *   h       数字总高度（px），默认 120
   *   color   点亮色，默认 #fff
   *   off     熄灭段颜色，默认 #1e2438
   *   offOp   熄灭段透明度，默认 0.9
   *   glow    是否加发光，默认 true
   */
  function digits(text, opts) {
    const o = opts || {};
    const str = String(text == null ? '' : text);
    const h = o.h || 120;
    const onColor = o.color || '#ffffff';
    const offColor = o.off || '#1b2134';
    const offOpacity = o.offOp != null ? o.offOp : 0.85;
    const glow = o.glow !== false;

    const scale = h / H;
    const digitW = W;
    const dotW = W * 0.34;
    const gapW = W * 0.10;

    // 计算总宽
    let totalW = 0;
    for (const ch of str) {
      if (ch === '.') totalW += dotW + gapW;
      else totalW += digitW + gapW;
    }
    totalW = Math.max(0, totalW - gapW);

    let x = 0;
    let body = '';
    for (const ch of str) {
      if (ch === '.') {
        // 小数点：一个圆
        const r = W * 0.12;
        body += `<circle cx="${x + dotW / 2}" cy="${H - r}" r="${r}" fill="${onColor}"/>`;
        x += dotW + gapW;
      } else {
        body += glyph(ch, x, onColor, offColor, offOpacity);
        x += digitW + gapW;
      }
    }

    const filter = glow
      ? `<defs><filter id="s7glow" x="-30%" y="-30%" width="160%" height="160%">
           <feGaussianBlur stdDeviation="2.4" result="b"/>
           <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
         </filter></defs>`
      : '';

    return `<svg class="seg7" viewBox="0 0 ${totalW} ${H}" width="${(totalW * scale).toFixed(1)}" height="${h}" ${glow ? 'filter="url(#s7glow)"' : ''} preserveAspectRatio="xMidYMid meet" aria-hidden="true">${filter}${body}</svg>`;
  }

  root.LVBU = root.LVBU || {};
  root.LVBU.seg7 = { digits, MAP };
})(typeof globalThis !== 'undefined' ? globalThis : this);