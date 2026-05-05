# CLAUDE.md — PT Merge Mining Industri Procurement App

## Project Overview

Internal web-based procurement system for **PT Merge Mining Industri** that digitises the end-to-end purchasing workflow:

```
Requester submits PR → MD approves/rejects line items → Purchasing creates PO → GL CSV export
```

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Database | SQLite via `better-sqlite3` |
| Auth | `express-session` + `bcryptjs` + `connect-sqlite3` |
| Search | Fuse.js (fuzzy, threshold 0.4) |
| CSV Export | `json2csv` |
| Frontend | Vanilla JS single-page app (`public/index.html`) — no framework |
| Fonts | Inter, Instrument Serif, JetBrains Mono |
| Design | Aurora design system — custom CSS tokens |

## Key Files

- `server.js` — Express server, all API routes, DB init, session setup
- `public/index.html` — entire frontend (single file, vanilla JS)
- `db/schema.sql` — reference schema
- `db/procurement.db` — SQLite database (gitignored in prod; checked in here for local dev)
- `item_master.db` — items table source (imported from `item_master.csv`)
- `ingest.py` — one-time CSV ingest script for item master
- `exports/` — generated GL CSV journal files

## Roles & Default Accounts

| Username | Password | Role |
|---|---|---|
| requester1 | merge2026 | Requester |
| purchasing1 | merge2026 | Purchasing |
| md1 | merge2026 | MD |
| admin1 | merge2026 | Admin |

Role is enforced server-side via session — no client-side switching.

## Data Model (key tables)

```
users           — id, username, password_hash, role, full_name
items           — item_id, name_en, name_cn, category, uom, department
pr              — pr_id, pr_number, requested_by, department, date_requested, status, notes, requester_id
pr_items        — pr_item_id, pr_id, item_id, qty, qty_requested, qty_approved, uom, est_unit_price, status, notes
approvals       — approval_id, pr_id, approved_by, action, timestamp, notes
po              — po_id, po_number, pr_id (nullable), vendor_name, date_created, status, total_amount
po_items        — po_item_id, po_id, pr_item_id, item_id, qty, uom, unit_price, total_price, vendor_name
gl_export_log   — log_id, po_id, export_date, filename
sessions        — managed by connect-sqlite3
```

Auto-generated IDs: `PR-YYYY-NNN`, `PO-YYYY-NNN`, `ITEM-NNNN`

## API Routes (summary)

| Method | Route | Role |
|---|---|---|
| POST | /api/auth/login | Public |
| POST | /api/auth/logout | Public |
| GET | /api/auth/me | Public |
| GET | /api/items | Auth |
| GET | /api/items/search?q= | Auth |
| POST | /api/items | Auth |
| GET | /api/pr | Auth |
| POST | /api/pr | Requester / Purchasing / Admin |
| GET | /api/pr/:id | Auth |
| POST | /api/pr/:id/items/:itemId/approve | MD / Admin |
| GET | /api/pr-items/approved | Purchasing / Admin |
| GET | /api/po | Auth |
| POST | /api/po | Purchasing / Admin |
| GET | /api/po/:id | Auth |
| GET | /api/po/:id/export | Auth |

## GL Export

- 2-line double-entry CSV per PO
- Debit: Account 5000 (Inventory/Expense), Credit: Account 2100 (Accounts Payable)
- Files saved to `./exports/` as `GL_PO-YYYY-NNN_YYYYMMDD.csv`
- Hardcoded account codes (5000 / 2100) — no config UI

## Local Dev Setup

```bash
npm install
export DB_PATH=./item_master.db
npm start
# open http://localhost:3000
```

## Known Limitations (v1)

- No password reset UI — must edit DB directly
- Approver name in MD view is free-text (allows delegation, weaker audit)
- GL account codes are hardcoded
- No PO amendment — POs are immutable once created
- No email/push notifications, no vendor DB, no budget tracking, no multi-currency
