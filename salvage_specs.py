"""
salvage_specs.py — Restore spec values that were cleared from name_en without being moved
to the spec column during the fix_item_names.py run.

Usage:
  python3 salvage_specs.py --dry-run
  python3 salvage_specs.py
  python3 salvage_specs.py --db path/to/other.db
"""

import sqlite3, re, sys, os, argparse

SPEC_LIKE = re.compile(
    r'^('
    r'[\d.,]+\s*(mm|cm|mtr|m|kw|kva|rpm|mpa|bar|psi|kg|ton|inch|"|\')s?'
    r'|[\d.,]+\s*[x*×/]\s*[\d.,].*'
    r'|[φΦΩ].*'
    r'|DN\s*\d+'
    r'|SCH\s*\d+'
    r'|M\d+\*\d+'
    r'|[A-Z]{1,4}[\d][\w.\-/]*'
    r'|[A-Z]-[\d][\w.\-/]*'
    r')',
    re.IGNORECASE
)

parser = argparse.ArgumentParser()
parser.add_argument('--dry-run', action='store_true')
parser.add_argument('--db', default=os.path.join(os.path.dirname(__file__), 'db', 'procurement.db'))
parser.add_argument('--backup', default=os.path.join(os.path.dirname(__file__), 'db', 'procurement.db.backup_20260507'))
args = parser.parse_args()

# Manual overrides: (item_id -> (new_name_en, new_spec))
# For items where current name_en is also a garbage fragment that needs fixing.
MANUAL_OVERRIDES = {
    'ITEM-0339': ('Wire Rope',       'φ26 - 6*19s+FC'),
    'ITEM-0610': ('Socket Set',      '8mm---32mm'),
    'ITEM-0624': ('Valve',           'DN150 PN10/16 QT450 33E6'),
    'ITEM-0628': ('Air Valve',       'PN16 LB150 OT450 30:1'),
    'ITEM-0771': ('Ductile Iron',    'GGG50'),
    'ITEM-0773': ('Cast Iron',       'QT450'),
    'ITEM-0940': ('Wire Rope',       'φ39 6*19+FC'),
    'ITEM-0941': ('Wire Rope',       'φ30 6*19+FC'),
    # Spec cleanup: trim trailing slash
    'ITEM-0563': (None,              '20kg'),
    # Model code cleanup: keep CO2 type + model, drop redundant description words
    'ITEM-0332': (None,              'CO2 YD500GS5'),
}

backup_conn = sqlite3.connect(args.backup)
backup_conn.row_factory = sqlite3.Row
current_conn = sqlite3.connect(args.db)
current_conn.row_factory = sqlite3.Row

updates = []  # list of (item_id, new_name_en_or_None, spec_to_set)

# --- Auto-salvage from backup ---
for row in backup_conn.execute("SELECT item_id, name_en FROM items"):
    item_id = row['item_id']
    old_en = (row['name_en'] or '').strip()

    if not old_en:
        continue

    # Skip if old name_en doesn't look like a spec
    if not SPEC_LIKE.match(old_en):
        continue

    cur = current_conn.execute(
        "SELECT name_en, spec FROM items WHERE item_id=?", (item_id,)
    ).fetchone()
    if not cur:
        continue

    new_spec = (cur['spec'] or '').strip()

    # Only salvage if spec column is still empty
    if new_spec:
        continue

    # Skip items handled by manual override
    if item_id in MANUAL_OVERRIDES:
        continue

    updates.append((item_id, None, old_en))

# --- Manual overrides ---
for item_id, (new_en, new_spec) in MANUAL_OVERRIDES.items():
    cur = current_conn.execute(
        "SELECT name_en, spec FROM items WHERE item_id=?", (item_id,)
    ).fetchone()
    if not cur:
        print(f"WARNING: {item_id} not found in current DB, skipping override")
        continue
    updates.append((item_id, new_en, new_spec))

backup_conn.close()

print(f"Total updates: {len(updates)}")
print()
print(f"{'item_id':<12}  {'new name_en':<35}  spec_to_set")
print('-' * 95)
for item_id, new_en, spec_val in sorted(updates):
    cur = current_conn.execute("SELECT name_en FROM items WHERE item_id=?", (item_id,)).fetchone()
    display_en = new_en if new_en is not None else (cur['name_en'] or '')
    print(f"{item_id:<12}  {display_en:<35}  {spec_val}")

if args.dry_run:
    print("\n-- DRY RUN -- no changes written")
    current_conn.close()
    sys.exit(0)

# Apply
applied = 0
for item_id, new_en, spec_val in updates:
    if new_en is not None:
        current_conn.execute(
            "UPDATE items SET name_en=?, spec=? WHERE item_id=?",
            (new_en, spec_val, item_id)
        )
    else:
        current_conn.execute(
            "UPDATE items SET spec=? WHERE item_id=?",
            (spec_val, item_id)
        )
    applied += 1

current_conn.commit()
current_conn.close()
print(f"\nApplied {applied} updates to {args.db}")
print("Done.")
