# Future Work & Known Technical Debt

## 1. Item Master: Spec-as-Name Problem

**Current state:**
Item specifications (size, grade, model) are embedded in the item name.
Example: "PC Strand Φ17.8", "PC Strand Φ15.2", "Seamless Pipe Φ60*5", "Seamless Pipe Φ76*5"
are stored as separate items in the master.

**Why this is a problem:**
- Item master bloat — same physical item type has many rows
- Can't aggregate spend across all sizes of the same item
- Pricing comparisons across specs are impossible
- Searching for "PC Strand" returns a long list of nearly-identical entries

**What needs to change:**
1. Add `specification TEXT` column to the `items` table
2. Migrate existing items: strip spec from `name_en`/`name_cn`, move it to `specification`
3. Update Create PR flow to let requesters select item + enter spec separately
4. Update item search/autocomplete to show spec as a sub-label
5. Update GL export and PO print to include spec

**Migration complexity:** Medium — requires a data cleanup pass on all 1000+ items
and a UI change on the Create PR page.

---

## 2. Category Auto-Assignment Accuracy

The `enrich_items.py` script uses keyword matching to assign categories.
~400 items are currently "Uncategorized". These should be reviewed and
manually recategorized via the Item Master page in the admin UI.

---

## 3. GL Account Codes Hardcoded

Debit: 5000 (Inventory/Expense), Credit: 2100 (Accounts Payable) are hardcoded
in `server.js`. Future: make these configurable per item category or PO.

---

## 4. No PO Amendment

POs are immutable once created. Future: allow admin to edit qty/price on a PO
before GL export, with an audit trail.

---

## 5. No Email Notifications

No alerts when PR status changes (approved/rejected) or when a PO is created.
Future: integrate with email or WhatsApp Business API.
