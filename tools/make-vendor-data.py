#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把抓取到的厂家数据（含 VENDOR_JSON_START/END 标记）转成 js/vendor-data.js"""
import json
import os
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.environ.get('TEMP', ''), '..', 'commandcode',
    'H--dianzhan', 'VG40_igf5Kd5cXClK0Gz6', 'scratchpad', 'vendor-raw.txt')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'js', 'vendor-data.js')

text = open(SRC, encoding='utf-8').read()
a = text.find('VENDOR_JSON_START>>>') + len('VENDOR_JSON_START>>>')
b = text.find('<<<VENDOR_JSON_END')
raw = text[a:b].strip()
# 去掉 JS 字符串里的转义（\" -> "，\\ 保留）
raw = raw.replace('\\"', '"')
data = json.loads(raw)          # 解析失败会直接报错，便于发现问题
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('/* 厂家平台（ess-ds.com）数据快照 —— 抓取脚本生成，请勿手工编辑 */\n')
    f.write('window.VENDOR_DATA = ')
    f.write(json.dumps(data, ensure_ascii=False, indent=1))
    f.write(';\n')
print('已生成 %s' % os.path.abspath(OUT))
print('站点：%s' % data['station']['data']['list'][0]['name'])
print('抓取时间：%s' % data.get('_capturedAt'))
print('接口返回：' + ', '.join('%s=%s' % (k, v.get('code')) for k, v in data.items() if isinstance(v, dict) and 'code' in v))
