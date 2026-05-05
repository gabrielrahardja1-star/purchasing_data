# Product Requirements Document
## PT Merge Mining Industri — Internal Procurement System

**Version:** 1.0  
**Date:** 2026-05-04  
**Status:** In Development

---

## 1. Overview

### 1.1 Purpose
An internal web-based procurement system for PT Merge Mining Industri that digitises and enforces the end-to-end purchasing workflow: from a field requester submitting a purchase request, through MD line-item approval, to Purchasing issuing a Purchase Order and exporting a GL journal entry.

### 1.2 Problem Statement
Previously, purchase requests were managed manually (paper or spreadsheets), making it difficult to:
- Track which requests had been approved or rejected
- Know the fulfilment status of ordered items
- Produce a consolidated view of open POs across departments
- Maintain an audit trail of who approved what and when

### 1.3 Goals
- Enforce a structured PR → Approval → PO workflow
- Give each role a scoped, read-appropriate view of the data
- Reduce duplicate ordering by surfacing fulfillment status per line item
- Support multi-item POs across multiple PRs from a single vendor

---

## 2. Users & Roles

| Role | Description | Access |
|---|---|---|
| **Requester** | Field staff / department heads who need to procure items | Submit PRs, track their own PRs |
| **Purchasing** | Procurement team that issues POs to vendors | View all PRs, create POs, view PO list |
| **MD** | Managing Director who approves or rejects line items | Approvals queue only |
| **Admin** | System administrator | Full access to all pages including Item Master |

---

## 3. Workflow

```
Requester submits PR
        ↓
PR enters MD Approval queue (status: pending)
        ↓
MD approves / rejects each line item individually
        ↓
All items decided → PR status auto-updates (approved / rejected)
        ↓
Purchasing creates PO (one PO can span multiple PRs / items)
        ↓
PO exported as GL CSV journal entry
```

---

## 4. Features

### 4.1 Authentication
- Username / password login with server-side session (8-hour expiry)
- Passwords stored as bcrypt hashes (never plain text)
- Sessions stored in SQLite via connect-sqlite3
- Role is determined by session — no client-side role switching
- No self-registration; accounts are seeded or created directly in DB

**Default accounts (seeded on first run):**
| Username | Password | Role |
|---|---|---|
| requester1 | merge2026 | Requester |
| purchasing1 | merge2026 | Purchasing |
| md1 | merge2026 | MD |
| admin1 | merge2026 | Admin |

---

### 4.2 Purchase Requests (PR)

**Submission (Requester / Purchasing / Admin)**
- Fields: Requester Name, Department, Line Items (Item, Qty, UOM, Notes), PR-level Notes
- Items searched via fuzzy search (Fuse.js) against the Item Master
- PR number auto-generated: `PR-YYYY-NNN`
- Initial status: `pending` (goes directly to MD approval queue)
- Requester identity tied to session user ID — My Requests is scoped to the submitter

**Status Lifecycle:**
```
pending → approved (all items approved)
        → rejected (all items rejected)
```

**PR List (Admin)**
- Filterable by status: All / Pending / Approved / Rejected
- Expandable rows showing line items with qty requested, qty approved, qty fulfilled, fulfillment badge

**My Requests (Requester)**
- Shows only PRs submitted by the logged-in user
- Read-only: item name, qty, UOM, est. unit price (if set), item status
- Pipeline timeline per PR showing current stage

**PR Management (Purchasing / Admin)**
- All PRs across all statuses
- Expandable rows showing full line-item detail including fulfillment qty
- "Create PO →" button on approved unfulfilled items navigates to Create PO

---

### 4.3 MD Approvals

- Shows only PRs with `pending` status
- Per-line-item approve / reject with adjustable Qty Approved
- Bulk approve / bulk reject across multiple PRs
- Approver name entered once per session (not tied to login name — allows delegate approval)
- PR status auto-updates when all items are decided
- Estimated total shown on each PR card header (from pricing if set)
- Approval audit log stored in `approvals` table

---

### 4.4 Purchase Orders (PO)

**Create PO (Purchasing / Admin)**
- Vendor name entered once per PO
- Table shows all approved, unfulfilled items across all PRs
- Checkboxes to select any combination of items
- Unit Price and Qty to Order entered per selected item
- Running total shown in summary card
- One PO can contain items from multiple PRs (multi-PR PO)
- PO number auto-generated: `PO-YYYY-NNN`

**PO List (Purchasing / Admin)**
- Lists all POs with: PO Number, Source PRs (all), Vendor, Date, Total, Status
- Clickable rows expand to show line-item detail:
  - Item name (EN + CN)
  - Quantity + UOM
  - Unit Price
  - Line Total
  - Source PR number
- Export GL button per PO

---

### 4.5 GL Export

- Exports a 2-line double-entry CSV per PO:
  - Debit: Account 5000 (Inventory/Expense)
  - Credit: Account 2100 (Accounts Payable)
- Filename: `GL_PO-YYYY-NNN_YYYYMMDD.csv`
- Export logged in `gl_export_log` table

---

### 4.6 Item Master (Admin)

- Browse all items with search (EN name, CN name, Item ID)
- Add new items with duplicate detection (fuzzy match warning before save)
- Fields: Name (EN), Name (CN), Category, UOM, Department
- Item ID auto-generated: `ITEM-NNNN`

---

### 4.7 Pipeline Timeline

Every PR row displays a 4-step visual pipeline:
```
Submitted → MD Review → PO Created → GL Export
```
Current stage highlighted with a pulsing ring. Completed steps shown with a filled dot.

---

## 5. Data Model

```
users           — id, username, password_hash, role, full_name
items           — item_id, name_en, name_cn, category, uom, department
pr              — pr_id, pr_number, requested_by, department, date_requested, status, notes, requester_id
pr_items        — pr_item_id, pr_id, item_id, qty, qty_requested, qty_approved, uom, est_unit_price, estimated_unit_price, status, notes
approvals       — approval_id, pr_id, approved_by, action, timestamp, notes
po              — po_id, po_number, pr_id (nullable), vendor_name, date_created, status, total_amount
po_items        — po_item_id, po_id, pr_item_id, item_id, qty, uom, unit_price, total_price, vendor_name
gl_export_log   — log_id, po_id, export_date, filename
sessions        — (managed by connect-sqlite3)
```

---

## 6. Technical Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Database | SQLite via better-sqlite3 |
| Auth | express-session + bcryptjs + connect-sqlite3 |
| Search | Fuse.js (fuzzy item search) |
| CSV Export | json2csv |
| Frontend | Vanilla JS single-page app (no framework) |
| Fonts | Inter (UI), Instrument Serif (numbers/titles), JetBrains Mono (IDs/dates) |
| Design | Aurora design system — custom CSS tokens |

---

## 7. API Routes

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | /api/auth/login | Public | Login |
| POST | /api/auth/logout | Public | Logout |
| GET | /api/auth/me | Public | Current session user |
| GET | /api/items | Auth | All items |
| GET | /api/items/search?q= | Auth | Fuzzy search items |
| GET | /api/items/departments | Auth | Department list |
| POST | /api/items | Auth | Add new item |
| GET | /api/pr | Auth | All PRs (optional ?requester_id= filter) |
| POST | /api/pr | Requester / Purchasing / Admin | Submit PR |
| GET | /api/pr/:id | Auth | PR detail with line items + history |
| POST | /api/pr/:id/items/:itemId/approve | MD / Admin | Approve or reject a line item |
| GET | /api/pr-items/approved | Purchasing / Admin | All approved unfulfilled items |
| GET | /api/po | Auth | All POs |
| POST | /api/po | Purchasing / Admin | Create PO (multi-item) |
| GET | /api/po/:id | Auth | PO detail with line items |
| GET | /api/po/:id/export | Auth | Download GL CSV |

---

## 8. Out of Scope (v1)

- Email / push notifications on PR status change
- Vendor management (vendor database, contacts)
- Budget tracking per department
- Partial PO fulfilment tracking beyond qty_fulfilled
- Mobile app
- Multi-currency support
- User management UI (accounts managed directly in DB)

---

## 9. Known Limitations

- No password reset flow — must be done directly in DB
- Approver name in MD view is free-text, not tied to session (allows delegation but reduces audit strictness)
- GL export uses hardcoded account codes (5000 / 2100)
- No PO amendment flow — a PO once created cannot be edited
