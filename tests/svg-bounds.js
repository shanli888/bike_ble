// 分析闪控 SVG 的实际内容边界
// viewBox: 0 0 96 96
// 几何元素：
//   主圆: 圆心 (38, 46)，半径 26，stroke 无 → x 12..64, y 20..72
//   上下三角: y 23..69，x 31..45
//   左右三角: x 15..61，y 39..53
//   内弧: (68,35) → (53,18)，stroke-width 4.5 → 向外扩 2.25
//   外弧: (76,32) → (59,12)，stroke-width 4.5 → 向外扩 2.25

const items = [
  { name: '主圆', x1: 12, x2: 64, y1: 20, y2: 72 },
  { name: '上三角', x1: 31, x2: 45, y1: 23, y2: 34 },
  { name: '下三角', x1: 31, x2: 45, y1: 58, y2: 69 },
  { name: '左三角', x1: 15, x2: 26, y1: 39, y2: 53 },
  { name: '右三角', x1: 50, x2: 61, y1: 39, y2: 53 },
  { name: '内弧(含描边)', x1: 51, x2: 70, y1: 16, y2: 37 },
  { name: '外弧(含描边)', x1: 57, x2: 78, y1: 10, y2: 34 },
];

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const it of items) {
  minX = Math.min(minX, it.x1);
  maxX = Math.max(maxX, it.x2);
  minY = Math.min(minY, it.y1);
  maxY = Math.max(maxY, it.y2);
}

const VB = 96;
console.log('=== SVG 内容边界 (viewBox 0 0 96 96) ===');
for (const it of items) {
  console.log(
    `${it.name.padEnd(14)} x ${String(it.x1).padStart(2)}..${String(it.x2).padEnd(2)}  y ${String(it.y1).padStart(2)}..${String(it.y2).padEnd(2)}`
  );
}
console.log('');
console.log(`实际内容包围盒: x ${minX}..${maxX} (宽 ${maxX - minX}), y ${minY}..${maxY} (高 ${maxY - minY})`);
console.log(`viewBox:        ${VB} x ${VB}`);
console.log('');
console.log(`左留白 ${minX}px (${((minX / VB) * 100).toFixed(1)}%)   右留白 ${VB - maxX}px (${(((VB - maxX) / VB) * 100).toFixed(1)}%)`);
console.log(`上留白 ${minY}px (${((minY / VB) * 100).toFixed(1)}%)   下留白 ${VB - maxY}px (${(((VB - maxY) / VB) * 100).toFixed(1)}%)`);
console.log('');
const fillW = ((maxX - minX) / VB) * 100;
const fillH = ((maxY - minY) / VB) * 100;
console.log(`内容填充率: 横向 ${fillW.toFixed(1)}%, 纵向 ${fillH.toFixed(1)}%`);
console.log('');
if (minY < VB - maxY) {
  console.log(`⚠️ 上下不对称：上留白 ${minY}，下留白 ${VB - maxY}，视觉重心偏上 ${((VB - maxY - minY) / 2).toFixed(1)}px`);
}
console.log('');
console.log('=== 建议 ===');
console.log(`紧凑 viewBox: "${minX - 1} ${minY - 1} ${maxX - minX + 2} ${maxY - minY + 2}"`);
console.log(`内容宽高比: ${((maxX - minX) / (maxY - minY)).toFixed(3)}`);