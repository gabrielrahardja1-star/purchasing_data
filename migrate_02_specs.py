"""
migrate_02_specs.py — Phase 2: Extract embedded specs from name_en into spec column.

MUST run after migrate_01_cleanup.py (encoding fixes must be applied first).

Usage:
  python3 migrate_02_specs.py --dry-run   # preview all proposed changes
  python3 migrate_02_specs.py             # apply changes
"""

import sqlite3, sys, os, re
from collections import defaultdict

DB_PATH = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
DRY_RUN = '--dry-run' in sys.argv

# Items where spec IS the entire name — cannot extract a base name, skip and flag.
MANUAL_REVIEW_IDS = {
    'ITEM-0289', 'ITEM-0290', 'ITEM-0291', 'ITEM-0292',
    'ITEM-0295', 'ITEM-0296', 'ITEM-0297', 'ITEM-0298',
}

# ── Spec extraction patterns (priority order — first match wins) ───────────────
# Each entry: (label, compiled_regex)
SPEC_PATTERNS = [
    # 1. Diameter + wire construction: φ26 - 6*19s+FC, φ108*3.5, Φ17.8
    ('diameter',     re.compile(r'[φΦ][\d.]+(?:\s*[-×*]\s*[\d.]+(?:[a-zA-Z+]+)?)*', re.IGNORECASE)),

    # 2. Bolt/thread spec: M16*50, M16*70 8.8级
    ('thread',       re.compile(r'\bM\d+\*\d+(?:\s+\d+(?:\.\d+)?级)?', re.IGNORECASE)),

    # 3. Pipe schedule + size: SCH40 4"inch x 6mtr, SCH80
    ('sch_size',     re.compile(r'SCH\s*\d+(?:\s+[\d/]+["\']\s*inch(?:\s+x\s+[\d.]+\s*mtr?)?)?', re.IGNORECASE)),

    # 4. DN size: DN100, DN 600
    ('dn_size',      re.compile(r'\bDN\s*\d+', re.IGNORECASE)),

    # 5. Dimension chains with * or x: 6*19s+FC, 120*12mtr, 50mm*100mm, 3/4"*1"
    ('dimension',    re.compile(
        r'[\d/]+(?:[\.,]\d+)?(?:\s*mm|m|mtr|inch|")?\s*[×xX*]\s*[\d/]+(?:[\.,]\d+)?(?:\s*mm|m|mtr|inch|")?'
        r'(?:\s*[×xX*]\s*[\d/]+(?:[\.,]\d+)?(?:\s*mm|m|mtr?)?)?',
        re.IGNORECASE
    )),

    # 6. Inch-only spec: 4"inch, 3/4", 1/2"
    ('inch_size',    re.compile(r"""[\d/]+["']\s*(?:inch)?""", re.IGNORECASE)),

    # 7. mm size alone: 30mm, 10mm, 16mm
    ('mm_size',      re.compile(r'\b\d+(?:\.\d+)?\s*mm\b', re.IGNORECASE)),

    # 8. Compound model/catalog: SKF 6205, CJX2-25, NR2-25, LB-75, PGF50
    ('model',        re.compile(r'\b[A-Z]{2,}[-/\s]?[A-Z0-9]*[-/][A-Z0-9]+\b')),

    # 9. Grade in parens: (8.8), (8)
    ('grade',        re.compile(r'\(\s*\d+(?:\.\d+)?\s*\)')),
]


def extract_spec(name_en, existing_spec):
    """
    Returns (cleaned_name_en, extracted_spec) or (name_en, None) if no match.
    - Never extracts if existing_spec is already set (guard).
    - Returns (None, None) if this item needs manual review.
    """
    if existing_spec:
        return name_en, None  # Guard: never overwrite

    for label, pattern in SPEC_PATTERNS:
        m = pattern.search(name_en)
        if m:
            spec = m.group(0).strip()
            # Clean base name: everything before the match, strip trailing junk
            base = name_en[:m.start()].strip()
            base = re.sub(r'[-–\s]+$', '', base).strip()
            if not base:
                return None, None  # Spec is entire name — needs manual review
            # Append anything after the match if it looks like continuation
            tail = name_en[m.end():].strip().lstrip('-–').strip()
            if tail:
                spec = (spec + ' ' + tail).strip()
            return base, spec

    return name_en, None  # No pattern matched


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT item_id, name_en, name_cn, spec FROM items WHERE name_en IS NOT NULL"
    ).fetchall()

    print("=" * 60)
    print("Phase 2: Spec Extraction")
    print("=" * 60)

    changes = []       # (item_id, old_name_en, new_name_en, extracted_spec)
    manual = []        # (item_id, name_en, name_cn) — needs manual review
    skipped_guard = 0  # Already has spec
    no_match = 0       # No pattern matched

    by_pattern = defaultdict(list)

    for row in rows:
        item_id = row['item_id']
        name_en = row['name_en']
        spec = row['spec']

        if item_id in MANUAL_REVIEW_IDS:
            manual.append((item_id, name_en, row['name_cn'] or ''))
            continue

        if spec:
            skipped_guard += 1
            continue

        base, extracted = extract_spec(name_en, spec)

        if base is None and extracted is None and spec is None:
            # extract_spec returned (None, None) — spec was entire name
            manual.append((item_id, name_en, row['name_cn'] or ''))
            continue

        if extracted:
            # Determine which pattern matched (re-run to get label)
            for label, pattern in SPEC_PATTERNS:
                if pattern.search(name_en):
                    by_pattern[label].append(item_id)
                    break
            changes.append((item_id, name_en, base, extracted))
        else:
            no_match += 1

    # ── Print summary ─────────────────────────────────────────
    print(f"\nItems with spec already set (skipped): {skipped_guard}")
    print(f"Items with no spec pattern found:       {no_match}")
    print(f"Items flagged for MANUAL REVIEW:        {len(manual)}")
    print(f"Items to extract spec from:             {len(changes)}")

    print(f"\nBy pattern type:")
    for label, ids in sorted(by_pattern.items()):
        print(f"  {label:15s} {len(ids)}")

    print(f"\n{'─'*60}")
    print("Proposed changes (first 50 shown):")
    for item_id, old_en, new_en, spec in changes[:50]:
        print(f"  {item_id}  '{old_en[:40]:40s}' → name_en='{new_en[:30]:30s}' spec='{spec[:25]}'")
    if len(changes) > 50:
        print(f"  ... and {len(changes)-50} more (use --dry-run to see all)")

    print(f"\n{'─'*60}")
    print("MANUAL REVIEW NEEDED (spec appears to be entire name):")
    for item_id, en, cn in manual:
        print(f"  {item_id}  name_en='{en}' | name_cn='{cn}'")

    if DRY_RUN:
        print("\n-- DRY RUN — no changes written --")
        if '--verbose' in sys.argv:
            print("\nFull change list:")
            for item_id, old_en, new_en, spec in changes:
                print(f"  {item_id}  '{old_en}' → '{new_en}' | spec='{spec}'")
        conn.close()
        return

    updated = 0
    for item_id, old_en, new_en, spec in changes:
        conn.execute(
            "UPDATE items SET name_en=?, spec=? WHERE item_id=?",
            (new_en, spec, item_id)
        )
        updated += 1

    conn.commit()
    conn.close()
    print(f"\n✓ Updated {updated} items (name_en cleaned, spec extracted).")
    print(f"  {len(manual)} items need manual review — name_en unchanged.")


if __name__ == '__main__':
    main()
