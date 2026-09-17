#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成《力储未来 · 对接准备清单（小白版）》Word 文档。

用法：python tools/make-prep-docx.py
输出：对接准备清单.docx（项目根目录）
"""
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '对接准备清单.docx')
HEAD_FONT = '微软雅黑'
BODY_FONT = '宋体'
DARK = RGBColor(0x1F, 0x1F, 0x1F)
ACCENT = RGBColor(0x0B, 0x63, 0x57)
RED = RGBColor(0xC0, 0x39, 0x2B)
GREY = RGBColor(0x66, 0x66, 0x66)


def set_run(run, size=10.5, bold=False, color=None, font=BODY_FONT):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = font
    run.font.color.rgb = color or DARK
    run._element.rPr.rFonts.set(qn('w:eastAsia'), font)


def para(doc, text, size=10.5, bold=False, color=None, font=BODY_FONT, align=None,
         space_after=4, space_before=0, indent=None):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.space_before = Pt(space_before)
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    set_run(p.add_run(text), size, bold, color, font)
    return p


def bullet(doc, text, size=10.5):
    p = doc.add_paragraph(style='List Bullet')
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.left_indent = Cm(0.75)
    set_run(p.add_run(text), size)
    return p


def h1(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(6)
    set_run(p.add_run(text), 14, True, ACCENT, HEAD_FONT)


def h2(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(9)
    p.paragraph_format.space_after = Pt(4)
    set_run(p.add_run(text), 12, True, DARK, HEAD_FONT)


def shade(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), color)
    tcPr.append(shd)


def table(doc, headers, rows, widths=None, mono_col=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ''
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_run(p.add_run(h), 10, True, RGBColor(0xFF, 0xFF, 0xFF), HEAD_FONT)
        shade(c, '0B6357')
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
                set_run(p.add_run(line), 9.5)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    return t


def box(doc, text, color='F4F9F8'):
    """带底色的提示框（单元格方式实现）"""
    t = doc.add_table(rows=1, cols=1)
    t.style = 'Table Grid'
    c = t.rows[0].cells[0]
    c.text = ''
    p = c.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    set_run(p.add_run(text), 10.5)
    shade(c, color)
    para(doc, '', size=4, space_after=0)


def main():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.2)
    sec.top_margin = sec.bottom_margin = Cm(2.0)

    st = doc.styles['Normal']
    st.font.name = BODY_FONT
    st.font.size = Pt(10.5)
    st.element.rPr.rFonts.set(qn('w:eastAsia'), BODY_FONT)

    # 标题
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    t.paragraph_format.space_after = Pt(2)
    set_run(t.add_run('力储未来储能远程监控平台 · 对接准备清单'), 18, True, ACCENT, HEAD_FONT)
    s = doc.add_paragraph()
    s.alignment = WD_ALIGN_PARAGRAPH.CENTER
    s.paragraph_format.space_after = Pt(12)
    set_run(s.add_run('小白版 · 照着一条条打勾就行（不用懂技术细节）'), 10.5, False, GREY, HEAD_FONT)

    # ---------- 一 ----------
    h1(doc, '一、先搞懂：数据是怎么从储能柜跑到你屏幕上的')
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(8)
    set_run(p.add_run('① 储能柜里的 EMS  →  ② 你服务器上的“中转站”  →  ③ 你的监控网页'), 11.5, True, ACCENT, HEAD_FONT)
    table(doc, ['角色', '是什么', '谁来做'], [
        ['① EMS', '储能柜里由中和汇能提供的设备，负责采集电池、PCS、电表等数据', '厂家出厂自带，不用你管'],
        ['② 中转站（broker）', '装在你服务器上的一个后台服务（推荐 EMQX），负责把 EMS 发来的数据转发给网页', '你自己装，有现成命令照抄'],
        ['③ 监控网页', '力储未来平台页面，用来看数据、下发策略', '已经做好了，传上服务器即可'],
    ], widths=[2.8, 8.4, 5.4])

    para(doc, '三个关键点（新手最容易绕晕的地方）：', 10.5, True, space_before=8)
    bullet(doc, 'EMS 和网页互不直连：两边都只连“中转站”，所以不需要知道对方的地址。')
    bullet(doc, '“中转站”装好后就一直在后台跑，不用天天管它。')
    bullet(doc, '网页必须用 https 打开，所以中转站要额外转成 wss 加密通道——这一步服务器上配好就行。')

    # ---------- 二 ----------
    h1(doc, '二、你需要准备的东西（分三份，各找各人）')

    h2(doc, 'A. 你自己做的（有《部署指南》，命令可照抄）')
    table(doc, ['', '要做的事', '怎么做 / 说明'], [
        ['□', '一台能上外网的服务器', '你已经有了：ykdesign.top（不用再买）'],
        ['□', '在服务器上装中转站（EMQX）', '按《部署指南》第二节，一条 docker 命令'],
        ['□', '放行两个端口', '1883（给 EMS 连）、443（给网页连）—— 服务器防火墙和云厂商安全组都要放'],
        ['□', '给 nginx 加一段反向代理配置', '《部署指南》第三节，6 行配置复制粘贴，让网页能用 wss 连上中转站'],
        ['□', '把网页文件传到服务器', '整个文件夹覆盖上传（原来的 /dianzhan/ 目录）'],
        ['□', '给中转站建两个账号', '一个给 EMS 用（发给厂家）、一个给网页用（自己填在页面配置里）'],
    ], widths=[0.8, 5.0, 10.8])

    h2(doc, 'B. 找厂家（中和汇能）要的 —— 这一步最容易卡住')
    table(doc, ['', '要什么', '为什么需要 / 怎么用'], [
        ['□', 'EMS 的真实 SN（设备序列号）', '填在网页配置里，报文主题按 SN 区分；例如 SN21881FFF0001'],
        ['□', '让厂家在 EMS 里填你的服务器地址', '地址 ykdesign.top、端口 1883、账号密码（用你建给 EMS 的那个）'],
        ['□', '《通道名（wayName）对照表》', '要做“远程下发充放电策略”必须有，否则不知道填中文名还是英文点位名'],
        ['□', '确认 EMS 现场能不能上外网', '电站网络若受限，需厂家开白名单或走 4G 卡'],
        ['□', '修订版协议文档', '现文档有 4 处报文是错误 JSON（详见《晶农EMS协议问题清单》）'],
    ], widths=[0.8, 5.0, 10.8])

    h2(doc, 'C. 现场配合的')
    table(doc, ['', '事项', '说明'], [
        ['□', '储能柜所在位置要有网', '现场宽带或 4G 卡，厂家会告知'],
        ['□', '确认 EMS 能访问到你的服务器', '通常只要求 EMS 能出网即可；若现场做白名单，把你的域名/IP 加进去'],
        ['□', '拿到现场联系人', '万一不通，需要有人能到柜子那边看 EMS 状态'],
    ], widths=[0.8, 5.0, 10.8])

    # ---------- 三 ----------
    h1(doc, '三、做到这 5 步，就能看到真实数据了')
    table(doc, ['步骤', '做什么', '看到什么说明成了'], [
        ['1', '服务器装好 EMQX + 配好 nginx，端口放行', '浏览器能打开 https://ykdesign.top/dianzhan/'],
        ['2', '拿到 EMS 的 SN，并让厂家把 EMS 地址指向你的服务器', '厂家确认已配置'],
        ['3', '打开网页 → 右上角点「演示数据」→ 填 SN → 点「连接」', '右上角变成绿色「MQTT 已连接」'],
        ['4', '等 EMS 上线（或点「实时召测」主动要数据）', '底部「报文」里看到 EMS 发来的报文'],
        ['5', '看主页「设备总览」', 'SOC、功率、电芯电压温度等开始跳动 = 对接成功'],
    ], widths=[1.3, 8.2, 7.1])

    box(doc, '提示：页面右上角显示“演示数据”表示在看假数据；必须点开面板主动连接中转站，才会显示真实数据。')

    # ---------- 四 ----------
    h1(doc, '四、这些东西你不需要')
    bullet(doc, '不用另买服务器 —— 现有服务器够用')
    bullet(doc, '不用另买域名、不用额外申请证书 —— 已有 HTTPS')
    bullet(doc, '不用买数据库 —— 当前版本不存历史数据')
    bullet(doc, '不需要固定公网 IP —— 有域名指向就行')
    bullet(doc, '不需要改 EMS 内部程序 —— 只要厂家把中转站地址填进去')

    # ---------- 五 ----------
    h1(doc, '五、当前版本能做什么、还差什么')

    h2(doc, '已经能做的')
    bullet(doc, '实时数据展示：设备总览九大板块（系统参数、EMS 功率流、变流器、电池主控、液冷机、电芯热力图、储能表、关口表、干接点/消防/除湿机）')
    bullet(doc, '登录握手、周期上报接收、主动召测')
    bullet(doc, '远程下发充放电策略、查询设备清单（依赖厂家的对照表）')

    h2(doc, '还没做的（要上生产给客户看，得再加）')
    bullet(doc, '历史数据存储：关掉页面数据就断，KPI 目前是“本次会话累计”，不是真正的“今日电量”')
    bullet(doc, '告警记录与推送：目前只在页面上提示当前告警')
    bullet(doc, '多电站管理、用户登录与权限')

    # ---------- 六 ----------
    h1(doc, '六、遇到问题先看这三条')
    table(doc, ['现象', '大概率原因', '怎么办'], [
        ['网页显示「MQTT 已断开 / 错误」', 'nginx 反代没配好，或 8083/443 端口没放行', '检查《部署指南》第三节配置；用浏览器打开 https://你的域名/mqtt 看是否返回 400（返回 404 说明没配）'],
        ['显示「已连接 · 等待上报」，但一直没数据', 'EMS 没上线、SN 填错，或厂家没配地址', '问厂家 EMS 状态；让厂家确认填的地址端口账号是否正确'],
        ['页面数字不动、还是「演示数据」', '只是没点连接，或者连的是演示模式', '点右上角数据源 → 填地址和 SN → 点「连接」'],
    ], widths=[4.6, 4.4, 7.6])

    # ---------- 七 ----------
    h1(doc, '七、一页速查：找谁要什么')
    table(doc, ['找谁', '要什么', '一句话说明'], [
        ['厂家（中和汇能）', 'EMS 的 SN', '“请提供这台 EMS 的序列号”'],
        ['厂家', 'EMS 填你服务器地址', '“请把第三方 broker 配成 ykdesign.top:1883，账号密码我发你”'],
        ['厂家', '通道名对照表', '“下发策略用的 wayName 请给一份与点表 TAG 的对照表”'],
        ['厂家', '现场能否上外网', '“EMS 能访问公网吗？要不要加白名单”'],
        ['你自己', '服务器装 EMQX + 配 nginx', '按《部署指南》二、三节操作'],
        ['你自己', '上传网页文件', '整个目录覆盖到服务器 /dianzhan/'],
    ], widths=[3.2, 4.6, 8.8])

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    set_run(p.add_run('配套文件：《部署指南.md》（服务器操作手册）、《晶农EMS协议问题清单.docx》（发厂家的问题清单）。'), 9.5, False, GREY, HEAD_FONT)

    doc.save(OUT)
    print('已生成：' + os.path.abspath(OUT))


if __name__ == '__main__':
    main()
