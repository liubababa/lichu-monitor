#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把图片转成"可读"的文字描述，用于无视觉模型时判断画面内容。

输出四段：
  1) 色块图   —— 每格一个字母代表颜色（K黑 :深灰 .中灰 -浅灰 空格=白/亮
                 R红 O橙 Y黄 G绿 C青 B蓝 P紫 M品红 N棕）
  2) 形状图   —— 边缘密度（# 强边 + 次强 . 弱边 空白=平坦），看轮廓与结构
  3) 区域清单 —— 连通色块：面积占比、外接框（相对坐标）、主色、长宽比
  4) 主色板   —— 占比前 10 的颜色（含十六进制）

用法：python image-look.py <图片路径> [列数=72] [行数=auto]
"""
import sys, io
from collections import Counter, deque
from PIL import Image, ImageFilter

# 控制台按 UTF-8 输出，避免中文乱码
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

CH = {'K': 'K', 'DK': ':', 'MD': '.', 'LT': '-', 'WH': ' ', 'RD': 'R', 'OR': 'O',
      'YL': 'Y', 'GN': 'G', 'CY': 'C', 'BL': 'B', 'PU': 'P', 'MG': 'M', 'BR': 'N'}


def classify(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    lum = (r * 299 + g * 587 + b * 114) / 1000
    sat = 0 if mx == 0 else (mx - mn) / float(mx)
    if sat < 0.20 or lum < 40:
        if lum < 45: return 'K'
        if lum < 100: return ':'
        if lum < 170: return '.'
        if lum < 228: return '-'
        return ' '
    if mx == r:
        if g > b * 1.25 and r > g * 1.12: return 'O'
        if b > g * 1.25: return 'M'
        return 'N' if lum < 110 else 'R'
    if mx == g:
        if r > b * 1.2 and r > g * .92: return 'Y'
        if b > r * 1.25: return 'C'
        return 'G'
    # mx == b
    if r > g * 1.15: return 'P'
    if g > r * 1.25 and lum > 90: return 'C'
    return 'B'


def main():
    path = sys.argv[1]
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 72
    im = Image.open(path).convert('RGB')
    w, h = im.size
    rows = max(6, int(cols * h / float(w) / 2.0))
    # 同时把报告写成 UTF-8 文件（控制台编码常把中文转坏，读文件更稳）
    out = open(path + '.look.txt', 'w', encoding='utf-8')
    def P(s=''):
        print(s)
        out.write(s + '\n')
    P('图片：%s  原始 %dx%d  分析网格 %d列 x %d行' % (path, w, h, cols, rows))

    small = im.resize((cols, rows))
    px = small.load()

    # 1) 色块图
    P('\n=== 色块图（每格一色）===')
    grid = []
    for y in range(rows):
        line = ''
        for x in range(cols):
            c = classify(*px[x, y])
            line += c
        grid.append(line)
        P('%3d %s' % (y, line))

    # 2) 形状图：先在原图算边缘，再按格取"最大"（缩放取平均会把边缘抹平）
    edge = im.convert('L').filter(ImageFilter.FIND_EDGES)
    ew, eh = edge.size
    ep = edge.load()
    P('\n=== 形状图（#强 +中 .弱 空=平坦）===')
    for gy in range(rows):
        line = ''
        y0 = int(gy * eh / rows); y1 = max(y0 + 1, int((gy + 1) * eh / rows))
        for gx in range(cols):
            x0 = int(gx * ew / cols); x1 = max(x0 + 1, int((gx + 1) * ew / cols))
            mx = 0
            stepy = max(1, (y1 - y0) // 6); stepx = max(1, (x1 - x0) // 6)
            for yy in range(y0, y1, stepy):
                for xx in range(x0, x1, stepx):
                    v = ep[xx, yy]
                    if v > mx: mx = v
            line += '#' if mx > 110 else ('+' if mx > 60 else ('.' if mx > 28 else ' '))
        P('%3d %s' % (gy, line))

    # 3) 区域清单（在粗网格上做连通聚类）
    q = im.resize((max(24, cols // 2), max(12, rows // 2)))
    qw, qh = q.size
    qp = q.load()
    lab = [[None] * qw for _ in range(qh)]
    regions = []
    for yy in range(qh):
        for xx in range(qw):
            if lab[yy][xx] is not None:
                continue
            r, g, b = qp[xx, yy]
            seed = classify(r, g, b)
            cells = []
            dq = deque([(xx, yy)])
            lab[yy][xx] = len(regions)
            while dq:
                cx, cy = dq.popleft()
                cells.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < qw and 0 <= ny < qh and lab[ny][nx] is None:
                        rr, gg, bb = qp[nx, ny]
                        if classify(rr, gg, bb) == seed:
                            lab[ny][nx] = len(regions)
                            dq.append((nx, ny))
            if len(cells) < max(6, qw * qh * 0.004):
                continue
            xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
            cr = sum(qp[c[0], c[1]][0] for c in cells) / len(cells)
            cg = sum(qp[c[0], c[1]][1] for c in cells) / len(cells)
            cb = sum(qp[c[0], c[1]][2] for c in cells) / len(cells)
            regions.append({
                'area': len(cells) / float(qw * qh), 'ch': seed,
                'x0': min(xs) / qw, 'x1': (max(xs) + 1) / qw,
                'y0': min(ys) / qh, 'y1': (max(ys) + 1) / qh,
                'rgb': (int(cr), int(cg), int(cb))})
    regions.sort(key=lambda r: -r['area'])
    P('\n=== 区域清单（面积占比 >=0.4%%，最多 18 条）===')
    for r in regions[:18]:
        bw = r['x1'] - r['x0']; bh = r['y1'] - r['y0']
        shape = '横长条' if bw / max(bh, .01) > 2.2 else ('竖长条' if bh / max(bw, .01) > 2.2 else '近方形')
        P('  色%-2s 占比%4.1f%%  x %4.2f-%4.2f  y %4.2f-%4.2f  %s  #%02x%02x%02x' % (
            r['ch'], r['area'] * 100, r['x0'], r['x1'], r['y0'], r['y1'], shape, *r['rgb']))

    # 4) 主结构线：找"长直边"（水平/垂直），用于判断建筑轮廓与比例
    ew2, eh2 = edge.size
    scale = max(1, ew2 // 420)
    ew3, eh3 = ew2 // scale, eh2 // scale
    if ew3 > 8 and eh3 > 8:
        e3 = edge.resize((ew3, eh3))
        e3p = e3.load()
        T = 55
        hlines = []
        for y in range(eh3):
            best = cur = 0; bs = cs = 0
            for x in range(ew3):
                if e3p[x, y] > T:
                    if cur == 0: cs = x
                    cur += 1
                    if cur > best: best, bs = cur, cs
                else:
                    cur = 0
            if best > ew3 * 0.18:
                hlines.append((best / float(ew3), y / float(eh3), bs / float(ew3), (bs + best) / float(ew3)))
        vlines = []
        for x in range(ew3):
            best = cur = 0; bs = cs = 0
            for y in range(eh3):
                if e3p[x, y] > T:
                    if cur == 0: cs = y
                    cur += 1
                    if cur > best: best, bs = cur, cs
                else:
                    cur = 0
            if best > eh3 * 0.18:
                vlines.append((best / float(eh3), x / float(ew3), bs / float(eh3), (bs + best) / float(eh3)))
        hlines.sort(key=lambda t: -t[0]); vlines.sort(key=lambda t: -t[0])
        P('\n=== 主结构线（长直边，前 8 条）===')
        for ln, pos, a, b in hlines[:8]:
            P('  水平  y=%.2f  x 从 %.2f 到 %.2f  占宽 %.0f%%' % (pos, a, b, ln * 100))
        for ln, pos, a, b in vlines[:8]:
            P('  竖直  x=%.2f  y 从 %.2f 到 %.2f  占高 %.0f%%' % (pos, a, b, ln * 100))

    # 5) 主色板
    pal = Counter()
    for y in range(rows):
        for x in range(cols):
            pal[px[x, y]] += 1
    P('\n=== 主色板 ===')
    for c, n in pal.most_common(10):
        P('  #%02x%02x%02x  %4.1f%%  (%s)' % (c[0], c[1], c[2], 100.0 * n / (rows * cols), classify(*c)))


if __name__ == '__main__':
    main()
