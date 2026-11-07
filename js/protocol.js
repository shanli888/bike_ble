/* =========================================================================
 * protocol.js — 可参数化帧编解码器（帧头 / 长度 / 命令字 / 载荷 / 校验）
 *
 * 设计目标：在拿到真实协议文档之前，先用一个“外形可调”的解码器：
 *   - 帧头支持 1~2 字节（如 AA 55 / BF F8 / 55 AA）
 *   - 长度字段语义：整帧长度 / 载荷长度 / 命令+载荷长度 / 不含
 *   - 校验：无 / 累加和 / 异或 / CRC16-Modbus
 *   - 字节序：大端 / 小端
 * 拿到真实协议后，只需在「设置 → 协议参数」里改参数，或在 adapter 里覆盖。
 *
 * 纯函数，可在 Node 中单元测试。
 * ========================================================================= */
(function (root, factory) {
  const util = typeof module === 'object' && module.exports ? require('./util.js') : root.LVBU.util;
  const api = factory(util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.LVBU = root.LVBU || {}).protocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (util) {
  'use strict';

  const CHECKSUMS = ['none', 'sum', 'xor', 'crc16modbus'];
  const LEN_MODES = ['frame', 'payload', 'cmd_payload', 'none'];

  /* ---------------- 校验算法 ---------------- */

  function crc16Modbus(bytes, start = 0, end = bytes.length) {
    let crc = 0xffff;
    for (let i = start; i < end; i++) {
      crc ^= bytes[i] & 0xff;
      for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
      }
    }
    return crc & 0xffff;
  }

  function checksumSize(kind) {
    return kind === 'crc16modbus' ? 2 : kind === 'none' ? 0 : 1;
  }

  /** invsum 这类校验恒覆盖整帧（含帧头），不受 checksumIncludesHeader 影响 */
  function isFullFrameChecksum(kind) {
    return kind === 'invsum';
  }

  /** 计算校验值（返回字节数组） */
  function computeChecksum(kind, bytes, range, littleEndian) {
    const [s, e] = range;
    if (kind === 'none') return [];
    if (kind === 'crc16modbus') {
      const crc = crc16Modbus(bytes, s, e);
      return littleEndian ? [crc & 0xff, (crc >> 8) & 0xff] : [(crc >> 8) & 0xff, crc & 0xff];
    }
    let acc = kind === 'xor' ? 0 : 0;
    for (let i = s; i < e; i++) acc = kind === 'xor' ? acc ^ bytes[i] : (acc + bytes[i]) & 0xff;
    // invsum（累加和取反）：原厂协议 checksum = 0xFF - (sum & 0xFF)，覆盖整帧到载荷末尾
    if (kind === 'invsum') return [(0xff - acc) & 0xff];
    return [acc & 0xff];
  }

  function verifyChecksum(kind, bytes, range, expected, littleEndian) {
    if (kind === 'none') return true;
    const calc = computeChecksum(kind, bytes, range, littleEndian);
    if (calc.length !== expected.length) return false;
    return calc.every((b, i) => b === expected[i]);
  }

  /* ---------------- 帧构建 ---------------- */

  /**
   * @param cfg  协议配置（见 DEFAULT_PROTOCOL）
   * @param opts { cmd:number, payload?:Uint8Array|number[], includeLen?:boolean }
   * @returns Uint8Array 完整帧
   */
  function buildFrame(cfg, { cmd = 0, payload = [], includeLen = true, noChecksum = false } = {}) {
    const header = util.toBytes(cfg.header);
    const payloadBytes = util.toBytes(payload);
    const cmdBytes = cfg.cmdSize === 2 ? [cmd & 0xff, (cmd >> 8) & 0xff] : [cmd & 0xff];
    const csKind = noChecksum ? 'none' : cfg.checksum;
    const csLen = checksumSize(csKind);

    const hasLenByte = includeLen && cfg.lenMode !== 'none';
    // 先按 selftest 的定义计算长度值（三种模式都是“整帧长度减去自身 1 字节”）：
    //   frame       = 整帧长度 - 1
    //   payload     = 仅载荷长度
    //   cmd_payload = 命令字 + 载荷长度
    // 若目标设备要求长度字段包含自身，把 lenFieldAdjust 设为 1 即可。
    const lenBase = (mode, pl) => {
      // 长度字段包含自身（这是“帧总长”字段最常见的实现）
      const c = hasLenByte ? 1 : 0;
      if (mode === 'payload') return pl;
      if (mode === 'cmd_payload') return (cfg.cmdSize || 1) + pl;
      return header.length + c + (cfg.cmdSize || 1) + pl + csLen;
    };

    let lenValue = hasLenByte ? lenBase(cfg.lenMode, payloadBytes.length) : 0;
    const total = header.length + (hasLenByte ? 1 : 0) + (cfg.cmdSize || 1) + payloadBytes.length + csLen;
    const frame = new Uint8Array(total);

    let p = 0;
    frame.set(header, p);
    p += header.length;
    if (hasLenByte) {
      frame[p] = lenValue & 0xff;
      p += 1;
    }
    frame[p] = cmdBytes[0];
    if (cfg.cmdSize === 2) frame[p + 1] = cmdBytes[1];
    p += cfg.cmdSize || 1;
    frame.set(payloadBytes, p);
    p += payloadBytes.length;

    if (csLen) {
      // 累加/xor 通常只覆盖帧头之后（不含帧头）；crc16/invsum 覆盖从帧头到载荷末尾。
      const start = isFullFrameChecksum(csKind) || cfg.checksumIncludesHeader ? 0 : header.length;
      const cs = computeChecksum(csKind, frame, [start, p], cfg.littleEndian);
      frame.set(cs, p);
      p += csLen;
    }
    return frame;
  }

  /* ---------------- 流式解析 ---------------- */

  /**
   * 创建有状态解析器。notify 数据可能被拆分/合并，解析器负责缓存与重同步。
   * @param cfg 协议配置
   * @param onFrame (frame) => void ; frame = { raw, cmd, payload, len, validChecksum }
   */
  function createParser(cfg, onFrame, onDrop) {
    const header = util.toBytes(cfg.header);
    let buf = new Uint8Array(0);
    const stats = { frames: 0, badChecksum: 0, droppedBytes: 0, lenAutoFix: 0 };
    // 长度字段语义自适应：默认“含自身”；若连续两次长度不符而“不含自身”恰好通过校验，
    // 说明真实设备用的是 len = 总长-1，于是自动纠正并锁定。
    let lenAdjust = cfg.lenFieldAdjust || 0;

    function push(chunk) {
      const c = util.toBytes(chunk);
      if (!c.length) return;
      const merged = new Uint8Array(buf.length + c.length);
      merged.set(buf, 0);
      merged.set(c, buf.length);
      buf = merged;
      drain();
    }

    function drop(n) {
      if (n <= 0) return;
      stats.droppedBytes += n;
      buf = buf.slice(n);
      if (onDrop) onDrop(n);
    }

    function indexOfHeader() {
      const h0 = header[0];
      const h1 = header.length > 1 ? header[1] : null;
      for (let i = 0; i <= buf.length - header.length; i++) {
        if (buf[i] !== h0) continue;
        if (h1 != null && buf[i + 1] !== h1) continue;
        return i;
      }
      // 保留最多 header.length-1 字节，等待可能的帧头跨包
      return buf.length - (header.length - 1);
    }

    function lengthValueAt(idx) {
      // idx 指向长度字段
      const hasLen = cfg.lenMode !== 'none';
      if (!hasLen) return null;
      return buf[idx];
    }

    function drain() {
      let guard = 0;
      while (guard++ < 256) {
        const idx = indexOfHeader();
        if (idx > 0) drop(idx);
        if (buf.length < header.length) return;

        const csLen = checksumSize(cfg.checksum);
        const hasLen = cfg.lenMode !== 'none';
        const fixedLen = header.length + (hasLen ? 1 : 0) + (cfg.cmdSize || 1) + csLen;

        if (hasLen && buf.length < header.length + 1) return;
        const lenVal = hasLen ? lengthValueAt(header.length) : 0;
        let total;
        if (!hasLen) {
          // 无长度字段：整帧长度 = 固定长度（仅命令，无载荷）
          total = fixedLen;
        } else if (cfg.lenMode === 'frame') {
          total = lenVal + lenAdjust;
          if (total < fixedLen || total > (cfg.maxFrame || 512)) {
            // 长度不合理：尝试另一种长度语义（len = 总长-1 / len = 总长）
            const alt = lenVal + (lenAdjust === 0 ? 1 : lenAdjust === 1 ? -1 : 0);
            if (alt >= fixedLen && alt <= (cfg.maxFrame || 512) && buf.length >= alt) {
              total = alt;
            }
          }
        } else if (cfg.lenMode === 'payload') {
          total = header.length + 1 + (cfg.cmdSize || 1) + lenVal + csLen;
        } else {
          // cmd_payload
          total = header.length + 1 + lenVal + csLen;
        }

        if (total < fixedLen || total > (cfg.maxFrame || 512)) {
          drop(1); // 长度不合理，重新同步
          continue;
        }
        if (buf.length < total) return; // 等待更多数据

        const raw = buf.slice(0, total);
        let p = header.length;
        if (hasLen) p += 1;
        const cmd = cfg.cmdSize === 2 ? raw[p] | (raw[p + 1] << 8) : raw[p];
        p += cfg.cmdSize || 1;
        const payload = raw.slice(p, total - csLen);
        // invsum 恒覆盖整帧（含帧头）
        const csStart = isFullFrameChecksum(cfg.checksum) || cfg.checksumIncludesHeader ? 0 : header.length;
        const csBytes = Array.from(raw.slice(total - csLen));
        const csRange = [csStart, total - csLen];
        const valid = verifyChecksum(cfg.checksum, raw, csRange, csBytes, cfg.littleEndian);

        // 另一种常见约定：累加和覆盖整帧（含帧头）。主约定失败时再试一次。
        let validAlt = valid;
        if (!valid && csLen === 1) {
          validAlt = verifyChecksum(cfg.checksum, raw, [0, total - csLen], csBytes, cfg.littleEndian);
        }

        if (codec.wantChecksum && !validAlt) {
          stats.badChecksum++;
          codec.lastBadFrame = util.bytesToHex(raw);
          // 校验失败：丢弃 1 字节重新同步。若丢整帧，可能吞掉紧随其后的好帧
          // （长度字段被噪声误导时）；丢 1 字节最多多试几次，且统计 badChecksum。
          drop(1);
          continue;
        }

        drop(total);
        stats.frames++;
        onFrame({ raw, cmd, payload, len: lenVal, validChecksum: validAlt });
        if (buf.length < header.length) return;
      }
    }

    function reset() {
      buf = new Uint8Array(0);
    }

    const codec = { push, reset, stats, setConfig(newCfg) { Object.assign(cfg, newCfg); }, wantChecksum: true };
    return codec;
  }

  /* ---------------- 数据字段读取工具 ---------------- */

  function readUInt(bytes, offset, size, littleEndian) {
    if (offset + size > bytes.length) return null;
    let v = 0;
    if (littleEndian) {
      for (let i = size - 1; i >= 0; i--) v = v * 256 + bytes[offset + i];
    } else {
      for (let i = 0; i < size; i++) v = v * 256 + bytes[offset + i];
    }
    return v;
  }

  function readInt(bytes, offset, size, littleEndian) {
    const u = readUInt(bytes, offset, size, littleEndian);
    if (u == null) return null;
    const bits = size * 8;
    const half = Math.pow(2, bits - 1);
    return u >= half ? u - half * 2 : u;
  }

  const FIELD_TYPES = {
    u8: { size: 1 },
    i8: { size: 1, signed: true },
    u16: { size: 2 },
    i16: { size: 2, signed: true },
    u32: { size: 4 },
    i32: { size: 4, signed: true },
  };

  /**
   * 按字段表解析载荷。
   * @param payload Uint8Array
   * @param fields [{ key, type:'u8|u16|u32|i16|i32', offset, scale?, offsetValue?, le?, enum? }]
   * @param littleEndian 全局默认字节序
   * @returns { values, missing:[key] }
   */
  function parseFields(payload, fields, littleEndian = false) {
    const values = {};
    const missing = [];
    for (const f of fields) {
      const t = FIELD_TYPES[f.type];
      if (!t) continue;
      const le = f.le != null ? f.le : littleEndian;
      const raw = t.signed ? readInt(payload, f.offset, t.size, le) : readUInt(payload, f.offset, t.size, le);
      if (raw == null) {
        missing.push(f.key);
        continue;
      }
      let v = raw;
      if (f.scale != null) v = v * f.scale;
      if (f.add != null) v = v + f.add;
      if (f.clamp) v = util.clamp(v, f.clamp[0], f.clamp[1]);
      values[f.key] = v;
    }
    return { values, missing };
  }

  return {
    CHECKSUMS,
    LEN_MODES,
    crc16Modbus,
    checksumSize,
    computeChecksum,
    verifyChecksum,
    buildFrame,
    createParser,
    readUInt,
    readInt,
    parseFields,
    FIELD_TYPES,
  };
});