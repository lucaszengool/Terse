#!/usr/bin/env python3
"""
Generate professional IDC market research PDF report
McKinsey discussion summary for LD briefing
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus.flowables import Flowable
import os

# ── Register Chinese font ──
# Try common macOS Chinese font paths
font_paths = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/Supplemental/STHeiti Medium.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]

# Try to register a Chinese-capable font
cn_font = 'Helvetica'
cn_font_bold = 'Helvetica-Bold'

for fp in font_paths:
    if os.path.exists(fp):
        try:
            if fp.endswith('.ttc'):
                pdfmetrics.registerFont(TTFont('ChineseFont', fp, subfontIndex=0))
                cn_font = 'ChineseFont'
                # Try bold variant
                try:
                    pdfmetrics.registerFont(TTFont('ChineseFontBold', fp, subfontIndex=1))
                    cn_font_bold = 'ChineseFontBold'
                except:
                    cn_font_bold = 'ChineseFont'
            else:
                pdfmetrics.registerFont(TTFont('ChineseFont', fp))
                cn_font = 'ChineseFont'
                cn_font_bold = 'ChineseFont'
            print(f'Using font: {fp}')
            break
        except Exception as e:
            print(f'Font {fp} failed: {e}')
            continue

# ── Colors ──
NAVY = HexColor('#1a365d')
DARK_BLUE = HexColor('#2c5282')
BLUE = HexColor('#3182ce')
LIGHT_BLUE = HexColor('#ebf8ff')
LIGHT_GRAY = HexColor('#f7fafc')
MEDIUM_GRAY = HexColor('#e2e8f0')
DARK_GRAY = HexColor('#2d3748')
RED = HexColor('#e53e3e')
GREEN = HexColor('#38a169')
ORANGE = HexColor('#dd6b20')
TEXT_COLOR = HexColor('#1a202c')
SUB_TEXT = HexColor('#4a5568')

# ── Styles ──
styles = getSampleStyleSheet()

title_style = ParagraphStyle(
    'CustomTitle', parent=styles['Title'],
    fontName=cn_font_bold, fontSize=22, leading=28,
    textColor=NAVY, spaceAfter=6*mm, alignment=TA_LEFT
)

subtitle_style = ParagraphStyle(
    'CustomSubtitle', parent=styles['Normal'],
    fontName=cn_font, fontSize=11, leading=15,
    textColor=SUB_TEXT, spaceAfter=8*mm
)

h1_style = ParagraphStyle(
    'H1', parent=styles['Heading1'],
    fontName=cn_font_bold, fontSize=16, leading=22,
    textColor=NAVY, spaceBefore=8*mm, spaceAfter=4*mm,
    borderWidth=0, borderPadding=0,
)

h2_style = ParagraphStyle(
    'H2', parent=styles['Heading2'],
    fontName=cn_font_bold, fontSize=13, leading=18,
    textColor=DARK_BLUE, spaceBefore=5*mm, spaceAfter=3*mm,
)

h3_style = ParagraphStyle(
    'H3', parent=styles['Heading3'],
    fontName=cn_font_bold, fontSize=11, leading=15,
    textColor=BLUE, spaceBefore=3*mm, spaceAfter=2*mm,
)

body_style = ParagraphStyle(
    'CustomBody', parent=styles['Normal'],
    fontName=cn_font, fontSize=10, leading=16,
    textColor=TEXT_COLOR, spaceAfter=2*mm,
    alignment=TA_JUSTIFY,
)

bullet_style = ParagraphStyle(
    'Bullet', parent=body_style,
    fontName=cn_font, fontSize=10, leading=16,
    leftIndent=12*mm, bulletIndent=5*mm,
    spaceBefore=1*mm, spaceAfter=1*mm,
)

sub_bullet_style = ParagraphStyle(
    'SubBullet', parent=bullet_style,
    fontName=cn_font, fontSize=9.5, leading=14,
    leftIndent=20*mm, bulletIndent=13*mm,
    textColor=SUB_TEXT,
)

highlight_style = ParagraphStyle(
    'Highlight', parent=body_style,
    fontName=cn_font_bold, fontSize=10, leading=16,
    textColor=NAVY, backColor=LIGHT_BLUE,
    borderWidth=0, borderPadding=6,
    spaceBefore=3*mm, spaceAfter=3*mm,
    leftIndent=3*mm, rightIndent=3*mm,
)

# ── Helper: colored section bar ──
class SectionBar(Flowable):
    def __init__(self, text, color=NAVY, width=170*mm, height=8*mm):
        Flowable.__init__(self)
        self.text = text
        self.color = color
        self.width = width
        self.height = height

    def draw(self):
        self.canv.setFillColor(self.color)
        self.canv.roundRect(0, 0, self.width, self.height, 2*mm, fill=1, stroke=0)
        self.canv.setFillColor(white)
        self.canv.setFont(cn_font_bold, 13)
        self.canv.drawString(4*mm, 2*mm, self.text)


def build_pdf():
    output_path = '/Users/James/Desktop/IDC_Market_Research_Report.pdf'
    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=20*mm, rightMargin=20*mm,
        topMargin=20*mm, bottomMargin=20*mm
    )

    story = []

    # ════════════════════════════════════════════════
    # COVER / TITLE
    # ════════════════════════════════════════════════
    story.append(Spacer(1, 15*mm))

    # Top accent line
    story.append(HRFlowable(width="100%", thickness=3, color=NAVY, spaceAfter=8*mm))

    story.append(Paragraph('欧洲及东南亚IDC市场调研', title_style))
    story.append(Paragraph('核心发现与行动建议', ParagraphStyle(
        'Title2', parent=title_style, fontSize=18, textColor=DARK_BLUE, spaceAfter=4*mm
    )))

    story.append(HRFlowable(width="40%", thickness=1.5, color=BLUE, spaceAfter=6*mm))

    story.append(Paragraph('与麦肯锡联合调研成果汇总  |  2026年3月', subtitle_style))

    story.append(Spacer(1, 10*mm))

    # Key numbers highlight box
    kpi_data = [
        [Paragraph(f'<font name="{cn_font_bold}" color="#1a365d" size="9">欧洲</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" color="#1a365d" size="9">东南亚</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" color="#1a365d" size="9">造价基准</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">德国空置率<b>5%</b>，法国<b>8%</b><br/>电网接入<b>5-7年</b></font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">新加坡空置率<b>5%</b><br/>马来租金回调至<b>$110-130/kW</b></font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">风冷N+1: <b>6.25 Mn/MW</b><br/>液冷2N+1: <b>9.25 Mn/MW</b></font>', body_style)]
    ]
    kpi_table = Table(kpi_data, colWidths=[55*mm, 55*mm, 55*mm])
    kpi_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), LIGHT_BLUE),
        ('BACKGROUND', (0, 1), (-1, 1), LIGHT_GRAY),
        ('GRID', (0, 0), (-1, -1), 0.5, MEDIUM_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 4*mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4*mm),
        ('LEFTPADDING', (0, 0), (-1, -1), 3*mm),
    ]))
    story.append(kpi_table)

    story.append(Spacer(1, 10*mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=MEDIUM_GRAY, spaceAfter=5*mm))
    story.append(Paragraph(f'<font name="{cn_font}" size="8" color="#718096">CSIG 云与智慧产业事业群  |  Confidential</font>', body_style))

    story.append(PageBreak())

    # ════════════════════════════════════════════════
    # SECTION 1: EUROPE
    # ════════════════════════════════════════════════
    story.append(SectionBar('一、欧洲市场：供给端结构性紧缺已现'))
    story.append(Spacer(1, 4*mm))

    # 1.1
    story.append(Paragraph('1. 供给格局分化明显', h2_style))

    eu_data = [
        [Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">指标</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">德国</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">法国</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">西班牙</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">荷兰</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">租赁存量 (MW)</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">1,156</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">754</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">315</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">729</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">空置率</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">5.0%</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#dd6b20">7.5%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">15.0%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#dd6b20">10.2%</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">未上线预租率</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">100%</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">92%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">87%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">40%</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">电网接入 (年)</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">7</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">7</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">2-5</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#e53e3e">10</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">供给紧张度</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">极度紧缺</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#dd6b20">紧缺</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#d69e2e">中等</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#d69e2e">中等</font>', body_style)],
    ]
    eu_table = Table(eu_data, colWidths=[32*mm, 28*mm, 28*mm, 28*mm, 28*mm])
    eu_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('BACKGROUND', (0, 1), (-1, 1), LIGHT_GRAY),
        ('BACKGROUND', (0, 3), (-1, 3), LIGHT_GRAY),
        ('BACKGROUND', (0, 5), (-1, 5), LIGHT_GRAY),
        ('GRID', (0, 0), (-1, -1), 0.5, MEDIUM_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (1, 1), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 2.5*mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5*mm),
    ]))
    story.append(eu_table)
    story.append(Spacer(1, 3*mm))

    story.append(Paragraph(f'<b>核心判断</b>：德国已基本断供，法国进入供给紧缺，周边市场（西/荷）目前尚有窗口但中期将收紧', highlight_style))

    # 1.2
    story.append(Paragraph('2. 法国深度洞察 — 三个关键趋势', h2_style))

    story.append(Paragraph(f'<b>趋势一：规模化</b>', h3_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>单体DC容量从当前15-30MW向70-80MW演进', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>机柜功率密度从10-20kW提升至50-100kW+/机柜，驱动大规模AI训练需求', bullet_style))

    story.append(Paragraph(f'<b>趋势二：批发化</b>', h3_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>批发模式占比从50%（2020）将升至75%（2028E），零售份额持续压缩', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>70%基础容量被Hyperscaler以长期合同锁定，市场余量分化：大容量稀缺，小容量零散', bullet_style))

    story.append(Paragraph(f'<b>趋势三：资源瓶颈</b>', h3_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>电网由RTE垄断运营，审批完到壳交付37个月，接入电网需5+年', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>EED/SDCR等欧洲新规增加技术要求与建设周期', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>快速上线必须选择已有电力指标的colo（Data4、OpCore、DRT、Equinix）', bullet_style))

    # 1.3
    story.append(Paragraph('3. 对腾讯云的启示', h2_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>零售市场溢价显著（180-250€/kW/月），比批发高出20-40%，等待周期长', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet><b>建议走批发/BTS路线</b>，锁定有电力指标、快速通道的头部colo', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>需<b>提前3-5年</b>做法国地区容量规划，当前窗口期紧迫', bullet_style))

    # Hyperscaler comparison
    story.append(Spacer(1, 3*mm))
    story.append(Paragraph('Hyperscaler在法国的布局策略对标', h3_style))

    hs_data = [
        [Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">厂商</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">自建</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">租赁</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">模式倾向</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">Google</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">25年启动首个自建DC（卢瓦尔河谷）</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">50-150MW/站点，3-6年交付</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">colo+BTS为主，未来转自建</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">AWS</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">联合CyrusOne建设49.6MW</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">colo可快速提供50-200MW+电力</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">选择colo模式，速度优先</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">Azure</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">2017年起自建巴黎/马赛，共100-140MW</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">80-100MW，DRT/Equinix/Data4等</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">偏自建，巴黎FLAP-D最优</font>', body_style)],
    ]
    hs_table = Table(hs_data, colWidths=[20*mm, 48*mm, 48*mm, 40*mm])
    hs_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), DARK_BLUE),
        ('BACKGROUND', (0, 1), (-1, 1), LIGHT_GRAY),
        ('BACKGROUND', (0, 3), (-1, 3), LIGHT_GRAY),
        ('GRID', (0, 0), (-1, -1), 0.5, MEDIUM_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 2*mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2*mm),
        ('LEFTPADDING', (0, 0), (-1, -1), 2*mm),
    ]))
    story.append(hs_table)

    story.append(PageBreak())

    # ════════════════════════════════════════════════
    # SECTION 2: SOUTHEAST ASIA
    # ════════════════════════════════════════════════
    story.append(SectionBar('二、东南亚市场：结构性分化加剧'))
    story.append(Spacer(1, 4*mm))

    story.append(Paragraph('1. 供给格局总览', h2_style))

    sea_data = [
        [Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">指标</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">新加坡</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">马来西亚</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">印尼</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="white">泰国</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">租赁存量 (MW)</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">723</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">1,055</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">306</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">79</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">空置率</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">5.0%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#dd6b20">10.0%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">23.0%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">23.0%</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">2年内预租率</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">63%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">85%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">90%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">&lt;40%</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">壳交付到白地板 (月)</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">15</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">12</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">13</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">16</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">电网接入 (年)</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#dd6b20">4</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">1</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">2</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">2</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">供给紧张度</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">极度紧缺</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#d69e2e">中等</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">充裕</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">充裕</font>', body_style)],
    ]
    sea_table = Table(sea_data, colWidths=[36*mm, 27*mm, 27*mm, 27*mm, 27*mm])
    sea_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('BACKGROUND', (0, 1), (-1, 1), LIGHT_GRAY),
        ('BACKGROUND', (0, 3), (-1, 3), LIGHT_GRAY),
        ('BACKGROUND', (0, 5), (-1, 5), LIGHT_GRAY),
        ('GRID', (0, 0), (-1, -1), 0.5, MEDIUM_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (1, 1), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 2.5*mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5*mm),
    ]))
    story.append(sea_table)
    story.append(Spacer(1, 3*mm))

    story.append(Paragraph(f'<b>核心判断</b>：新加坡容量告急，马来西亚短期偏松但柔佛核心区紧缺，印尼/泰国供给充裕', highlight_style))

    # 2.2 Malaysia
    story.append(Paragraph('2. 马来西亚重点发现', h2_style))

    story.append(Paragraph(f'<b>租金走势</b>', h3_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>批发租金从2023年高位$155-160/kW/月回调至$110-130/kW/月', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>2026年大型云厂商试探$70-80底价，行业盈利空间受挤压', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>合约主流"10+5"模式，部分colo开始接受"7+5"折中方案', bullet_style))

    story.append(Paragraph(f'<b>区域分化</b>', h3_style))

    region_data = [
        [Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">区域</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">空置率</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">特点</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">适用场景</font>', body_style)],
        [Paragraph(f'<font name="{cn_font_bold}" size="8">柔佛</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="#e53e3e">&lt;3%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">近乎满租，电力受限，新审批暂停</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">高密度AI，新加坡溢出</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">吉隆坡/雪兰莪</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#dd6b20">8-12%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">有低密度机柜可供租赁</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">网络稳定+高密度"次优解"</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">森美兰</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8" color="#38a169">15-20%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">2026 Q2-Q3新项目投运</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">中低密度，延迟要求低</font>', body_style)],
    ]
    region_table = Table(region_data, colWidths=[30*mm, 20*mm, 55*mm, 45*mm])
    region_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), DARK_BLUE),
        ('BACKGROUND', (0, 2), (-1, 2), LIGHT_GRAY),
        ('GRID', (0, 0), (-1, -1), 0.5, MEDIUM_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 2*mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2*mm),
        ('LEFTPADDING', (0, 0), (-1, -1), 2*mm),
    ]))
    story.append(region_table)

    story.append(PageBreak())

    # ════════════════════════════════════════════════
    # SECTION 3: COST BENCHMARKING
    # ════════════════════════════════════════════════
    story.append(SectionBar('三、马来西亚造价基准对标（麦肯锡样本）'))
    story.append(Spacer(1, 4*mm))

    cost_data = [
        [Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">维度</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">Vantage<br/>Sedenak</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">Basis Bay<br/>Cyberjaya</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8" color="white">AirTrunk<br/>Iskandar Puteri</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">容量</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">57 MW</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">64 MW</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">45 MW</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">冷却方式</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">风冷</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">混合液冷</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">混合液冷</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">冗余等级</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">N+1</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">2N+1</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">N+1</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">电池</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">锂电池</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">铅酸电池</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">锂电池</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">建筑方式</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">预制</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">预制</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">预制</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">总造价 (Mn USD)</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8">356</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8">592</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="8">377</font>', body_style)],
        [Paragraph(f'<font name="{cn_font_bold}" size="8">单位造价 (Mn/MW)</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="#38a169">6.25</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="#e53e3e">9.25</font>', body_style),
         Paragraph(f'<font name="{cn_font_bold}" size="9" color="#dd6b20">8.38</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">建筑工程占比</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">25%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">14%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">11%</font>', body_style)],
        [Paragraph(f'<font name="{cn_font}" size="8">MEP占比</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">36%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">64%</font>', body_style),
         Paragraph(f'<font name="{cn_font}" size="8">48%</font>', body_style)],
    ]
    cost_table = Table(cost_data, colWidths=[32*mm, 38*mm, 38*mm, 38*mm])
    cost_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('BACKGROUND', (0, 7), (-1, 7), HexColor('#edf2f7')),
        ('BACKGROUND', (0, 2), (-1, 2), LIGHT_GRAY),
        ('BACKGROUND', (0, 4), (-1, 4), LIGHT_GRAY),
        ('BACKGROUND', (0, 6), (-1, 6), LIGHT_GRAY),
        ('GRID', (0, 0), (-1, -1), 0.5, MEDIUM_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (1, 1), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 2.5*mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5*mm),
        ('BOX', (0, 7), (-1, 7), 1.5, NAVY),
    ]))
    story.append(cost_table)

    story.append(Spacer(1, 4*mm))
    story.append(Paragraph('造价核心洞察', h2_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet><b>风冷+N+1为成本最优路线</b>（~6 Mn/MW），液冷+高冗余推高至8-9 Mn/MW', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>液冷技术（CDU/冷板）带来的精密设备使MEP占比从36%升至64%', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>欧美系GC（如Vantage）建筑工程费偏高（25%），中资GC有优化空间', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>中资GC可将工期压至14-15个月，较短建造与通电周期缓解供应压力', bullet_style))

    # Pricing logic
    story.append(Paragraph('租金定价逻辑', h2_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet><b>核心公式</b>：营收 = 单位租金 x 容量 x 12月 x 上架率', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>以Vantage样本（总造价356Mn USD）：目标EBITDA margin 50%，融资65%（4%利率/25年），自付35%（124Mn），5年回收', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>推算单位租金约<b>$124/kW/月</b>，EBITDA 42Mn USD', bullet_style))
    story.append(Paragraph(f'<bullet>&bull;</bullet>长约（5-10年）是行业核心风控手段 — 确保资产生命周期内现金流覆盖折旧与利息', bullet_style))

    story.append(PageBreak())

    # ════════════════════════════════════════════════
    # SECTION 4: ACTION ITEMS
    # ════════════════════════════════════════════════
    story.append(SectionBar('四、核心行动建议', color=HexColor('#2c5282')))
    story.append(Spacer(1, 6*mm))

    actions = [
        ('欧洲-法国', '尽快锁定有电力指标的colo供应商（Data4/DRT/Equinix），走批发/BTS模式，提前3-5年规划容量。零售窗口已基本关闭，批发容量也需一定等待期，在Hyperscaler先发制人锁定大部分容量的情况下，需选择有快速通道、有资源的供应商'),
        ('东南亚-柔佛', '中短期colo容量获取机会有限（空置率<3%，电力审批收紧）。建议关注雪兰莪作为兼顾网络稳定性与高密度定制的"次优解"；非核心区（森美兰等）可利用15-20%空置率作为谈判压价杠杆'),
        ('造价管控', '优先采用风冷+N+1路线控制单位造价在6-7 Mn/MW区间；液冷按AI业务需求针对性引入。充分发挥中资GC模块化优势压缩工期至14-15个月'),
        ('合约策略', '争取"10+5"长约锁定租金水平，关注马来市场2026年价格洗牌窗口。在营收压力下部分colo开始接受"7+5"折中方案，可作为谈判切入点'),
    ]

    for i, (title, desc) in enumerate(actions):
        num = str(i + 1)
        # Number circle + title
        action_title = ParagraphStyle(
            f'ActionTitle{i}', parent=h2_style,
            fontSize=13, spaceBefore=4*mm, spaceAfter=2*mm,
        )
        story.append(Paragraph(f'<font color="#3182ce" size="16"><b>{num}.</b></font>  <b>{title}</b>', action_title))
        story.append(Paragraph(desc, body_style))
        if i < len(actions) - 1:
            story.append(HRFlowable(width="100%", thickness=0.5, color=MEDIUM_GRAY, spaceBefore=2*mm, spaceAfter=2*mm))

    # Footer
    story.append(Spacer(1, 15*mm))
    story.append(HRFlowable(width="100%", thickness=1.5, color=NAVY, spaceAfter=3*mm))
    story.append(Paragraph(
        f'<font name="{cn_font}" size="8" color="#718096">'
        '数据来源：DC Byte, CBRE, Cushman &amp; Wakefield, JLL 2026 Global DC Outlook, Eurostat, 专家访谈<br/>'
        'CSIG 云与智慧产业事业群  |  Confidential  |  2026年3月'
        '</font>', body_style
    ))

    # Build
    doc.build(story)
    print(f'\nPDF saved: {output_path}')

if __name__ == '__main__':
    build_pdf()
