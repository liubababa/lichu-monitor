#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
根据《晶农EMS协议问题清单》内容生成 Word（.docx）文档，用于发送厂家。

用法：python tools/make-problem-docx.py
输出：晶农EMS协议问题清单.docx（项目根目录）
"""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '晶农EMS协议问题清单.docx')
HEAD_FONT = '微软雅黑'
BODY_FONT = '宋体'
DARK = RGBColor(0x1F, 0x1F, 0x1F)
ACCENT = RGBColor(0x0B, 0x63, 0x57)
RED = RGBColor(0xC0, 0x39, 0x2B)


def set_run(run, size=10.5, bold=False, color=None, font=BODY_FONT):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = font
    run.font.color.rgb = color or DARK
    run._element.rPr.rFonts.set(qn('w:eastAsia'), font)


def para(doc, text, size=10.5, bold=False, color=None, font=BODY_FONT,
         align=None, space_after=4, space_before=0, indent=None):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.space_before = Pt(space_before)
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    r = p.add_run(text)
    set_run(r, size, bold, color, font)
    return p


def bullet(doc, text, size=10.5, level=0):
    p = doc.add_paragraph(style='List Bullet')
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.left_indent = Cm(0.75 + level * 0.6)
    r = p.add_run(text)
    set_run(r, size, False, BODY_FONT and DARK, BODY_FONT)
    return p


def h1(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    set_run(r, 14, True, ACCENT, HEAD_FONT)
    return p


def h2(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(9)
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run(text)
    set_run(r, 12, True, DARK, HEAD_FONT)
    return p


def shade(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), color)
    tcPr.append(shd)


def table(doc, headers, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        p = hdr[i].paragraphs[0]
        r = p.add_run(h)
        set_run(r, 10, True, RGBColor(0xFF, 0xFF, 0xFF), HEAD_FONT)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        shade(hdr[i], '0B6357')
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ''
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            for j, line in enumerate(str(v).split('\n')):
                if j:
                    p = cells[i].add_paragraph()
                    p.paragraph_format.space_after = Pt(1)
                r = p.add_run(line)
                set_run(r, 9.5)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    return t


def main():
    doc = Document()

    # 页面：A4 + 页边距
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.2)
    sec.top_margin = sec.bottom_margin = Cm(2.0)

    # 默认字体
    style = doc.styles['Normal']
    style.font.name = BODY_FONT
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), BODY_FONT)

    # ---------- 标题 ----------
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    t.paragraph_format.space_after = Pt(2)
    set_run(t.add_run('晶农EMS MQTT 北向协议 · 对接问题清单'), 18, True, ACCENT, HEAD_FONT)
    s = doc.add_paragraph()
    s.alignment = WD_ALIGN_PARAGRAPH.CENTER
    s.paragraph_format.space_after = Pt(12)
    set_run(s.add_run('力储未来储能远程监控平台   →   中和汇能（山东）电气科技有限公司'), 10.5, False, RGBColor(0x60, 0x60, 0x60), HEAD_FONT)

    table(doc, ['项目', '内容'], [
        ['收件方', '中和汇能（山东）电气科技有限公司'],
        ['提出方', '力储未来储能远程监控平台'],
        ['依据文件', '《晶农EMS的MQTT通讯协议》2026-03-04；mqtt_north.xlsx 点表'],
        ['验证方式', '在真实公网 MQTT broker 上按文档逐条收发验证；并对文档示例报文做 JSON 合法性校验'],
        ['验证结论', '协议框架可用：文档定义的 14 条 Topic 链路在真实 broker 上全部可达。\n'
                     '但文档存在 4 处报文语法错误、多处字段不一致，且缺少连接参数，按现状无法完成真机联调。'],
    ], widths=[2.6, 14.0])

    # ---------- 一 ----------
    h1(doc, '一、阻塞项（不解决无法联调）')

    h2(doc, '1. 文档中 4 处示例报文不是合法 JSON —— 照抄会直接解析失败')
    table(doc, ['报文', '文档位置', '问题', '建议修正'], [
        ['周期上报\nPeriodReport', '协议 2. 周期上报存储数据',
         '① 多个字段使用全角冒号（"DiskSpace"： / "UnuserdSpace"： / "netIp"： / "SignalStrength"： / "Ccid"： / "version"：）\n'
         '② tags 末尾有多余逗号\n'
         '③ "time" 被放在 data[] 数组内部（结构错误，应与 data 同级）',
         '全角改半角、删除多余逗号、把 time 移出 data[]'],
        ['通道设置\nEmsSet', '协议 4. EMS通道参数设置',
         '① 全角逗号（"varValue":"25"，）\n② 数组尾多余逗号（}, ]）\n③ "time" 前缺少逗号',
         '全角改半角、删除尾逗号、补逗号'],
        ['设备信息应答\nDeviceInfor', '协议 6. 设备信息',
         '① 全角冒号（"DeviceManufacturer"： / "DeviceCode"：）\n② "time" 前缺少逗号',
         '全角改半角、补逗号'],
        ['站点信息应答\nUserInfor', '协议 7. 获取电站设备名称和SN',
         '① "time" 前缺少逗号\n② DeviceName 键重复（"电站名称" 与 "储能电站设备1" 同名，前者被覆盖）',
         '拆分字段名（StationName + DeviceName）、补逗号'],
    ], widths=[2.4, 3.2, 7.6, 3.4])
    para(doc, '影响：以上报文若按文档原文发送，任何标准 JSON 解析器都会报错；平台侧必须做特殊容错才能收下，属于不稳定隐患。',
         9.5, False, RED, space_before=4)

    h2(doc, '2. EmsSet 下发的通道名（wayName）取值无对照表')
    bullet(doc, '文档示例使用的是中文通道名："wayName":"下设充电/放电功率"、"wayName":"模块主机设置"')
    bullet(doc, '点表 mqtt_north.xlsx 中定义的是英文 TAG：SetPower、SOCmax、SOCmin、S1Power…S10Power 等')
    bullet(doc, '文档未说明两者的对应关系，也未给出 wayName 的完整取值枚举')
    para(doc, '影响：通道下发与充放电策略下发（文档第 5 节"运行策略设置"）无法实现 —— 不知道 wayName 该填中文名还是点表 TAG。',
         9.5, False, RED, space_before=4)
    para(doc, '请提供：《wayName ↔ 点表 TAG 对照表》，并明确 S1~S10 分段策略的段号、时间、功率分别对应哪些 wayName，'
              '以及各单位与取值符号（功率是否仍为 -充 +放）。', 10, True)

    h2(doc, '3. 缺少 MQTT 连接参数定义')
    para(doc, '文档仅说明"EMS 配置好第三方 broker 后，会向第三方 broker 发送登录请求"，但未给出：')
    bullet(doc, 'broker 地址与端口（是否支持 TLS，端口号）')
    bullet(doc, '用户名/密码或其它认证方式（是否为每台 EMS 独立账号）')
    bullet(doc, 'QoS 等级与 retain 约定')
    bullet(doc, 'keepalive、clientId 命名规则（是否要求以 SN 为 clientId）')
    bullet(doc, '是否要求平台侧同时提供 TCP 与 WebSocket 接入')
    para(doc, '影响：没有这些参数，EMS 无法接入任何第三方平台。请提供一份标准的接入参数说明。', 9.5, False, RED, space_before=4)

    # ---------- 二 ----------
    h1(doc, '二、结构性与一致性问题（会导致解析错乱或数据错位）')
    table(doc, ['#', '问题', '文档位置', '影响', '建议'], [
        ['4', '"time" 位于 data[] 数组内部', '协议 2、协议 3', '结构错误，解析器可能把 time 当成设备数据条目', '移至与 data 同级'],
        ['5', 'UnusedSpace 与 UnuserdSpace 拼写不一致', '点表 vs 协议文档', '平台按点表取不到"未使用空间"', '以点表为准统一为 UnusedSpace'],
        ['6', '字段说明表写 deviceName，payload 实际用 deviceTag', '协议 4 扩展域表格', '字段名不一致，容易误用', '统一为 deviceTag，并给出取值枚举'],
        ['7', 'SN 与 sn 大小写混用', '上报用 SN，召测请求用 sn', '需额外做大小写兼容', '统一命名'],
        ['8', 'UserInfor 应答 Topic 无 SN 后缀，且不回传 msgId', '协议 7', '多站/多设备场景无法配对请求与应答', 'Topic 补 SN 后缀，或回传 msgId'],
        ['9', '周期上报与召测应答同用 identifier = PeriodReport', '协议 3 召测应答示例', '无法区分周期上报与召测应答', '召测应答改用独立 identifier，或附带 msgId'],
        ['10', 'deviceType 中文名与点表设备号缺完整枚举', '协议 2 与点表', '点表中还有电芯/储能表/关口表/液冷机/干接点/消防/除湿机等，实际报文用哪个名字未明确', '提供完整对照表'],
    ], widths=[0.9, 4.4, 3.0, 4.6, 3.7])

    # ---------- 三 ----------
    h1(doc, '三、需确认的行为约定')
    table(doc, ['#', '待确认事项', '说明'], [
        ['11', '周期上报节拍', '文档"每个设备上报周期独立，EMS 侧可配置"与"每 10 分钟发送一次"如何并存？10 分钟能否由平台远程配置？'],
        ['12', '无效点表示方式', '"接收不到的数据标记成 Bad" —— 是字符串 "Bad" 还是 null？大小写是否固定？'],
        ['13', '召测应答频率', '规定 5s × 60 帧，是否与周期上报冲突？是否造成设备压力？'],
        ['14', '登录与断线重连', '未收到 PostRsp(result=1) 时是否重发 Login？重试间隔？断网后是否自动重新登录？'],
        ['15', '设备清单 DeviceInfor', 'DeviceTag 是否与点表设备号一致？是否覆盖全部设备类型？'],
        ['16', '通道下发反馈', 'SetRsp 的 errormsg 是否有错误码规范？多个 Tag 部分成功如何返回？'],
        ['17', '时间与时区', 'time 为 Unix 秒（UTC），EMS 是否保证时钟同步？是否提供 NTP？'],
        ['18', 'SN 规则', 'SN 长度、字符集，与点表 SN 字段格式是否一致？Topic 中是否带 SN 前缀？'],
    ], widths=[0.9, 3.6, 12.1])

    # ---------- 四 ----------
    h1(doc, '四、我方已完成的兼容（供参考）')
    para(doc, '为确保联调不被上述文档问题阻塞，平台侧已做如下容错处理，厂家按文档原样发送报文亦可正常接入：')
    bullet(doc, '兼容全角冒号/逗号、数组与对象的多余尾逗号')
    bullet(doc, '兼容 SN / sn 大小写差异')
    bullet(doc, '兼容 UserInfor 应答 Topic 不带 SN 后缀')
    bullet(doc, '兼容点值 "Bad"、空值、"--" 等无效表示（页面显示 --）')
    bullet(doc, '兼容 identifier 与实际业务不一致的情况（按 Topic 兜底识别）')
    para(doc, '但通道下发（EmsSet）依赖的 wayName 对照表缺失属于硬阻塞，无法通过容错绕过，需厂家提供。', 10, True, RED, space_before=4)

    # ---------- 五 ----------
    h1(doc, '五、验证结论摘要（附录）')
    para(doc, '验证环境：真实公网 broker（mqtt://test.mosquitto.org:1883），使用文档原文示例报文，逐条验证发布/订阅链路。')
    para(doc, '验证结果：', space_before=4)
    bullet(doc, '文档定义的 14 条 Topic 链路全部可达（登录请求/应答、周期上报、召测请求/应答、通道下发/应答、设备信息请求/应答、站点信息请求/应答）')
    bullet(doc, '文档 11 段示例 payload 中，7 段为合法 JSON，4 段非法（见第一部分）')
    bullet(doc, '复现方式：node tools/doc-conformance.js mqtt://test.mosquitto.org:1883 <SN>')
    para(doc, '待厂家提供后即可封闭的问题：', space_before=6)
    bullet(doc, '《wayName ↔ 点表 TAG 对照表》（含 S1~S10 策略段）')
    bullet(doc, 'MQTT 接入参数说明（地址、端口、TLS、认证、QoS、clientId、keepalive）')
    bullet(doc, '《deviceType ↔ 点表设备号》对照表')
    bullet(doc, '修订后的协议文档（修正 4 处 JSON 语法错误与字段不一致）')

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    set_run(p.add_run('本清单由力储未来平台侧整理，验证脚本与原始输出可随时提供复现。'), 9.5, False, RGBColor(0x60, 0x60, 0x60), HEAD_FONT)

    doc.save(OUT)
    print('已生成：' + os.path.abspath(OUT))


if __name__ == '__main__':
    main()
