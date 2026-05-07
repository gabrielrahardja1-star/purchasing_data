"""
migrate_03_uom.py — Phase 3: Standardize UOM values to canonical set.

Updates items, pr_items, and po_items tables.

Usage:
  python3 migrate_03_uom.py --dry-run   # preview changes
  python3 migrate_03_uom.py             # apply changes
"""

import sqlite3, sys, os
from collections import defaultdict

DB_PATH = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
DRY_RUN = '--dry-run' in sys.argv

# ── Canonical UOM set (13 codes) ──────────────────────────────────────────────
# Anything not in this map is left unchanged and flagged as UNMAPPED.
UOM_MAP = {
    # ── Already canonical ────────────────────────────────────
    'pcs':    'pcs',
    'set':    'set',
    'kg':     'kg',
    'ton':    'ton',
    'm':      'm',
    'm2':     'm2',
    'm3':     'm3',
    'L':      'L',
    'roll':   'roll',
    'bag':    'bag',
    'drum':   'drum',
    'box':    'box',
    'carton': 'carton',
    'bottle': 'bottle',
    'pair':   'pair',
    'unit':   'pcs',    # generic "unit" → pcs

    # ── Case variants ────────────────────────────────────────
    'PCS':    'pcs',
    'KG':     'kg',
    'TON':    'ton',
    'M':      'm',
    'UNIT':   'pcs',
    'Unit':   'pcs',

    # ── Indonesian ───────────────────────────────────────────
    'btg':    'pcs',    # batang (rod/bar/stick) — see note in plan
    'lbr':    'pcs',    # lembar (sheet)
    'sak':    'bag',    # sak (sack)
    'pack':   'bag',
    'bundle': 'box',
    'can':    'drum',   # aerosol/paint can
    'tube':   'drum',   # small tube container

    # ── Chinese characters ────────────────────────────────────
    '关':     'pcs',    # likely 罐 (can) OCR corruption
    '单位':   'pcs',    # "unit"
    '口':     'pcs',    # likely 个 (piece) OCR error
    '张':     'pcs',    # zhang (sheet/flat piece)
    '支':     'pcs',    # zhi (stick/piece)
    '梱':     'box',    # kun (bundle/bale)
    '步':     'pcs',    # likely OCR corruption
    '盒':     'drum',   # he (small box/tin)
    '罐':     'drum',   # guan (can/jar/drum)
    '付':     'set',    # fu (set/pair)

    # ── Compound / descriptive ────────────────────────────────
    '25kg/bag':                   'bag',
    '25kg/sack':                  'bag',
    '1000ml (12pcs per carton)':  'carton',

    # ── Other observed variants ───────────────────────────────
    'mtr':    'm',
    'Mtr':    'm',
    'MTR':    'm',
    'ltr':    'L',
    'Ltr':    'L',
    'LTR':    'L',
    'litre':  'L',
    'liter':  'L',
}

# Flag btg specially since it removes Indonesian context
BTG_FLAG = True


def analyze(conn, table, col='uom'):
    """Return dict of {uom_value: count} for a table."""
    rows = conn.execute(
        f"SELECT {col}, COUNT(*) AS n FROM {table} "
        f"WHERE {col} IS NOT NULL AND {col} != '' "
        f"GROUP BY {col} ORDER BY n DESC"
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("=" * 60)
    print("Phase 3: UOM Standardization")
    print("=" * 60)

    for table in ('items', 'pr_items', 'po_items'):
        dist = analyze(conn, table)
        mapped = defaultdict(list)
        unmapped = []
        unchanged = []
        btg_items = []

        for uom, count in dist.items():
            canonical = UOM_MAP.get(uom)
            if canonical is None:
                unmapped.append((uom, count))
            elif canonical == uom:
                unchanged.append((uom, count))
            else:
                mapped[canonical].append((uom, count))
                if uom == 'btg':
                    btg_items.append(count)

        total_changes = sum(c for groups in mapped.values() for _, c in groups)

        print(f"\n[{table}] {sum(dist.values())} total rows, {len(dist)} distinct UOMs")
        print(f"  Will remap: {total_changes} rows")
        print(f"  Unchanged (already canonical): {sum(c for _, c in unchanged)}")

        if mapped:
            print(f"  Remapping detail:")
            for canonical, sources in sorted(mapped.items()):
                for old, count in sources:
                    arrow = f"'{old}' → '{canonical}'"
                    flag = ' ← ⚠ removes Indonesian context' if old == 'btg' else ''
                    print(f"    {arrow:35s} ({count} rows){flag}")

        if unmapped:
            print(f"  UNMAPPED (will be left unchanged):")
            for uom, count in unmapped:
                print(f"    '{uom}': {count} rows  ← manual review needed")

    if DRY_RUN:
        print("\n-- DRY RUN — no changes written --")
        conn.close()
        return

    # ── Apply ─────────────────────────────────────────────────
    total_updated = 0
    for table in ('items', 'pr_items', 'po_items'):
        dist = analyze(conn, table)
        for uom, count in dist.items():
            canonical = UOM_MAP.get(uom)
            if canonical and canonical != uom:
                conn.execute(
                    f"UPDATE {table} SET uom=? WHERE uom=?",
                    (canonical, uom)
                )
                total_updated += count

    conn.commit()
    conn.close()
    print(f"\n✓ Updated {total_updated} UOM values across items, pr_items, po_items.")


if __name__ == '__main__':
    main()
