#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把图片交给本地视觉模型"看"，输出文字描述。

支持两种本地后端（自动探测）：
  1) Ollama        http://127.0.0.1:11434/api/generate      模型名如 qwen2.5vl:3b
  2) llama.cpp     http://127.0.0.1:8080/v1/chat/completions （需带 mmproj 的 VLM）

用法：
  python tools/see.py 图片路径 ["问题"] [模型名]

例：
  python tools/see.py "C:\\Users\\me\\Downloads\\厂房.jpg" "详细描述这栋厂房：层数、屋顶、窗户排布、颜色、附属结构"
"""
import base64
import io
import json
import os
import sys
import urllib.request

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

OLLAMA = 'http://127.0.0.1:11434'
LLAMACPP = 'http://127.0.0.1:8080'
DEFAULT_Q = ('详细描述这张图片里的建筑（如果是工业厂房/电站，重点说）：'
             '一共几层？屋顶是平顶还是坡顶、上面有什么？外墙什么颜色和材质？'
             '窗户怎么排布（几排几列、横窗还是竖窗、有没有分格）？'
             '有没有大门/卷帘门、雨棚、管道、烟囱、附属小楼、护栏、台阶？'
             '建筑大概的长宽高比例是多少？画面里还有什么其它物体？')


def try_json(url, payload, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def via_ollama(img_b64, question, model):
    j = try_json(OLLAMA + '/api/generate', {
        'model': model, 'prompt': question, 'images': [img_b64], 'stream': False,
        'options': {'temperature': 0.2, 'num_predict': 700}
    })
    out = j.get('response') or j.get('thinking') or ''
    if not out.strip():
        out = json.dumps(j, ensure_ascii=False)[:500]
    return out


def via_llamacpp(img_b64, question, model):
    j = try_json(LLAMACPP + '/v1/chat/completions', {
        'model': model or 'local',
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': question},
            {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + img_b64}}
        ]}],
        'temperature': 0.2, 'max_tokens': 1024
    })
    ch = (j.get('choices') or [{}])[0]
    return (ch.get('message') or {}).get('content') or json.dumps(j)[:500]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    path = sys.argv[1]
    question = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_Q
    model = sys.argv[3] if len(sys.argv) > 3 else os.environ.get('SEE_MODEL', 'qwen2.5vl:3b')
    if not os.path.exists(path):
        print('找不到图片：' + path)
        return
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    print('图片：%s（%.0f KB）  模型：%s' % (path, os.path.getsize(path) / 1024.0, model))
    print('问题：' + question)
    print('-' * 60)
    errs = []
    for name, fn in (('Ollama', via_ollama), ('llama.cpp', via_llamacpp)):
        try:
            out = fn(b64, question, model)
            print('[%s] %s' % (name, out))
            return
        except Exception as e:
            errs.append('%s: %s' % (name, e))
    print('本地视觉模型都调不通：')
    for e in errs:
        print('  -', e)
    print('（先启动 Ollama 并 pull 一个视觉模型，或启动带 mmproj 的 llama.cpp 服务）')


if __name__ == '__main__':
    main()
