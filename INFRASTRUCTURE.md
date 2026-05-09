# Infrastructure & Data Governance

## Deployment Overview

| Component | Details |
|---|---|
| Provider | Hostinger VPS |
| Server IP | `76.13.19.246` |
| App URL | `http://76.13.19.246:3000` |
| Runtime | Docker + docker-compose |
| Container | `procurement_app` (Node.js 22, Alpine) |
| SSH | `root@76.13.19.246` (password auth) |

---

## Architecture

```
Host: /opt/purchasing_data/
├── docker-compose.yml
├── Dockerfile
├── data/
│   └── procurement.db          ← bind-mounted into container (NOT baked in)
└── exports/
    └── GL_PO-*.csv             ← bind-mounted into container

Container: /app/
├── server.js                   ← Express API + DB init
├── public/
│   └── index.html              ← entire frontend (vanilla JS SPA)
├── db/
│   └── schema.sql              ← schema run on every startup
├── data/                       ← bind-mount from host data/
│   └── procurement.db          ← live database
└── exports/                    ← bind-mount from host exports/
    └── GL_PO-*.csv
```

The database and exports live **on the host**, not inside the container. Rebuilding or redeploying the container never touches data.

### Item Master Location

| Location | Path |
|---|---|
| Live DB (server) | `/opt/purchasing_data/data/procurement.db` → table `items` |
| Live DB (local) | `db/procurement.db` → table `items` |
| Original source | `item_master.csv` (imported once via `ingest.py`) |
| Excel sources | `2025年月度材料计划/*.xlsx` + extra files (ingested via `enrich_items.py`) |
| Schema definition | `db/schema.sql` — `items` table columns: `item_id`, `name_en`, `name_cn`, `category`, `spec`, `uom`, `department`, `base_item_id` |

---

## Code Deployment

```bash
# SSH into server
ssh root@76.13.19.246

# Pull latest code and rebuild
cd /opt/purchasing_data
git pull                              # enter GitHub credentials when prompted
docker compose up -d --build
```

**Note:** GitHub credentials must be entered interactively. `git config --global credential.helper store` would cache them after one entry.

---

## Database Governance

### Principle
Migrations run **locally**, are reviewed with `--dry-run`, then the resulting DB is uploaded to the server. The server never runs migrations directly.

### Workflow

```bash
# 1. Backup before any change
cp db/procurement.db "db/procurement.db.backup_$(date +%Y%m%d)"

# 2. Run migration with dry-run first
python3 migrate_XX_name.py --dry-run

# 3. Review output, then apply
python3 migrate_XX_name.py

# 4. Checkpoint WAL into main file before upload
sqlite3 db/procurement.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 5. Upload to server (stop container first to avoid lock conflicts)
ssh root@76.13.19.246 "docker stop procurement_app && rm -f /opt/purchasing_data/data/procurement.db-shm /opt/purchasing_data/data/procurement.db-wal"
scp db/procurement.db root@76.13.19.246:/opt/purchasing_data/data/procurement.db
ssh root@76.13.19.246 "docker start procurement_app"
```

### Migration Scripts

| Script | Phase | What it does |
|---|---|---|
| `migrate_01_cleanup.py` | 1 | Delete junk items, fix garbled encoding, NULL-normalize |
| `migrate_02_specs.py` | 2 | Extract embedded specs from item names (413 items) |
| `migrate_03_uom.py` | 3 | Standardize 39 UOM variants → 14 canonical codes |
| `migrate_04_vendors.py` | 4 | Populate vendors table, add `vendor_id` FK on PO |
| `migrate_05_base_items.py` | 5 | Group item variants via `base_item_id` (91 groups) |
| `enrich_items.py` | — | Ingest new items from Excel material plans |
| `recategorize.py` | — | Bulk keyword-based recategorization of items |

All scripts support `--dry-run`. Always run dry-run first and review output before applying.

### Known Risks

| Risk | Mitigation |
|---|---|
| Uploading wrong DB file (stale/pre-migration) | Always checkpoint WAL, verify item count with `sqlite3 db/procurement.db "SELECT COUNT(*) FROM items;"` before scp |
| WAL files causing corruption on server | Stop container before upload, delete `-shm`/`-wal` files on server first |
| DB locked by local Node server | Kill local server (`lsof db/procurement.db` → `kill <PID>`) before running migrations |
| No automated server-side backups | **Pending** — cron job not yet set up |

---

## DB Schema Overview

```
items           — item_id, name_en, name_cn, category, spec, uom, department, base_item_id
vendors         — vendor_id, name, category, contact, phone, npwp, ...
pr              — pr_id, pr_number, requested_by, department, status, requester_id
pr_items        — pr_item_id, pr_id, item_id, qty, qty_approved, uom, status
approvals       — approval_id, pr_id, approved_by, action, timestamp
po              — po_id, po_number, pr_id, vendor_name, vendor_id, status, include_vat, ...
po_items        — po_item_id, po_id, pr_item_id, item_id, qty, uom, unit_price, vendor_name
gl_export_log   — log_id, po_id, export_date, filename
users           — id, username, password_hash, role, full_name
```

Schema is initialized from `db/schema.sql` on every server start. `ALTER TABLE` statements are idempotent — duplicate column errors are silently ignored.

---

## Current Gaps (Pending)

- [ ] Automated daily DB backup cron on server
- [ ] SSL certificate + domain name
- [ ] GitHub token stored on server (avoid interactive password on `git pull`)
- [ ] `vendor_id` wired into Create PO flow (currently stored as free text `vendor_name`)
- [ ] Item master UI updated to show `spec` column and grouped base item view
