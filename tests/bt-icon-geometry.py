"""分析蓝牙已连接图标的几何布局，验证圆点相对符号的位置。"""

# viewBox: 0 0 24 24
# 符号路径: M9.6 10.6 l4.8 4.8 L12 17.6 V6.4 l2.4 2.2 -4.8 4.8
symbol = {
    "start_left": (9.6, 10.6),
    "right_bottom": (14.4, 15.4),
    "bottom": (12, 17.6),
    "top": (12, 6.4),
    "right_top": (14.4, 8.6),
    "center": (9.6, 13.4),
}

dots = {
    "left_dot": (5.2, 12.0, 1.5),
    "right_dot": (18.8, 12.0, 1.5),
}

xs = [p[0] for p in symbol.values()]
ys = [p[1] for p in symbol.values()]
sx1, sx2 = min(xs), max(xs)
sy1, sy2 = min(ys), max(ys)

print("=== 蓝牙符号包围盒 ===")
print(f"x: {sx1} .. {sx2}  (宽 {sx2 - sx1})")
print(f"y: {sy1} .. {sy2}  (高 {sy2 - sy1})")
print(f"符号垂直中心 y = {(sy1 + sy2) / 2}")
print(f"符号水平中心 x = {(sx1 + sx2) / 2}")
print()

print("=== 圆点位置 ===")
for name, (cx, cy, r) in dots.items():
    print(f"{name}: 圆心 ({cx}, {cy})  半径 {r}  → 范围 x {cx - r}..{cx + r}, y {cy - r}..{cy + r}")

print()
print("=== 对齐校验 ===")
sym_cy = (sy1 + sy2) / 2
ok = True
for name, (cx, cy, r) in dots.items():
    diff = cy - sym_cy
    aligned = abs(diff) < 0.5
    ok = ok and aligned
    print(f"{name} 与符号垂直中心偏差: {diff:+.2f}px  ({'✅ 对齐' if aligned else '⚠️ 偏移'})")

print()
print("=== 间距校验（点与符号边缘） ===")
gap_l = sx1 - (dots["left_dot"][0] + dots["left_dot"][2])
gap_r = (dots["right_dot"][0] - dots["right_dot"][2]) - sx2
print(f"左点右边缘 {dots['left_dot'][0] + dots['left_dot'][2]:.2f} → 符号左边 {sx1}  间距 {gap_l:.2f}px")
print(f"符号右边 {sx2} → 右点左边缘 {dots['right_dot'][0] - dots['right_dot'][2]:.2f}  间距 {gap_r:.2f}px")
print(f"左右间距对称: {'✅' if abs(gap_l - gap_r) < 0.3 else '⚠️ 不对称'}")

print()
print("=== 整体包围盒 ===")
all_x1 = min(sx1, min(c[0] - c[2] for c in dots.values()))
all_x2 = max(sx2, max(c[0] + c[2] for c in dots.values()))
all_y1 = min(sy1, min(c[1] - c[2] for c in dots.values()))
all_y2 = max(sy2, max(c[1] + c[2] for c in dots.values()))
print(f"x: {all_x1} .. {all_x2}  (宽 {all_x2 - all_x1})")
print(f"y: {all_y1} .. {all_y2}  (高 {all_y2 - all_y1})")
print(f"内容中心: ({(all_x1 + all_x2) / 2}, {(all_y1 + all_y2) / 2})  — viewBox 中心 (12, 12)")
print()
l, r = all_x1, 24 - all_x2
t, b = all_y1, 24 - all_y2
print(f"左边距 {l:.2f}  右边距 {r:.2f}  {'✅ 对称' if abs(l - r) < 0.3 else '⚠️'}")
print(f"上边距 {t:.2f}  下边距 {b:.2f}  {'✅ 对称' if abs(t - b) < 0.3 else '⚠️'}")
print()
if ok and abs(l - r) < 0.3 and abs(t - b) < 0.3:
    print("✅ 全部通过：圆点与符号垂直居中对齐，整体在 viewBox 中居中")
else:
    print("⚠️ 仍有偏差需要修正")