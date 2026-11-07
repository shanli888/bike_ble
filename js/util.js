/* =========================================================================
 * util.js — 通用工具（无副作用，可被 Node 直接 require 做单元测试）
 * ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.LVBU = root.LVBU || {}).util = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 16 位 UUID 展开为完整 128 位形式 */
  function expandUuid(uuid) {
    if (!uuid) return '';
    let u = String(uuid).trim().toLowerCase();
    if (u.startsWith('0x')) u = u.slice(2);
    if (u.length === 4) return '0000' + u + '-0000-1000-8000-00805f9b34fb';
    if (u.length === 8) return u + '-0000-1000-8000-00805f9b34fb';
    return u;
  }

  /** 是否相同 UUID（任一形式） */
  function uuidEq(a, b) {
    return expandUuid(a) === expandUuid(b);
  }

  /** 短形式显示：0000180f-… -> 180f（其它保持原样） */
  function shortUuid(uuid) {
    const u = expandUuid(uuid);
    if (/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.test(u)) return u.slice(4, 8);
    return u;
  }

  function toBytes(value) {
    if (value == null) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value);
    return new Uint8Array(0);
  }

  /** "AA 55 04 …" / "0xAA,0x55" / "AA55" -> Uint8Array；非法返回 null */
  function hexToBytes(text, { allowBracket = true } = {}) {
    if (typeof text !== 'string') return null;
    let s = text.replace(allowBracket ? /[\[\](){}]/g : /$^/g, ' ');
    if (/0\s*x/i.test(s)) s = s.replace(/0\s*x/gi, ' ');
    s = s.replace(/(^|[^0-9a-f])#/gi, '$1 ').replace(/[^0-9a-fA-F]/g, '');
    if (!s.length || s.length % 2) return null;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes, sep = ' ') {
    return Array.from(toBytes(bytes), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(sep);
  }

  /** 安全解码字符串（去不可打印字符） */
  function decodeText(bytes) {
    const b = toBytes(bytes);
    try {
      return new TextDecoder('utf-8').decode(b).replace(/[\u0000-\u001f\uFFFD]/g, '').trim();
    } catch (_) {
      return Array.from(b, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();
    }
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function roundTo(v, step) {
    if (!step || step <= 0) return v;
    return Math.round(v / step) * step;
  }

  /** 数字格式化：固定小数位，去掉 -0 */
  function fixed(v, digits) {
    if (v == null || !isFinite(v)) return '--';
    const s = Number(v).toFixed(digits);
    return s === '-' + (0).toFixed(digits) ? (0).toFixed(digits) : s;
  }

  function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object') return base;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      if (pv && typeof pv === 'object' && !Array.isArray(pv) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], pv);
      } else if (pv !== undefined) {
        out[k] = pv;
      }
    }
    return out;
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function nowHMS(ms = Date.now()) {
    const d = new Date(ms);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  /** 带超时的 Promise */
  function withTimeout(promise, ms, label = 'operation') {
    let t;
    return Promise.race([
      promise,
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`${label} 超时 (${ms}ms)`)), ms);
      }),
    ]).finally(() => clearTimeout(t));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 串行队列：保证 BLE 写入不并发 */
  function createQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
      const run = tail.then(task, task);
      tail = run.catch(() => {});
      return run;
    };
  }

  return {
    expandUuid,
    uuidEq,
    shortUuid,
    toBytes,
    hexToBytes,
    bytesToHex,
    decodeText,
    clamp,
    roundTo,
    fixed,
    deepMerge,
    fnv1a,
    nowHMS,
    withTimeout,
    sleep,
    createQueue,
  };
});