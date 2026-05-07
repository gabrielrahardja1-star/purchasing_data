-- PR header
CREATE TABLE IF NOT EXISTS pr (
  pr_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number      TEXT UNIQUE NOT NULL,
  requested_by   TEXT NOT NULL,
  department     TEXT NOT NULL,
  date_requested TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  notes          TEXT
);

-- PR line items
CREATE TABLE IF NOT EXISTS pr_items (
  pr_item_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id          INTEGER NOT NULL REFERENCES pr(pr_id),
  item_id        TEXT NOT NULL REFERENCES items(item_id),
  qty            REAL NOT NULL,
  uom            TEXT NOT NULL,
  est_unit_price REAL,
  notes          TEXT
);

-- Approval log
CREATE TABLE IF NOT EXISTS approvals (
  approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id       INTEGER NOT NULL REFERENCES pr(pr_id),
  approved_by TEXT NOT NULL,
  action      TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  notes       TEXT
);

-- Purchase Order header
CREATE TABLE IF NOT EXISTS po (
  po_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number    TEXT UNIQUE NOT NULL,
  pr_id        INTEGER NOT NULL REFERENCES pr(pr_id),
  vendor_name  TEXT NOT NULL,
  date_created TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  total_amount REAL NOT NULL DEFAULT 0
);

-- PO line items
CREATE TABLE IF NOT EXISTS po_items (
  po_item_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id       INTEGER NOT NULL REFERENCES po(po_id),
  item_id     TEXT NOT NULL REFERENCES items(item_id),
  qty         REAL NOT NULL,
  uom         TEXT NOT NULL,
  unit_price  REAL NOT NULL,
  total_price REAL NOT NULL
);

-- GL export audit log
CREATE TABLE IF NOT EXISTS gl_export_log (
  log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id       INTEGER NOT NULL REFERENCES po(po_id),
  export_date TEXT NOT NULL,
  filename    TEXT NOT NULL
);

ALTER TABLE po_items ADD COLUMN vendor_name TEXT;

-- pr_items additions
ALTER TABLE pr_items ADD COLUMN qty_requested REAL;
ALTER TABLE pr_items ADD COLUMN qty_approved REAL;
ALTER TABLE pr_items ADD COLUMN status TEXT DEFAULT 'pending';

-- po additions
ALTER TABLE po ADD COLUMN qty_ordered REAL;
ALTER TABLE po ADD COLUMN qty_note TEXT;

-- link po_items back to pr_item for PO-per-item lookup
ALTER TABLE po_items ADD COLUMN pr_item_id INTEGER;

-- Pricing workflow additions
-- PR status lifecycle: pending_pricing → pending → approved / rejected
ALTER TABLE pr_items ADD COLUMN estimated_unit_price REAL DEFAULT NULL;
ALTER TABLE pr ADD COLUMN requester_id TEXT;

-- Department moved to line-item level
ALTER TABLE pr_items ADD COLUMN department TEXT;

-- Tax on PO
ALTER TABLE po ADD COLUMN include_vat  INTEGER DEFAULT 0;
ALTER TABLE po ADD COLUMN include_pph23 INTEGER DEFAULT 0;
ALTER TABLE po ADD COLUMN pph_type TEXT DEFAULT NULL;

-- Vendors
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT,
  contact     TEXT,
  phone       TEXT,
  mobile      TEXT,
  email       TEXT,
  address     TEXT,
  city        TEXT,
  npwp        TEXT
);

-- Users / Auth
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('requester', 'purchasing', 'md', 'admin')),
  full_name     TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Phase 4: Vendor FK on po
ALTER TABLE po ADD COLUMN vendor_id TEXT REFERENCES vendors(vendor_id);

-- Phase 5: Base item grouping (self-referential)
ALTER TABLE items ADD COLUMN base_item_id TEXT REFERENCES items(item_id);
