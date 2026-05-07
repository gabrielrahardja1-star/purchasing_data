"""
migrate_01_cleanup.py — Phase 1: Junk deletion, encoding fixes, NULL normalization.

Usage:
  python3 migrate_01_cleanup.py --dry-run   # preview changes
  python3 migrate_01_cleanup.py             # apply changes
"""

import sqlite3, sys, os, re

DB_PATH = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
DRY_RUN = '--dry-run' in sys.argv

JUNK_ITEMS = [
    'ITEM-0379', 'ITEM-0817', 'ITEM-0834', 'ITEM-0843',
    'ITEM-0885', 'ITEM-0886', 'ITEM-0887', 'ITEM-0888',
    'ITEM-0889', 'ITEM-0890', 'ITEM-0891', 'ITEM-0892',
    'ITEM-0893', 'ITEM-0894', 'ITEM-0895', 'ITEM-0896',
    'ITEM-0897', 'ITEM-0898', 'ITEM-0903', 'ITEM-1066',
]


def fix_garbled(text):
    """Remove empty fullwidth parentheses and normalize whitespace."""
    if not text:
        return text
    # Remove empty fullwidth parens: （）or mixed variants
    text = re.sub(r'[（(]\s*[)）]', '', text)
    # Collapse multiple spaces
    text = re.sub(r'\s{2,}', ' ', text)
    return text.strip() or None


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("=" * 60)
    print("Phase 1: Data Cleanup")
    print("=" * 60)

    # ── Step 1: FK safety check ────────────────────────────────
    safe_to_delete = []
    blocked = []
    for item_id in JUNK_ITEMS:
        pr_ref = conn.execute(
            "SELECT COUNT(*) FROM pr_items WHERE item_id=?", (item_id,)
        ).fetchone()[0]
        po_ref = conn.execute(
            "SELECT COUNT(*) FROM po_items WHERE item_id=?", (item_id,)
        ).fetchone()[0]
        if pr_ref + po_ref == 0:
            safe_to_delete.append(item_id)
        else:
            blocked.append((item_id, pr_ref, po_ref))

    print(f"\n[JUNK] Safe to delete: {len(safe_to_delete)}")
    for item_id in safe_to_delete:
        row = conn.execute(
            "SELECT name_en, name_cn FROM items WHERE item_id=?", (item_id,)
        ).fetchone()
        en = row['name_en'] or ''
        cn = row['name_cn'] or ''
        print(f"  {item_id}  {en[:40]:40s} | {cn[:20]}")

    if blocked:
        print(f"\n[JUNK] BLOCKED (in use — will NOT delete): {len(blocked)}")
        for item_id, pr, po in blocked:
            print(f"  {item_id}: {pr} PR refs, {po} PO refs")

    # ── Step 2: Garbled encoding ───────────────────────────────
    garbled_fixes = []
    rows = conn.execute(
        """SELECT item_id, name_en, name_cn FROM items
           WHERE name_en LIKE '%（）%' OR name_en LIKE '%(）%'
              OR name_en LIKE '%（)%' OR name_cn LIKE '%（）%'"""
    ).fetchall()
    for row in rows:
        fixed_en = fix_garbled(row['name_en'])
        fixed_cn = fix_garbled(row['name_cn'])
        if fixed_en != row['name_en'] or fixed_cn != row['name_cn']:
            garbled_fixes.append((row['item_id'], row['name_en'], fixed_en, row['name_cn'], fixed_cn))

    print(f"\n[ENCODING] Garbled name fixes: {len(garbled_fixes)}")
    for item_id, old_en, new_en, old_cn, new_cn in garbled_fixes:
        if old_en != new_en:
            print(f"  {item_id} name_en: '{old_en}' → '{new_en}'")
        if old_cn != new_cn:
            print(f"  {item_id} name_cn: '{old_cn}' → '{new_cn}'")

    # ── Step 3: NULL normalization ─────────────────────────────
    null_counts = {}
    for col in ('name_en', 'name_cn', 'spec', 'uom', 'category', 'department'):
        n = conn.execute(
            f"SELECT COUNT(*) FROM items WHERE {col} = ''", ()
        ).fetchone()[0]
        if n > 0:
            null_counts[col] = n
    total_null = sum(null_counts.values())
    print(f"\n[NULL] Empty-string-to-NULL normalizations: {total_null}")
    for col, n in null_counts.items():
        print(f"  {col}: {n} rows")

    # ── Summary ───────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"Will delete:         {len(safe_to_delete)} junk items")
    print(f"Will fix encoding:   {len(garbled_fixes)} items")
    print(f"Will NULL-normalize: {total_null} fields")

    if DRY_RUN:
        print("\n-- DRY RUN — no changes written --")
        conn.close()
        return

    # ── Apply ─────────────────────────────────────────────────
    for item_id in safe_to_delete:
        conn.execute("DELETE FROM items WHERE item_id=?", (item_id,))

    for item_id, old_en, new_en, old_cn, new_cn in garbled_fixes:
        if old_en != new_en:
            conn.execute("UPDATE items SET name_en=? WHERE item_id=?", (new_en, item_id))
        if old_cn != new_cn:
            conn.execute("UPDATE items SET name_cn=? WHERE item_id=?", (new_cn, item_id))

    for col in ('name_en', 'name_cn', 'spec', 'uom', 'category', 'department'):
        conn.execute(f"UPDATE items SET {col}=NULL WHERE {col}=''")

    conn.commit()
    conn.close()
    print(f"\n✓ Deleted {len(safe_to_delete)} junk items.")
    print(f"✓ Fixed {len(garbled_fixes)} encoding issues.")
    print(f"✓ Normalized {total_null} empty strings to NULL.")


if __name__ == '__main__':
    main()
