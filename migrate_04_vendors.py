"""
migrate_04_vendors.py — Phase 4: Populate vendors table; add vendor_id FK to po.

Extracts distinct vendor names from po.vendor_name and po_items.vendor_name,
inserts them into the vendors table, adds vendor_id column to po, backfills it.

Usage:
  python3 migrate_04_vendors.py --dry-run   # preview
  python3 migrate_04_vendors.py             # apply
"""

import sqlite3, sys, os, re

DB_PATH = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
DRY_RUN = '--dry-run' in sys.argv

PLACEHOLDER_VENDORS = {'pt. barang', 'barang', 'vendor', 'test'}  # flag these


def normalize_name(name):
    """Strip and collapse internal whitespace."""
    return re.sub(r'\s+', ' ', (name or '').strip())


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("=" * 60)
    print("Phase 4: Vendor Normalization")
    print("=" * 60)

    # ── Collect all distinct vendor names ─────────────────────
    po_vendors = {
        normalize_name(r[0])
        for r in conn.execute(
            "SELECT DISTINCT vendor_name FROM po WHERE vendor_name IS NOT NULL AND vendor_name != ''"
        )
    }
    poi_vendors = {
        normalize_name(r[0])
        for r in conn.execute(
            "SELECT DISTINCT vendor_name FROM po_items WHERE vendor_name IS NOT NULL AND vendor_name != ''"
        )
    }
    all_vendors = sorted(po_vendors | poi_vendors)

    existing_count = conn.execute("SELECT COUNT(*) FROM vendors").fetchone()[0]
    print(f"\nExisting vendors in table: {existing_count}")
    print(f"Distinct vendor names found in POs: {len(all_vendors)}")
    for v in all_vendors:
        flag = ' ← ⚠ PLACEHOLDER?' if v.lower() in PLACEHOLDER_VENDORS else ''
        print(f"  '{v}'{flag}")

    # ── Determine which are new ───────────────────────────────
    to_insert = []
    last_id = conn.execute(
        "SELECT vendor_id FROM vendors ORDER BY vendor_id DESC LIMIT 1"
    ).fetchone()
    next_num = int(last_id[0].replace('VEND-', '')) + 1 if last_id else 1

    for name in all_vendors:
        exists = conn.execute(
            "SELECT vendor_id FROM vendors WHERE LOWER(TRIM(name))=LOWER(TRIM(?))",
            (name,)
        ).fetchone()
        if not exists:
            vendor_id = f"VEND-{next_num:03d}"
            to_insert.append((vendor_id, name))
            next_num += 1

    print(f"\nNew vendors to insert: {len(to_insert)}")
    for vid, name in to_insert:
        flag = ' ← ⚠ PLACEHOLDER?' if name.lower() in PLACEHOLDER_VENDORS else ''
        print(f"  {vid}: '{name}'{flag}")

    # ── PO backfill preview ───────────────────────────────────
    po_rows = conn.execute(
        "SELECT po_id, po_number, vendor_name FROM po ORDER BY po_number"
    ).fetchall()

    # Build lookup: normalized name → vendor_id (existing + to-insert)
    name_to_id = {
        normalize_name(r['name']).lower(): r['vendor_id']
        for r in conn.execute("SELECT vendor_id, name FROM vendors")
    }
    for vid, name in to_insert:
        name_to_id[name.lower()] = vid

    print(f"\nPO vendor_id backfill ({len(po_rows)} POs):")
    unmatched = []
    for row in po_rows:
        norm = normalize_name(row['vendor_name']).lower()
        vid = name_to_id.get(norm, '??')
        flag = ' ← ⚠ UNMATCHED' if vid == '??' else ''
        print(f"  {row['po_number']}: '{row['vendor_name']}' → {vid}{flag}")
        if vid == '??':
            unmatched.append(row['po_number'])

    # ── Check if vendor_id column already exists on po ────────
    cols = [c[1] for c in conn.execute("PRAGMA table_info(po)").fetchall()]
    has_vendor_id = 'vendor_id' in cols
    print(f"\npo.vendor_id column exists: {has_vendor_id}")
    if not has_vendor_id:
        print("  → Will run: ALTER TABLE po ADD COLUMN vendor_id TEXT")

    if DRY_RUN:
        print("\n-- DRY RUN — no changes written --")
        conn.close()
        return

    # ── Apply ─────────────────────────────────────────────────
    for vendor_id, name in to_insert:
        conn.execute(
            "INSERT INTO vendors (vendor_id, name) VALUES (?, ?)",
            (vendor_id, name)
        )

    if not has_vendor_id:
        conn.execute(
            "ALTER TABLE po ADD COLUMN vendor_id TEXT REFERENCES vendors(vendor_id)"
        )

    for row in po_rows:
        norm = normalize_name(row['vendor_name']).lower()
        vid = name_to_id.get(norm)
        if vid:
            conn.execute(
                "UPDATE po SET vendor_id=? WHERE po_id=?",
                (vid, row['po_id'])
            )

    conn.commit()
    conn.close()
    print(f"\n✓ Inserted {len(to_insert)} vendors.")
    print(f"✓ Backfilled vendor_id on {len(po_rows) - len(unmatched)}/{len(po_rows)} POs.")
    if unmatched:
        print(f"  ⚠ Unmatched POs (vendor_id still NULL): {unmatched}")


if __name__ == '__main__':
    main()
