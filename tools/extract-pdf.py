#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
抽取 PDF 文本（用于阅读厂家提供的协议/手册）

用法：python tools/extract-pdf.py <pdf路径> [输出txt路径]
"""
import os
import sys

from pypdf import PdfReader

if len(sys.argv) < 2:
    print('用法：python tools/extract-pdf.py <pdf路径> [输出txt路径]')
    sys.exit(1)

src = sys.argv[1]
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + '.txt'

reader = PdfReader(src)
print('页数：%d' % len(reader.pages))
parts = []
empty = 0
for i, page in enumerate(reader.pages, 1):
    try:
        t = page.extract_text() or ''
    except Exception as e:
        t = ''
        print('第 %d 页抽取异常：%s' % (i, e))
    if not t.strip():
        empty += 1
    parts.append('\n===== 第 %d 页 =====\n' % i + t)

text = ''.join(parts)
with open(dst, 'w', encoding='utf-8') as f:
    f.write(text)
print('已写入：%s（%d 字符）' % (os.path.abspath(dst), len(text)))
if empty:
    print('其中 %d 页无可抽取文本（可能是图片/扫描页）' % empty)
