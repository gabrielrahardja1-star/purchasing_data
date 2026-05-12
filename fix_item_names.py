"""
fix_item_names.py — Re-apply fixed split_bilingual() to existing items in procurement.db.

The original ingest incorrectly captured spec tokens (dimensions, model codes, part numbers)
as name_en words. This script reconstructs the original bilingual string from stored
name_cn + name_en and re-parses it with the corrected parser.

Usage:
  python3 fix_item_names.py --dry-run   # preview changes
  python3 fix_item_names.py             # apply to procurement.db
  python3 fix_item_names.py --db path/to/other.db
"""

import sqlite3, sys, os, argparse
sys.path.insert(0, os.path.dirname(__file__))
from ingest import split_bilingual

parser = argparse.ArgumentParser()
parser.add_argument('--dry-run', action='store_true')
parser.add_argument('--db', default=os.path.join(os.path.dirname(__file__), 'db', 'procurement.db'))
args = parser.parse_args()

conn = sqlite3.connect(args.db)
conn.row_factory = sqlite3.Row
items = conn.execute("SELECT item_id, name_cn, name_en FROM items").fetchall()

changes = []
for item in items:
    old_cn = item['name_cn'] or ''
    old_en = item['name_en'] or ''

    # Reconstruct bilingual string to re-extract clean name_en
    combined = (old_cn + ' ' + old_en).strip()
    new_cn, new_en = split_bilingual(combined)

    if new_en != old_en:
        changes.append((item['item_id'], old_en, new_en))

print(f"Items scanned : {len(items)}")
print(f"Items to fix  : {len(changes)}")
print(f"Unchanged     : {len(items) - len(changes)}")

if args.dry_run:
    print("\n-- DRY RUN -- sample changes (first 30):")
    print(f"{'item_id':<12}  {'old name_en':<50}  new name_en")
    print('-' * 110)
    for item_id, old_en, new_en in changes[:30]:
        print(f"{item_id:<12}  {old_en:<50}  {new_en or '(empty)'}")
    if len(changes) > 30:
        print(f"  ... and {len(changes) - 30} more")
    sys.exit(0)

# Apply
for item_id, old_en, new_en in changes:
    conn.execute("UPDATE items SET name_en=? WHERE item_id=?", (new_en, item_id))
conn.commit()
conn.close()
print(f"\nApplied {len(changes)} updates to {args.db}")
print("Done.")
