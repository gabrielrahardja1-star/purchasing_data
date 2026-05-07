"""
recategorize.py — Bulk recategorize items currently marked as 'Uncategorized'.

Run with --dry-run to preview changes without writing to DB.
Run without flags to apply changes.
"""

import sqlite3, sys, os, re
from collections import defaultdict

DB_PATH = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
DRY_RUN = '--dry-run' in sys.argv

# ── Rules: (category, [keywords matched against lowercased name_en + name_cn]) ─
# Order matters — first match wins.
RULES = [
    # Electrical
    ('Electrical', [
        'bohlam', 'led', 'downlight', 'lampu', 'lamp', 'kabel', 'cable supreme',
        'plastic wire', 'copper wire', '塑铜线',
        'saklar', 'stop kontak', 'box panel listrik', 'panel box', 'contactor', 'cjx2',
        'voltmeter', 'volt detector', 'test pen', 'testpen', 'megohm', 'high voltage meter',
        'multimeter', 'voltage regulator', 'smr', 'smv', 'inverter',
        'telephone', 'walkie talkie', 'monitor screen', 'dop-110',
        'electrolyte', 'electric', 'konduit', 'conduit', 'rod gantung',
        'klam pipa conduit', 'sok pipa conduit', 'knee pipa conduit',
        '电话', '对讲机', '验电', '兆欧表', '万用表', '稳压器', '控制箱', '电脑屏',
        '变频控制器', '接触器', '风机过热继电器', '电解液',
    ]),
    # Building/Civil
    ('Building/Civil', [
        'atap', 'baja ringan', 'bata', 'besi beton', 'semen', 'pasir', 'mortar',
        "knee 1'", "pipa 1'", "tee 1'", "knee 1\u2018", "pipa 1\u2018", "tee 1\u2018",
        "knee 1\u2019", "pipa 1\u2019", "tee 1\u2019", "stop kran",
        'gypsum', 'keramik', 'plafon pvc', 'papan', 'kaso', 'kolom praktis',
        'jaya bond', 'hollow besi', 'spandek roof', 'pipa pn', 'pipa pvc',
        'knee pn', 'knee drat', 'sok pn', 'sok drat', 'tee pn', 'sok oku',
        'tee 1/', 'knee 1/', 'pipa 1/', 'sok 1', 'lem pvc',
        'waterheater', 'water heater', 'shower head', 'jet shower', 'keran',
        'toilet', 'jendela', 'pintu', 'tangga lipat', 'toren',
        'suspension rod', 'rod 3mm', 'fiser gypsum', 'jidar aluminium',
        'ember semen', 'sendok semen', 'gergaji bata', 'gergaji kayu', 'gergaji besi',
        'cangkul', 'selang air', 'watermur', 'las dop', 'double nepel',
        'dynabokt', 'skrup alderon', 'skrup spandek', 'batu split',
        'pompa supply air', 'flexible 25cm', 'windows', 'window',
        '水泥', '彩钢瓦', '窗户',
    ]),
    # Mechanical Parts — fittings, pipes, flanges, sockets, pulleys
    ('Mechanical Parts', [
        'elbow', 'flange', 'tee fitting', 'union dn', 'nipple fitting',
        'stub end', 'street elbow', 'reducing socket', 'upvc socket',
        'knee dn', 'pvc-u', 'mist nozzle', 'shotcrete',
        'pressure gauge', 'glass rotameter', 'flow meter', 'fuel flow meter',
        'rotameter', 'pjb', 'flx600', 'fls', 'zgzs', 'h1sh', 'xm300',
        'pulley block', 'snatch block', 'manual jack', 'wheelbarrow', 'single wheel barrow',
        'coal sieve', 'screen sieve', 'waterpass', 'water pass',
        'vernier caliper', 'carpenter square',
        'nylon rod', 'nylon ties', 'round bar', 'roundbar', 'angle bar',
        'hollow 30', 'hollow 40', 'hollow besi', 'seamless 6',
        'threaded rod', 'thread', 'short end', 'short nipple',
        'heavy duty socket', 'deep impact socket', 'socket 17', 'socket 19',
        'socket 22', 'socket 24', 'socket 27', 'socket 30', 'socket 32',
        'sock set', 'ratchet socket', 'bench vise',
        'oxalic acid', 'sodium hypochlorite', 'polydadmac', 'aluminium sulphate',
        'alum ', 'silica gel', 'disinfectant', 'calibration gas', 'calgaz',
        'methane', 'carbon monoxide', 'oxygen', 'regulator cga', 'regulator c-10',
        'gas sample', 'gas 甲烷', 'gas 一氧化碳',
        'emulsifier', 'gum rosin', 'industrial petroleum', 'white butter',
        'thread loosening', 'threadlocker',
        'padlock', 'cutting sticker', 'magnet', 'silica',
        'fuel tank', 'cast iron', 'astm a216', 'qt450', 'wcb',
        'rsc125', 'xpb2800', 'lb-75', 'pgf50', 'tekiro', 'zgzs600',
        'flx600', 'fls600', 'h1sh13', 'xm300',
        'ramset gun', '炮钉枪',
        '炮钉', '油滤', '空滤', '管垫', '清扫器', '聚氨酯盲板', '重型加长套头',
        '破碎机轴', '提斗机', '段尼龙胶套',
        '弯头', '法兰', '三通', '活接', '短丝', '法兰活盘', '丝杆',
        '汽水分离器', '油气分离器', '孔板流量计', '压力表', '抗震压力表',
        '减速机', '注油枪', '手动注油枪', '桶式手压注油器', '风动注油枪',
        '气缸', '压滤机', '压滤板', '独轮车', '洗煤机', '分级筛面',
        '开口滑轮', '开口吊环滑轮', '次氯酸钠', '草酸',
        '硫酸铝', '聚二甲基', '工业凡士林', '乳化油', '松香水',
        '甲烷气样', '一氧化碳气样', '氧气气样', '标准气', '净化药剂',
        '尼龙柱销', '尼龙胶棒', '尼龙棒销', '弹性垫', '蜗壳',
        '圆钢', '角铁', '口字钢', '镀锌钢绞线', '铁弯头', '不锈钢弯头',
        '三通', '盘根', '橡胶钢丝带', '自扎带', '炮钉',
        '游标卡尺', '水平尺', '直角尺',
    ]),
    # Tools
    ('Tools', [
        'mata bor', 'mata gergaji', 'gergaji besi', 'palu gagang', 'palu ',
        'gerinda duduk', 'cut-off machine', 'tang las', 'tongkat mixer',
        'bench vise',
        'cutting tip', 'cutting nozzle', 'plasma cutting', 'oxy-acetylene',
        'ace cutting tip', 'p80', 'pgf',
        'brush ', 'bamboo handle brush', 'wirebrush', 'steel brush',
        'scissors', 'big scissors',
        'sock set 24', 'double head', 'screwdriver',
        'opening hole', 'drill bit', 'hole saw',
        'heavy duty deep socket', 'heavy duty impact socket', 'heavy duty socket',
        'socket 8mm', '套头', '加强加长套筒', '重型套头',
        'wallpaper knife', '壁纸刀', '开孔器',
        '切割机', '刷子', '剪刀', '钢刷头', '螺丝刀',
        '等离子切割', '乙炔切割', '喷浆',
    ]),
    # Food
    ('Food', [
        '玉米粉', '大麦粉', '淀粉', '自发粉', '白砂糖', '葡萄糖', '蔗糖',
        'corn flour', 'barley flour', 'starch', 'white sugar', 'glucose',
    ]),
    # Safety
    ('Safety', [
        'raincoat', 'welding cap', 'safety', 'ppe',
        '雨衣', '电焊帽子',
    ]),
    # Consumables
    ('Consumables', [
        'pylox', 'spray paint', 'zinc phosphate primer', 'silver pigment', 'propan metalkote',
        'cutting blade', 'abrasive', 'cotton ball', '棉花球',
        '自喷漆', '银粉调和漆', '磷酸锌底漆', '棉花球',
    ]),
    # Structural
    ('Structural', [
        'angle bar', 'round bar', 'roundbar', 'hollow 30*30', 'hollow 40',
        'spandek roof', 'besi beton', 'baja', 'papan 3',
        'seamless pipe', 'seamless 6',
        '圆钢', '角铁', '口字钢', '彩钢瓦',
    ]),
]

# ── Items to flag as likely junk/incomplete (will be set to 'Uncategorized' + note) ─
JUNK_PATTERNS = [
    r'^[A-Z][a-z]+$',  # Single capitalized word with no Chinese — likely a name
]
KNOWN_JUNK_NAMES = {
    'alisan', 'arco', 'arfika', 'cheng', 'fanny', 'haikal', 'jacob',
    'lihao', 'maya', 'shella', 'spare', 'sun', 'suhandi', 'syella',
    'wina', 'wna', 'zahra',
    'description specification', 'adjustable spring', 'ac 3/4pk',
    '品名 规格型号',
}

def categorize(name_en, name_cn):
    combined = (name_en + ' ' + name_cn).lower()
    for category, keywords in RULES:
        if any(k in combined for k in keywords):
            return category
    return None  # no match — leave as Uncategorized


def main():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT item_id, name_en, name_cn FROM items WHERE category = 'Uncategorized'"
    ).fetchall()

    print(f"Uncategorized items: {len(rows)}")

    changes = defaultdict(list)
    no_match = []

    for item_id, name_en, name_cn in rows:
        name_en = name_en or ''
        name_cn = name_cn or ''

        # Check if junk
        combined_lower = (name_en + ' ' + name_cn).strip().lower()
        if combined_lower in KNOWN_JUNK_NAMES or (not name_en and len(name_cn) < 2):
            no_match.append((item_id, name_en, name_cn, 'JUNK?'))
            continue

        new_cat = categorize(name_en, name_cn)
        if new_cat:
            changes[new_cat].append((item_id, name_en, name_cn))
        else:
            no_match.append((item_id, name_en, name_cn, ''))

    # Summary
    print(f"\nWill recategorize: {sum(len(v) for v in changes.values())}")
    for cat, items in sorted(changes.items()):
        print(f"  {cat:20s} {len(items)}")
    print(f"\nStill uncategorized: {len(no_match)}")

    if DRY_RUN:
        print("\n-- DRY RUN — no changes written --")
        print("\nRemaining uncategorized after fix:")
        for item_id, en, cn, note in sorted(no_match, key=lambda x: x[1]):
            flag = ' ← JUNK?' if note == 'JUNK?' else ''
            print(f"  {item_id:12s} {en[:45]:45s} | {cn[:25]}{flag}")
        conn.close()
        return

    # Apply
    updated = 0
    for cat, items in changes.items():
        for item_id, _, _ in items:
            conn.execute("UPDATE items SET category = ? WHERE item_id = ?", (cat, item_id))
            updated += 1

    conn.commit()
    conn.close()
    print(f"\n✓ Updated {updated} items.")


if __name__ == '__main__':
    main()
