"""
migrate_05_base_items.py — Phase 5: Item base grouping.

Adds base_item_id column to items (self-referential). Groups items that share
the same base name (after spec extraction) so spend can be aggregated.

MUST run after migrate_02_specs.py (needs clean name_en values).

Usage:
  python3 migrate_05_base_items.py --dry-run            # preview groupings
  python3 migrate_05_base_items.py --dry-run --verbose  # show all groups
  python3 migrate_05_base_items.py                      # apply
"""

import sqlite3, sys, os, re
from collections import defaultdict

DB_PATH = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
DRY_RUN = '--dry-run' in sys.argv
VERBOSE = '--verbose' in sys.argv

# Min group size to assign base_item_id (groups of 1 item need no grouping)
MIN_GROUP_SIZE = 2


def normalize_base_name(name_en):
    """
    Produce a grouping key from name_en by stripping trailing spec tokens.
    Returns None if name_en is empty/None.
    """
    if not name_en:
        return None
    n = name_en.lower().strip()

    # Strip trailing dimension: "10mm", "16mm", "3/4"", "4'inch"
    n = re.sub(r'\s+[\d/]+["\']\s*(?:inch)?\s*$', '', n)
    n = re.sub(r'\s+\d+(?:[./]\d+)?\s*mm\s*$', '', n, flags=re.IGNORECASE)

    # Strip trailing diameter: "φ17.8", "Φ60"
    n = re.sub(r'\s+[φΦ][\d.]+\s*$', '', n)

    # Strip trailing schedule: "sch40", "sch 80"
    n = re.sub(r'\s+sch\s*\d+.*$', '', n, flags=re.IGNORECASE)

    # Strip trailing DN: "dn100"
    n = re.sub(r'\s+dn\s*\d+\s*$', '', n, flags=re.IGNORECASE)

    # Strip trailing model/catalog at end: "SKF 6205", "NR2-25"
    n = re.sub(r'\s+[A-Z]{2,}[\s-][A-Z0-9][\w-]*\s*$', '', n)

    # Strip trailing bare numbers: "10", "25", "200"
    n = re.sub(r'\s+\d+\s*$', '', n)

    # Collapse whitespace
    n = re.sub(r'\s+', ' ', n).strip()

    return n if n else None


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT item_id, name_en, name_cn, spec, category FROM items ORDER BY item_id"
    ).fetchall()

    print("=" * 60)
    print("Phase 5: Item Base Grouping")
    print("=" * 60)

    # ── Build groups by normalized base name ──────────────────
    groups = defaultdict(list)  # base_key → [item_id, ...]
    no_base = []

    for row in rows:
        base_key = normalize_base_name(row['name_en'])
        if base_key:
            groups[base_key].append(row['item_id'])
        else:
            no_base.append(row['item_id'])

    # Keep only groups with 2+ members
    multi = {k: v for k, v in groups.items() if len(v) >= MIN_GROUP_SIZE}
    single = {k: v for k, v in groups.items() if len(v) < MIN_GROUP_SIZE}

    assignments = []  # (variant_item_id, canonical_base_item_id)
    for base_key, item_ids in sorted(multi.items()):
        canonical = item_ids[0]  # Lowest item_id = canonical base
        for variant_id in item_ids[1:]:
            assignments.append((variant_id, canonical))

    print(f"\nTotal items: {len(rows)}")
    print(f"Items with no extractable base name: {len(no_base)}")
    print(f"Unique base names (all groups): {len(groups)}")
    print(f"Groups with 2+ variants: {len(multi)}")
    print(f"Variant assignments to make: {len(assignments)}")

    # ── Print grouped results ─────────────────────────────────
    print(f"\nGroups (showing all {len(multi)} multi-item groups):")
    for base_key, item_ids in sorted(multi.items(), key=lambda x: -len(x[1])):
        canonical = item_ids[0]
        base_row = next(r for r in rows if r['item_id'] == canonical)
        cat = base_row['category'] or ''
        print(f"\n  [{cat:15s}] '{base_key}' ({len(item_ids)} items, base={canonical})")
        for iid in item_ids:
            r = next(r for r in rows if r['item_id'] == iid)
            spec = r['spec'] or ''
            marker = '← BASE' if iid == canonical else '  variant'
            print(f"    {iid}  {r['name_en'] or '':40s} spec='{spec[:20]:20s}' {marker}")

    # ── Check if column already exists ───────────────────────
    cols = [c[1] for c in conn.execute("PRAGMA table_info(items)").fetchall()]
    has_col = 'base_item_id' in cols
    print(f"\nbase_item_id column exists: {has_col}")
    if not has_col:
        print("  → Will run: ALTER TABLE items ADD COLUMN base_item_id TEXT")

    if DRY_RUN:
        print("\n-- DRY RUN — no changes written --")
        print(f"\nReview the groupings above carefully before applying.")
        print(f"If any groups look wrong, add item_id pairs to the OVERRIDES dict in this script.")
        conn.close()
        return

    # ── Apply ─────────────────────────────────────────────────
    if not has_col:
        conn.execute(
            "ALTER TABLE items ADD COLUMN base_item_id TEXT REFERENCES items(item_id)"
        )

    # Clear any existing assignments first (idempotent re-run)
    conn.execute("UPDATE items SET base_item_id=NULL")

    for variant_id, canonical_id in assignments:
        conn.execute(
            "UPDATE items SET base_item_id=? WHERE item_id=?",
            (canonical_id, variant_id)
        )

    conn.commit()
    conn.close()
    print(f"\n✓ Assigned {len(assignments)} variants to {len(multi)} base item groups.")
    print(f"  {len(no_base)} items with no base name left ungrouped (base_item_id=NULL).")


if __name__ == '__main__':
    main()
