// 校验收紧后的 viewBox：内容应居中且填满
// 原 viewBox 0 0 96 96，内容包围盒 x 12..78, y 10..72
// 新 viewBox "9 7 72 68"

const NEW_VB = { x: 9, y: 7, w: 72, h: 68 };

// 含描边的真实内容边界（外弧最大范围）
const content = { x1: 12, x2: 78, y1: 10, y2: 72 };

console.log('=== 收紧后的 viewBox 校验 ===');
console.log(`viewBox: "${NEW_VB.x} ${NEW_VB.y} ${NEW_VB.w} ${NEW_VB.h}"`);
console.log('');

const left = content.x1 - NEW_VB.x;
const right = NEW_VB.x + NEW_VB.w - content.x2;
const top = content.y1 - NEW_VB.y;
const bottom = NEW_VB.y + NEW_VB.h - content.y2;

console.log(`左留白 ${left}px   右留白 ${right}px   （差 ${Math.abs(left - right)}px）`);
console.log(`上留白 ${top}px   下留白 ${bottom}px   （差 ${Math.abs(top - bottom)}px）`);
console.log('');

const fillW = ((content.x2 - content.x1) / NEW_VB.w) * 100;
const fillH = ((content.y2 - content.y1) / NEW_VB.h) * 100;
console.log(`填充率: 横向 ${fillW.toFixed(1)}%  纵向 ${fillH.toFixed(1)}%`);
console.log(`相对提升: 横向 ${(fillW - 68.8).toFixed(1)} 个百分点，纵向 ${(fillH - 64.6).toFixed(1)} 个百分点`);
console.log('');

if (Math.abs(left - right) <= 1 && Math.abs(top - bottom) <= 1) {
  console.log('✅ 内容已居中，四边留白均匀');
} else {
  console.log('⚠️ 仍有不对称');
}