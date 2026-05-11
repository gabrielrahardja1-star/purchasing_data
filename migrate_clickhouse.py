"""
migrate_clickhouse.py — Migrate data from SQLite → ClickHouse.

Reads from db/procurement.db, inserts into ClickHouse via HTTP API.
Preserves all existing data via legacy_* columns for traceability.

Usage:
  python3 migrate_clickhouse.py --dry-run   # preview row counts only
  python3 migrate_clickhouse.py             # run migration
  python3 migrate_clickhouse.py --host localhost --port 8123

Environment / flags:
  --host      ClickHouse HTTP host (default: localhost)
  --port      ClickHouse HTTP port (default: 8123)
  --db        ClickHouse database (default: procurement)
  --user      ClickHouse user (default: procurement_user)
  --password  ClickHouse password (default: read from CLICKHOUSE_PASSWORD env)
"""

import sqlite3, sys, os, json, uuid, argparse
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

try:
    import requests
except ImportError:
    print("ERROR: pip install requests")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument('--dry-run',   action='store_true')
parser.add_argument('--host',      default='localhost')
parser.add_argument('--port',      type=int, default=8123)
parser.add_argument('--db',        default='procurement')
parser.add_argument('--user',      default='procurement_user')
parser.add_argument('--password',  default=os.environ.get('CLICKHOUSE_PASSWORD', 'changeme'))
args = parser.parse_args()

DRY_RUN   = args.dry_run
CH_URL    = f"http://{args.host}:{args.port}"
CH_DB     = args.db
CH_AUTH   = (args.user, args.password)
DB_PATH   = os.path.join(os.path.dirname(__file__), 'db', 'procurement.db')
TZ_JKT    = ZoneInfo('Asia/Jakarta')
COMPANY_ID = 'PTMMI'  # PT Merge Mining Industri

# ── Helpers ───────────────────────────────────────────────────────────────────

def now_ts():
    return datetime.now(TZ_JKT).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

def to_dt(s):
    """Convert ISO date string or None to ClickHouse DateTime64 string."""
    if not s:
        return now_ts()
    try:
        # Already a datetime string
        dt = datetime.fromisoformat(str(s))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=TZ_JKT)
        return dt.strftime('%Y-%m-%d %H:%M:%S.000')
    except Exception:
        return now_ts()

def new_uuid():
    return str(uuid.uuid4())

def ch_insert(table, rows):
    """Insert rows (list of dicts) into ClickHouse via HTTP NDJSON."""
    if not rows:
        return
    ndjson = '\n'.join(json.dumps(r) for r in rows)
    url = f"{CH_URL}/?database={CH_DB}&query=INSERT+INTO+{table}+FORMAT+JSONEachRow"
    resp = requests.post(url, data=ndjson.encode('utf-8'), auth=CH_AUTH,
                         headers={'Content-Type': 'application/x-ndjson'})
    if resp.status_code != 200:
        raise RuntimeError(f"ClickHouse insert into {table} failed: {resp.text[:500]}")

def ch_query(sql):
    """Run a SELECT query and return JSON rows."""
    resp = requests.post(
        f"{CH_URL}/?database={CH_DB}&default_format=JSONEachRow",
        data=sql.encode('utf-8'), auth=CH_AUTH
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ClickHouse query failed: {resp.text[:500]}")
    lines = [l for l in resp.text.strip().split('\n') if l]
    return [json.loads(l) for l in lines]

def ch_ping():
    try:
        resp = requests.get(f"{CH_URL}/ping", auth=CH_AUTH, timeout=5)
        return resp.status_code == 200
    except Exception:
        return False

def sqlite_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ── Migration steps ───────────────────────────────────────────────────────────

def migrate_company():
    """Seed the single company row."""
    rows = [{
        'company_id':    COMPANY_ID,
        'company_name':  'PT Merge Mining Industri',
        'legal_name':    'PT Merge Mining Industri',
        'npwp':          '',
        'address':       '',
        'city':          '',
        'country':       'ID',
        'base_currency': 'IDR',
        'status':        'active',
        'version':       int(datetime.now().timestamp() * 1000),
        'is_deleted':    0,
        'created_at':    now_ts(),
        'updated_at':    now_ts(),
    }]
    print(f"  companies: 1 row")
    if not DRY_RUN:
        ch_insert('companies', rows)


def migrate_users(conn):
    sqlite_rows = conn.execute("SELECT * FROM users").fetchall()
    rows = []
    id_map = {}  # legacy int id → uuid string
    for r in sqlite_rows:
        uid = new_uuid()
        id_map[r['id']] = uid
        rows.append({
            'user_id':          uid,
            'legacy_user_id':   r['id'],
            'company_id':       COMPANY_ID,
            'username':         r['username'] or '',
            'password_hash':    r['password_hash'] or '',
            'role':             r['role'] or '',
            'full_name':        r['full_name'] or '',
            'email':            '',
            'department_id':    '',
            'status':           'active',
            'version':          int(datetime.now().timestamp() * 1000),
            'is_deleted':       0,
            'created_at':       to_dt(r['created_at'] if 'created_at' in r.keys() else None),
            'updated_at':       now_ts(),
        })
    print(f"  users: {len(rows)} rows")
    if not DRY_RUN:
        ch_insert('users', rows)
    return id_map


def migrate_vendors(conn):
    sqlite_rows = conn.execute("SELECT * FROM vendors").fetchall()
    rows = []
    id_map = {}  # legacy vendor_id string → same (already string IDs)
    for r in sqlite_rows:
        id_map[r['vendor_id']] = r['vendor_id']
        search = ' '.join(filter(None, [r['name'], r['vendor_id'], r['city'] or '', r['npwp'] or ''])).lower()
        rows.append({
            'vendor_id':        r['vendor_id'],
            'company_id':       COMPANY_ID,
            'vendor_code':      r['vendor_id'],
            'vendor_name':      r['name'] or '',
            'category':         r['category'] or '',
            'status':           'active',
            'contact_person':   r['contact'] or '',
            'phone':            r['phone'] or '',
            'mobile':           r['mobile'] or '',
            'email':            r['email'] or '',
            'address':          r['address'] or '',
            'city':             r['city'] or '',
            'country':          'ID',
            'npwp':             r['npwp'] or '',
            'payment_term_id':  '',
            'default_currency': 'IDR',
            'tax_profile':      '',
            'risk_rating':      '',
            'onboarding_date':  None,
            'blocked_reason':   '',
            'search_text':      search,
            'version':          int(datetime.now().timestamp() * 1000),
            'is_deleted':       0,
            'created_at':       now_ts(),
            'updated_at':       now_ts(),
        })
    print(f"  vendors: {len(rows)} rows")
    if not DRY_RUN:
        ch_insert('vendors', rows)
    return id_map


def migrate_items(conn):
    sqlite_rows = conn.execute("SELECT * FROM items").fetchall()
    rows = []
    for r in sqlite_rows:
        search = ' '.join(filter(None, [
            r['name_en'] or '', r['name_cn'] or '',
            r['spec'] or '', r['item_id']
        ])).lower()
        rows.append({
            'item_id':              r['item_id'],
            'company_id':           COMPANY_ID,
            'base_item_id':         r['base_item_id'] or '',
            'item_code':            r['item_id'],
            'name_en':              r['name_en'] or '',
            'name_cn':              r['name_cn'] or '',
            'category_id':          '',
            'category_name':        r['category'] or '',
            'spec':                 r['spec'] or '',
            'uom':                  r['uom'] or 'pcs',
            'department_id':        '',
            'item_type':            'expense',
            'default_gl_account_id': '',
            'min_order_qty':        0,
            'lead_time_days':       0,
            'status':               'active',
            'search_text':          search,
            'version':              int(datetime.now().timestamp() * 1000),
            'is_deleted':           0,
            'created_at':           now_ts(),
            'updated_at':           now_ts(),
        })
    print(f"  items: {len(rows)} rows")
    if not DRY_RUN:
        ch_insert('items', rows)


def migrate_pr(conn, user_id_map):
    pr_rows    = conn.execute("SELECT * FROM pr ORDER BY pr_id").fetchall()
    item_rows  = conn.execute("SELECT * FROM pr_items ORDER BY pr_item_id").fetchall()
    appr_rows  = conn.execute("SELECT * FROM approvals ORDER BY approval_id").fetchall()

    # Build UUID maps
    pr_uuid_map      = {r['pr_id']:      new_uuid() for r in pr_rows}
    pr_item_uuid_map = {r['pr_item_id']: new_uuid() for r in item_rows}

    # PR headers
    pr_inserts = []
    for r in pr_rows:
        pr_uuid = pr_uuid_map[r['pr_id']]
        search  = ' '.join(filter(None, [r['pr_number'], r['requested_by'] or '', r['department'] or ''])).lower()
        pr_inserts.append({
            'pr_id':                  pr_uuid,
            'legacy_pr_id':           r['pr_id'],
            'company_id':             COMPANY_ID,
            'pr_number':              r['pr_number'] or '',
            'requester_user_id':      '',
            'requested_by_name':      r['requested_by'] or '',
            'department_id':          '',
            'cost_center_id':         '',
            'pr_date':                r['date_requested'] or str(datetime.now().date()),
            'needed_by_date':         None,
            'priority':               'normal',
            'status':                 r['status'] or 'pending',
            'total_estimated_amount': 0,
            'currency':               'IDR',
            'notes':                  r['notes'] or '',
            'search_text':            search,
            'version':                int(datetime.now().timestamp() * 1000),
            'is_deleted':             0,
            'created_at':             now_ts(),
            'updated_at':             now_ts(),
        })

    # PR items
    pri_inserts = []
    for r in item_rows:
        pr_item_uuid = pr_item_uuid_map[r['pr_item_id']]
        pr_uuid      = pr_uuid_map.get(r['pr_id'], '')
        qty_req      = r['qty_requested'] or r['qty'] or 0
        qty_app      = r['qty_approved'] or 0
        est_price    = r['est_unit_price'] or r.get('estimated_unit_price') or 0
        pri_inserts.append({
            'pr_item_id':             pr_item_uuid,
            'legacy_pr_item_id':      r['pr_item_id'],
            'company_id':             COMPANY_ID,
            'pr_id':                  pr_uuid,
            'line_no':                r['pr_item_id'],
            'item_id':                r['item_id'] or '',
            'item_description':       '',
            'requested_qty':          float(qty_req),
            'approved_qty':           float(qty_app),
            'uom':                    r['uom'] or 'pcs',
            'estimated_unit_price':   float(est_price),
            'estimated_total_price':  float(qty_req) * float(est_price),
            'department_id':          r['department'] or '',
            'cost_center_id':         '',
            'gl_account_id':          '',
            'status':                 r['status'] or 'pending',
            'notes':                  r['notes'] or '',
            'version':                int(datetime.now().timestamp() * 1000),
            'is_deleted':             0,
            'created_at':             now_ts(),
            'updated_at':             now_ts(),
        })

    # Approvals → approval_actions
    appr_inserts = []
    for r in appr_rows:
        pr_uuid = pr_uuid_map.get(r['pr_id'], '')
        appr_inserts.append({
            'approval_action_id': new_uuid(),
            'company_id':         COMPANY_ID,
            'document_type':      'purchase_request',
            'document_id':        pr_uuid,
            'document_item_id':   '',
            'workflow_id':        '',
            'step_no':            1,
            'actor_user_id':      '',
            'actor_name':         r['approved_by'] or '',
            'action':             r['action'] or 'approve',
            'action_at':          to_dt(r['timestamp']),
            'from_status':        '',
            'to_status':          r['action'] or '',
            'approved_qty':       None,
            'notes':              r['notes'] or '',
        })

    print(f"  purchase_requests: {len(pr_inserts)} rows")
    print(f"  purchase_request_items: {len(pri_inserts)} rows")
    print(f"  approval_actions (from PR approvals): {len(appr_inserts)} rows")

    if not DRY_RUN:
        ch_insert('purchase_requests',      pr_inserts)
        ch_insert('purchase_request_items', pri_inserts)
        ch_insert('approval_actions',       appr_inserts)

    return pr_uuid_map, pr_item_uuid_map


def migrate_po(conn, pr_uuid_map, pr_item_uuid_map, vendor_id_map):
    po_rows      = conn.execute("SELECT * FROM po ORDER BY po_id").fetchall()
    po_item_rows = conn.execute("SELECT * FROM po_items ORDER BY po_item_id").fetchall()
    gl_rows      = conn.execute("SELECT * FROM gl_export_log").fetchall()

    po_uuid_map      = {r['po_id']: new_uuid() for r in po_rows}
    po_item_uuid_map = {r['po_item_id']: new_uuid() for r in po_item_rows}

    # PO headers
    po_inserts = []
    for r in po_rows:
        search = ' '.join(filter(None, [r['po_number'], r['vendor_name'] or ''])).lower()
        # Tax: include_vat → tax line table handled separately
        include_vat  = r['include_vat'] or 0
        pph_type     = r.get('pph_type') or ''
        total        = r['total_amount'] or 0
        po_inserts.append({
            'po_id':                  po_uuid_map[r['po_id']],
            'legacy_po_id':           r['po_id'],
            'company_id':             COMPANY_ID,
            'po_number':              r['po_number'] or '',
            'primary_pr_id':          pr_uuid_map.get(r['pr_id'], '') if r['pr_id'] else '',
            'vendor_id':              r.get('vendor_id') or '',
            'vendor_name':            r['vendor_name'] or '',
            'po_date':                r['date_created'] or str(datetime.now().date()),
            'expected_delivery_date': None,
            'currency':               'IDR',
            'exchange_rate':          1,
            'payment_term_id':        '',
            'status':                 r['status'] or 'draft',
            'subtotal_amount':        float(total),
            'discount_amount':        0,
            'tax_amount':             0,
            'withholding_amount':     0,
            'total_amount':           float(total),
            'notes':                  '',
            'search_text':            search,
            'created_by_user_id':     '',
            'version':                int(datetime.now().timestamp() * 1000),
            'is_deleted':             0,
            'created_at':             now_ts(),
            'updated_at':             now_ts(),
        })

    # PO items
    poi_inserts = []
    for r in po_item_rows:
        po_uuid     = po_uuid_map.get(r['po_id'], '')
        pr_item_uuid = pr_item_uuid_map.get(r['pr_item_id'], '') if r['pr_item_id'] else ''
        qty         = r['qty'] or 0
        price       = r['unit_price'] or 0
        total       = r['total_price'] or float(qty) * float(price)
        poi_inserts.append({
            'po_item_id':         po_item_uuid_map[r['po_item_id']],
            'legacy_po_item_id':  r['po_item_id'],
            'company_id':         COMPANY_ID,
            'po_id':              po_uuid,
            'line_no':            r['po_item_id'],
            'pr_item_id':         pr_item_uuid,
            'quotation_item_id':  '',
            'item_id':            r['item_id'] or '',
            'item_description':   '',
            'ordered_qty':        float(qty),
            'received_qty':       0,
            'invoiced_qty':       0,
            'uom':                r['uom'] or 'pcs',
            'unit_price':         float(price),
            'discount_amount':    0,
            'tax_amount':         0,
            'total_price':        float(total),
            'gl_account_id':      '',
            'cost_center_id':     '',
            'vendor_name':        r['vendor_name'] or '',
            'status':             'open',
            'notes':              '',
            'version':            int(datetime.now().timestamp() * 1000),
            'is_deleted':         0,
            'created_at':         now_ts(),
            'updated_at':         now_ts(),
        })

    # GL export log
    gl_inserts = []
    for r in gl_rows:
        po_uuid = po_uuid_map.get(r['po_id'], '')
        gl_inserts.append({
            'gl_export_id':          new_uuid(),
            'legacy_log_id':         r['log_id'],
            'company_id':            COMPANY_ID,
            'source_document_type':  'purchase_order',
            'source_document_id':    po_uuid,
            'export_number':         '',
            'export_date':           r['export_date'] or str(datetime.now().date()),
            'filename':              r['filename'] or '',
            'status':                'generated',
            'exported_by_user_id':   '',
            'notes':                 '',
        })

    print(f"  purchase_orders: {len(po_inserts)} rows")
    print(f"  purchase_order_items: {len(poi_inserts)} rows")
    print(f"  gl_exports: {len(gl_inserts)} rows")

    if not DRY_RUN:
        ch_insert('purchase_orders',      po_inserts)
        ch_insert('purchase_order_items', poi_inserts)
        ch_insert('gl_exports',           gl_inserts)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("ClickHouse Migration: SQLite → ClickHouse")
    print("=" * 60)

    if DRY_RUN:
        print("\n[DRY RUN] Will preview row counts only — no data written.\n")
    else:
        if not ch_ping():
            print(f"\nERROR: Cannot reach ClickHouse at {CH_URL}")
            print("Make sure the container is running: docker compose up -d clickhouse")
            sys.exit(1)
        print(f"Connected to ClickHouse at {CH_URL}, database: {CH_DB}\n")

    conn = sqlite_connect()

    print("Migrating:")
    migrate_company()
    user_id_map   = migrate_users(conn)
    vendor_id_map = migrate_vendors(conn)
    migrate_items(conn)
    pr_uuid_map, pr_item_uuid_map = migrate_pr(conn, user_id_map)
    migrate_po(conn, pr_uuid_map, pr_item_uuid_map, vendor_id_map)

    conn.close()

    if DRY_RUN:
        print("\n-- DRY RUN complete — no data written --")
    else:
        print("\n✓ Migration complete.")
        print("  Verify with:")
        print(f"  curl -s 'http://{args.host}:{args.port}/?database={CH_DB}&query=SELECT+name,total_rows+FROM+system.tables+WHERE+database=%27{CH_DB}%27+ORDER+BY+name' -u {args.user}:****")


if __name__ == '__main__':
    main()
