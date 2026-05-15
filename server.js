'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const Fuse    = require('fuse.js');
const { Parser } = require('json2csv');
const bcrypt  = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const ch      = require('./clickhouse');

const PORT    = 3000;
const EXPORTS = path.join(__dirname, 'exports');
if (!fs.existsSync(EXPORTS)) fs.mkdirSync(EXPORTS, { recursive: true });

// ── Fuse.js ───────────────────────────────────────────────────────────────────
let fuse;
async function rebuildFuse() {
  const items = await ch.query('SELECT * FROM items FINAL WHERE is_deleted = 0 ORDER BY item_id');
  fuse = new Fuse(items, {
    threshold: 0.4,
    includeScore: true,
    keys: [
      { name: 'name_en', weight: 3 },
      { name: 'name_cn', weight: 3 },
      { name: 'spec',    weight: 2 },
      { name: 'item_id', weight: 1 },
    ],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }

async function nextPrNumber() {
  const year = new Date().getFullYear();
  const rows = await ch.query(
    `SELECT pr_number FROM purchase_requests FINAL WHERE pr_number LIKE {pat:String} ORDER BY legacy_pr_id DESC LIMIT 1`,
    { pat: `PR-${year}-%` }
  );
  if (!rows.length) return `PR-${year}-001`;
  const seq = parseInt(rows[0].pr_number.split('-')[2], 10) + 1;
  return `PR-${year}-${String(seq).padStart(3, '0')}`;
}

async function nextPoNumber() {
  const year = new Date().getFullYear();
  const rows = await ch.query(
    `SELECT po_number FROM purchase_orders FINAL WHERE po_number LIKE {pat:String} ORDER BY legacy_po_id DESC LIMIT 1`,
    { pat: `PO-${year}-%` }
  );
  if (!rows.length) return `PO-${year}-001`;
  const seq = parseInt(rows[0].po_number.split('-')[2], 10) + 1;
  return `PO-${year}-${String(seq).padStart(3, '0')}`;
}

async function nextLegacyId(table, field) {
  const rows = await ch.query(`SELECT max(${field}) AS m FROM ${table} FINAL`);
  return (parseInt(rows[0]?.m || '0', 10) || 0) + 1;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'procurement.db', dir: './db' }),
  secret: process.env.SESSION_SECRET || 'merge-mining-procurement-secret-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const rows = await ch.query(
      `SELECT * FROM users FINAL WHERE username = {u:String} AND is_deleted = 0 LIMIT 1`,
      { u: username }
    );
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid username or password' });
    req.session.user = {
      id: user.legacy_user_id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
    };
    res.json({ success: true, user: req.session.user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.session.user });
});

// ── Items ─────────────────────────────────────────────────────────────────────
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const rows = await ch.query('SELECT *, department_id AS department FROM items FINAL WHERE is_deleted = 0 ORDER BY item_id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/items/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || !fuse) return res.json([]);
  res.json(fuse.search(q).slice(0, 5).map(r => r.item));
});

app.post('/api/items/match', requireAuth, (req, res) => {
  try {
    const names = req.body.names;
    if (!Array.isArray(names)) return res.status(400).json({ error: 'names must be array' });
    if (!fuse) return res.json([]);
    const results = names.map(name => {
      const base = String(name).trim();
      // Also try with CJK stripped and CJK-only — picks best score for mixed-language names
      const enOnly = base.replace(/[\u3000-\u9FFF\uF900-\uFAFF\u4E00-\u9FFF]/g, '').trim();
      const cnOnly = base.replace(/[^\u4E00-\u9FFF\u3400-\u4DBF]/g, '').trim();
      const queries = [...new Set([base, enOnly, cnOnly].filter(Boolean))];
      const best = new Map(); // item_id → {item, score}
      for (const q of queries) {
        for (const h of fuse.search(q, { limit: 4 })) {
          const id = h.item.item_id;
          if (!best.has(id) || best.get(id).score > (h.score ?? 1)) {
            best.set(id, { item: h.item, score: h.score ?? 1 });
          }
        }
      }
      const matches = [...best.values()].sort((a, b) => a.score - b.score).slice(0, 4);
      return { query: name, matches };
    });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/items/departments', requireAuth, async (req, res) => {
  try {
    const rows = await ch.query(
      `SELECT DISTINCT department_id FROM items FINAL WHERE is_deleted = 0 AND department_id != '' ORDER BY department_id`
    );
    res.json(rows.map(r => r.department_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { name_en, name_cn, category, uom, department } = req.body;
    if (!name_en) return res.status(400).json({ error: 'name_en required' });
    const last = await ch.query(
      `SELECT item_id FROM items FINAL WHERE is_deleted = 0 ORDER BY item_id DESC LIMIT 1`
    );
    let nextNum = 1;
    if (last.length) {
      const m = last[0].item_id.match(/ITEM-(\d+)/);
      if (m) nextNum = parseInt(m[1], 10) + 1;
    }
    const item_id = `ITEM-${String(nextNum).padStart(4, '0')}`;
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('items', [{
      item_id, company_id: ch.COMPANY_ID, base_item_id: '', item_code: '',
      name_en: name_en || '', name_cn: name_cn || '', category_id: '',
      category_name: category || '', spec: '', uom: uom || 'pcs',
      department_id: department || '', item_type: 'expense',
      default_gl_account_id: '', min_order_qty: 0, lead_time_days: 0, status: 'active',
      search_text: `${name_en} ${name_cn || ''} ${category || ''}`.toLowerCase(),
      version: ver, is_deleted: 0, created_at: now, updated_at: now,
    }]);
    await rebuildFuse();
    res.json({ item_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/items/:id', requireRole('admin'), async (req, res) => {
  try {
    const rows = await ch.query(
      `SELECT * FROM items FINAL WHERE item_id = {id:String} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const { name_en, name_cn, category, spec, uom } = req.body;
    if (!name_en) return res.status(400).json({ error: 'name_en required' });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('items', [{
      ...rows[0],
      name_en: name_en || '', name_cn: name_cn || '',
      category_name: category || '', spec: spec || '', uom: uom || rows[0].uom,
      search_text: `${name_en} ${name_cn || ''} ${category || ''}`.toLowerCase(),
      version: ver, updated_at: now,
    }]);
    await rebuildFuse();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/items/:id', requireRole('admin'), async (req, res) => {
  try {
    const rows = await ch.query(
      `SELECT * FROM items FINAL WHERE item_id = {id:String} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('items', [{ ...rows[0], is_deleted: 1, version: ver, updated_at: now }]);
    await rebuildFuse();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UOM & Vendors ─────────────────────────────────────────────────────────────
app.get('/api/uom', requireAuth, async (_req, res) => {
  try {
    const rows = await ch.query(
      `SELECT DISTINCT uom FROM items FINAL WHERE is_deleted = 0 AND uom != '' ORDER BY uom`
    );
    res.json(rows.map(r => r.uom));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vendors/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const rows = await ch.query(
      `SELECT vendor_id, vendor_name AS name, category, contact_person AS contact, phone, email, city
       FROM vendors FINAL
       WHERE is_deleted = 0 AND (
         positionCaseInsensitive(vendor_name, {q:String}) > 0 OR
         positionCaseInsensitive(vendor_id, {q:String}) > 0
       )
       ORDER BY vendor_name LIMIT 10`,
      { q }
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Purchase Requests ─────────────────────────────────────────────────────────
app.post('/api/pr', requireRole('requester', 'purchasing', 'admin'), async (req, res) => {
  try {
    const { requested_by, department: deptBody, notes, items } = req.body;
    const requester_id = req.session.user ? String(req.session.user.id) : '';
    if (!requested_by || !items?.length)
      return res.status(400).json({ error: 'requested_by and items required' });

    const department = deptBody || (items[0] && items[0].department) || '';
    const pr_number    = await nextPrNumber();
    const pr_uuid      = ch.newUUID();
    const legacy_pr_id = await nextLegacyId('purchase_requests', 'legacy_pr_id');
    const now = ch.nowTs(); const ver = Number(ch.version());

    await ch.insert('purchase_requests', [{
      pr_id: pr_uuid, legacy_pr_id, company_id: ch.COMPANY_ID,
      pr_number, requester_user_id: requester_id, requested_by_name: requested_by,
      department_id: department, cost_center_id: '', pr_date: today(),
      needed_by_date: null, priority: 'normal', status: 'pending',
      total_estimated_amount: 0, currency: 'IDR', notes: notes || '',
      search_text: `${pr_number} ${requested_by}`.toLowerCase(),
      version: ver, is_deleted: 0, created_at: now, updated_at: now,
    }]);

    const prItemRows = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const legacy_pri_id = await nextLegacyId('purchase_request_items', 'legacy_pr_item_id');
      prItemRows.push({
        pr_item_id: ch.newUUID(), legacy_pr_item_id: legacy_pri_id,
        company_id: ch.COMPANY_ID, pr_id: pr_uuid, line_no: i + 1,
        item_id: it.item_id || '', item_description: '',
        requested_qty: parseFloat(it.qty) || 0, approved_qty: 0,
        uom: it.uom || 'pcs',
        estimated_unit_price: parseFloat(it.est_unit_price) || 0,
        estimated_total_price: (parseFloat(it.est_unit_price) || 0) * (parseFloat(it.qty) || 0),
        department_id: department || it.department || '', cost_center_id: '', gl_account_id: '',
        status: 'pending', notes: it.notes || '',
        version: ver, is_deleted: 0, created_at: now, updated_at: now,
      });
    }
    await ch.insert('purchase_request_items', prItemRows);
    res.json({ pr_id: legacy_pr_id, pr_number });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pr', requireAuth, async (req, res) => {
  try {
    const requester_id = req.query.requester_id;
    const search = (req.query.search || '').trim();
    let sql = `
      SELECT
        pr.legacy_pr_id AS pr_id,
        pr.pr_id AS uuid,
        pr.pr_number, pr.requested_by_name AS requested_by,
        pr.department_id AS department, pr.pr_date AS date_requested,
        pr.status AS status, pr.notes AS notes, pr.requester_user_id AS requester_id,
        count(pri.pr_item_id) AS item_count,
        countIf(pri.status = 'approved') AS approved_count,
        countIf(pri.status = 'approved' AND COALESCE(poi_agg.total_ordered, 0) >= toFloat64(pri.approved_qty)) AS fulfilled_count
      FROM purchase_requests AS pr FINAL
      LEFT JOIN purchase_request_items AS pri FINAL
        ON pri.pr_id = toString(pr.pr_id) AND pri.is_deleted = 0
      LEFT JOIN (
        SELECT pr_item_id, sum(ordered_qty) AS total_ordered
        FROM purchase_order_items FINAL WHERE is_deleted = 0
        GROUP BY pr_item_id
      ) AS poi_agg ON poi_agg.pr_item_id = toString(pri.pr_item_id)
      WHERE pr.is_deleted = 0`;
    const params = {};
    if (requester_id) {
      sql += ` AND pr.requester_user_id = {rid:String}`;
      params.rid = String(requester_id);
    }
    if (search) {
      sql += ` AND (positionCaseInsensitive(pr.pr_number, {s:String}) > 0 OR positionCaseInsensitive(pr.requested_by_name, {s:String}) > 0)`;
      params.s = search;
    }
    sql += ` GROUP BY pr.legacy_pr_id, pr.pr_id, pr.pr_number, pr.requested_by_name,
             pr.department_id, pr.pr_date, pr.status, pr.notes, pr.requester_user_id
             ORDER BY pr.legacy_pr_id DESC`;

    const rows = await ch.query(sql, params);
    res.json(rows.map(r => {
      const approved = parseInt(r.approved_count) || 0;
      const fulfilled = parseInt(r.fulfilled_count) || 0;
      const item_count = parseInt(r.item_count) || 0;
      let fulfillment_status = null;
      if (r.status === 'approved') {
        if (approved === 0)             fulfillment_status = 'unfulfilled';
        else if (fulfilled >= approved) fulfillment_status = 'fulfilled';
        else if (fulfilled > 0)         fulfillment_status = 'partial';
        else                            fulfillment_status = 'unfulfilled';
      }
      return { ...r, item_count, approved_count: approved, fulfilled_count: fulfilled,
               approval_summary: `${approved}/${item_count} approved`, fulfillment_status };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pr/:id', requireAuth, async (req, res) => {
  try {
    const prs = await ch.query(
      `SELECT * FROM purchase_requests FINAL WHERE legacy_pr_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!prs.length) return res.status(404).json({ error: 'Not found' });
    const pr = prs[0];

    const rawItems = await ch.query(
      `SELECT
         pri.pr_item_id, pri.legacy_pr_item_id, pri.pr_id, pri.line_no,
         pri.item_id, pri.requested_qty, pri.approved_qty,
         pri.uom AS uom, pri.estimated_unit_price, pri.estimated_total_price,
         pri.department_id, pri.status AS status, pri.notes AS notes,
         i.name_en, i.name_cn, i.category_name AS category,
         COALESCE(poi_agg.total_ordered, 0) AS qty_fulfilled
       FROM purchase_request_items pri FINAL
       JOIN items i FINAL ON i.item_id = pri.item_id AND i.is_deleted = 0
       LEFT JOIN (
         SELECT pr_item_id, sum(ordered_qty) AS total_ordered
         FROM purchase_order_items FINAL WHERE is_deleted = 0
         GROUP BY pr_item_id
       ) poi_agg ON poi_agg.pr_item_id = toString(pri.pr_item_id)
       WHERE pri.pr_id = {prid:String} AND pri.is_deleted = 0`,
      { prid: pr.pr_id }
    );

    const lineItems = rawItems.map(item => {
      const qtyFulfilled = parseFloat(item.qty_fulfilled) || 0;
      const qtyApproved  = parseFloat(item.approved_qty) || parseFloat(item.requested_qty) || 0;
      let fulfillment_status;
      if      (qtyFulfilled === 0)          fulfillment_status = 'unfulfilled';
      else if (qtyFulfilled >= qtyApproved) fulfillment_status = 'fulfilled';
      else                                  fulfillment_status = 'partial';
      return {
        ...item,
        pr_item_id:    item.legacy_pr_item_id,
        qty:           item.requested_qty,
        qty_requested: item.requested_qty,
        qty_approved:  item.approved_qty,
        est_unit_price: item.estimated_unit_price,
        fulfillment_status,
      };
    });

    const history = await ch.query(
      `SELECT *, actor_name AS approved_by, action_at AS timestamp FROM approval_actions
       WHERE document_id = {prid:String} AND document_type = 'PR' ORDER BY action_at`,
      { prid: pr.pr_id }
    );

    const estimated_total = lineItems.reduce((s, i) =>
      s + (parseFloat(i.estimated_unit_price) || 0) * (parseFloat(i.requested_qty) || 0), 0);

    res.json({
      ...pr,
      pr_id:         pr.legacy_pr_id,
      requested_by:  pr.requested_by_name,
      department:    pr.department_id,
      date_requested: pr.pr_date,
      requester_id:  pr.requester_user_id,
      line_items:    lineItems,
      history,
      estimated_total,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pr/:id/approve', requireRole('md', 'admin'), async (req, res) => {
  try {
    const { approved_by, action, notes } = req.body;
    if (!approved_by || !action) return res.status(400).json({ error: 'approved_by and action required' });
    if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'action must be approved or rejected' });

    const prs = await ch.query(
      `SELECT * FROM purchase_requests FINAL WHERE legacy_pr_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!prs.length) return res.status(404).json({ error: 'Not found' });
    const pr = prs[0];
    const now = ch.nowTs(); const ver = Number(ch.version());

    await ch.insert('purchase_requests', [{ ...pr, status: action, version: ver, updated_at: now }]);
    await ch.insert('approval_actions', [{
      approval_action_id: ch.newUUID(), company_id: ch.COMPANY_ID,
      document_type: 'PR', document_id: pr.pr_id, document_item_id: '',
      workflow_id: '', step_no: 0, actor_user_id: '', actor_name: approved_by,
      action, action_at: now, from_status: pr.status, to_status: action,
      approved_qty: null, notes: notes || '',
    }]);
    res.json({ success: true, status: action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pr/:id/items/:itemId/approve', requireRole('md', 'admin'), async (req, res) => {
  try {
    const { approved_by, action, qty_approved, notes } = req.body;
    if (!approved_by || !action) return res.status(400).json({ error: 'approved_by and action required' });
    if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'action must be approved or rejected' });

    const prs = await ch.query(
      `SELECT * FROM purchase_requests FINAL WHERE legacy_pr_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!prs.length) return res.status(404).json({ error: 'PR not found' });
    const pr = prs[0];

    const prItems = await ch.query(
      `SELECT * FROM purchase_request_items FINAL
       WHERE legacy_pr_item_id = {itemId:Int64} AND pr_id = {prid:String} AND is_deleted = 0 LIMIT 1`,
      { itemId: req.params.itemId, prid: pr.pr_id }
    );
    if (!prItems.length) return res.status(404).json({ error: 'PR item not found' });
    const prItem = prItems[0];

    const now = ch.nowTs(); const ver = Number(ch.version());
    const approvedQty = action === 'approved'
      ? (qty_approved ?? parseFloat(prItem.requested_qty))
      : 0;

    await ch.insert('purchase_request_items', [{
      ...prItem, status: action, approved_qty: approvedQty, version: ver, updated_at: now,
    }]);

    const itemRows = await ch.query(
      `SELECT name_en FROM items FINAL WHERE item_id = {iid:String} LIMIT 1`,
      { iid: prItem.item_id }
    );
    const itemName = itemRows[0]?.name_en || prItem.item_id;

    await ch.insert('approval_actions', [{
      approval_action_id: ch.newUUID(), company_id: ch.COMPANY_ID,
      document_type: 'PR', document_id: pr.pr_id, document_item_id: prItem.pr_item_id,
      workflow_id: '', step_no: 0, actor_user_id: '', actor_name: approved_by,
      action, action_at: now, from_status: prItem.status, to_status: action,
      approved_qty: approvedQty,
      notes: `Item: ${itemName}${notes ? ' — ' + notes : ''}`,
    }]);

    // Auto-update PR status
    const allItems = await ch.query(
      `SELECT status FROM purchase_request_items FINAL WHERE pr_id = {prid:String} AND is_deleted = 0`,
      { prid: pr.pr_id }
    );
    const anyPending  = allItems.some(i => !i.status || i.status === 'pending');
    const allRejected = allItems.every(i => i.status === 'rejected');
    if (!anyPending) {
      const newStatus = allRejected ? 'rejected' : 'approved';
      await ch.insert('purchase_requests', [{ ...pr, status: newStatus, version: ver + 1, updated_at: now }]);
    }

    const updated = await ch.query(
      `SELECT * FROM purchase_request_items FINAL WHERE legacy_pr_item_id = {itemId:Int64} LIMIT 1`,
      { itemId: req.params.itemId }
    );
    const u = updated[0] || {};
    res.json({ ...u, pr_item_id: u.legacy_pr_item_id, qty_approved: u.approved_qty, qty_requested: u.requested_qty });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Approved items for PO creation ────────────────────────────────────────────
app.get('/api/pr-items/approved', requireRole('purchasing', 'admin'), async (req, res) => {
  try {
    const rows = await ch.query(`
      SELECT
        pri.legacy_pr_item_id AS pr_item_id,
        pr.legacy_pr_id AS pr_id,
        pri.item_id,
        pri.approved_qty AS qty_approved,
        pri.requested_qty AS qty_requested,
        pri.uom AS uom,
        pri.estimated_unit_price,
        pri.estimated_unit_price AS est_unit_price,
        i.name_en, i.name_cn, i.category_name AS category,
        pr.pr_number, pr.requested_by_name AS requested_by, pr.pr_date AS date_requested,
        COALESCE(pri.department_id, pr.department_id) AS department,
        COALESCE(poi_agg.total_ordered, 0) AS qty_fulfilled
      FROM purchase_request_items pri FINAL
      JOIN items i FINAL ON i.item_id = pri.item_id AND i.is_deleted = 0
      JOIN purchase_requests pr FINAL ON toString(pr.pr_id) = pri.pr_id AND pr.is_deleted = 0
      LEFT JOIN (
        SELECT pr_item_id, sum(ordered_qty) AS total_ordered
        FROM purchase_order_items FINAL WHERE is_deleted = 0
        GROUP BY pr_item_id
      ) poi_agg ON poi_agg.pr_item_id = toString(pri.pr_item_id)
      WHERE pri.status = 'approved' AND pri.is_deleted = 0
      ORDER BY pr.legacy_pr_id DESC, pri.legacy_pr_item_id
    `);
    const result = rows.filter(r => {
      const approved = parseFloat(r.qty_approved) || parseFloat(r.qty_requested) || 0;
      return parseFloat(r.qty_fulfilled) < approved;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Purchase Orders ───────────────────────────────────────────────────────────
app.post('/api/po', requireRole('purchasing', 'admin'), async (req, res) => {
  try {
    const PPH_RATES = { pph23: 0.02, pph15: 0.012, pph22_solar: 0.003, pph22_impor: 0.025 };
    const { vendor_name, items, include_vat = false, pph_type = null } = req.body;
    if (!vendor_name || !items?.length)
      return res.status(400).json({ error: 'vendor_name and items array required' });
    if (pph_type && !PPH_RATES[pph_type])
      return res.status(400).json({ error: `Unknown pph_type: ${pph_type}` });

    for (const it of items) {
      if (!it.pr_item_id || it.unit_price == null || it.qty_ordered == null)
        return res.status(400).json({ error: 'Each item needs pr_item_id, unit_price, qty_ordered' });
      const r = await ch.query(
        `SELECT status FROM purchase_request_items FINAL WHERE legacy_pr_item_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
        { id: it.pr_item_id }
      );
      if (!r.length) return res.status(400).json({ error: `pr_item_id ${it.pr_item_id} not found` });
      if (r[0].status !== 'approved') return res.status(400).json({ error: `Item ${it.pr_item_id} is not approved` });
    }

    const subtotal     = items.reduce((s, it) => s + it.unit_price * it.qty_ordered, 0);
    const vat_amount   = include_vat ? subtotal * 0.11 : 0;
    const pph_rate     = pph_type ? PPH_RATES[pph_type] : 0;
    const pph_amount   = subtotal * pph_rate;
    const total_amount = subtotal + vat_amount - pph_amount;

    const po_number    = await nextPoNumber();
    const po_uuid      = ch.newUUID();
    const legacy_po_id = await nextLegacyId('purchase_orders', 'legacy_po_id');
    const now = ch.nowTs(); const ver = Number(ch.version());

    const firstPrItemRows = await ch.query(
      `SELECT pr_id FROM purchase_request_items FINAL WHERE legacy_pr_item_id = {id:Int64} LIMIT 1`,
      { id: items[0].pr_item_id }
    );
    const primary_pr_id = firstPrItemRows[0]?.pr_id || '';

    await ch.insert('purchase_orders', [{
      po_id: po_uuid, legacy_po_id, company_id: ch.COMPANY_ID,
      po_number, primary_pr_id, vendor_id: '', vendor_name,
      po_date: today(), expected_delivery_date: null,
      currency: 'IDR', exchange_rate: 1, payment_term_id: '',
      status: 'pending_approval', subtotal_amount: subtotal, discount_amount: 0,
      tax_amount: vat_amount, withholding_amount: pph_amount, total_amount,
      notes: '', search_text: `${po_number} ${vendor_name}`.toLowerCase(),
      created_by_user_id: req.session.user ? String(req.session.user.id) : '',
      version: ver, is_deleted: 0, created_at: now, updated_at: now,
    }]);

    const poItemRows = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const prItemRows = await ch.query(
        `SELECT * FROM purchase_request_items FINAL WHERE legacy_pr_item_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
        { id: it.pr_item_id }
      );
      const prItem = prItemRows[0];
      const legacy_poi_id = await nextLegacyId('purchase_order_items', 'legacy_po_item_id');
      poItemRows.push({
        po_item_id: ch.newUUID(), legacy_po_item_id: legacy_poi_id,
        company_id: ch.COMPANY_ID, po_id: po_uuid, line_no: i + 1,
        pr_item_id: prItem.pr_item_id, quotation_item_id: '',
        item_id: prItem.item_id, item_description: '',
        ordered_qty: parseFloat(it.qty_ordered), received_qty: 0, invoiced_qty: 0,
        uom: prItem.uom, unit_price: parseFloat(it.unit_price), discount_amount: 0,
        tax_amount: 0, total_price: parseFloat(it.unit_price) * parseFloat(it.qty_ordered),
        gl_account_id: '', cost_center_id: '', vendor_name, status: 'open', notes: '',
        version: ver, is_deleted: 0, created_at: now, updated_at: now,
      });
    }
    await ch.insert('purchase_order_items', poItemRows);
    res.json({ po_id: legacy_po_id, po_number });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PO Approval routes ────────────────────────────────────────────────────────
app.post('/api/po/:id/approve', requireRole('md', 'admin'), async (req, res) => {
  try {
    const pos = await ch.query(
      `SELECT * FROM purchase_orders FINAL WHERE legacy_po_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).json({ error: 'PO not found' });
    const po = pos[0];
    if (po.status !== 'pending_approval')
      return res.status(400).json({ error: `Cannot approve a PO with status: ${po.status}` });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('purchase_orders', [{ ...po, status: 'approved', notes: po.notes, version: ver, updated_at: now }]);
    await ch.insert('approval_actions', [{
      approval_action_id: ch.newUUID(), company_id: ch.COMPANY_ID,
      document_type: 'PO', document_id: po.po_id, document_item_id: '',
      workflow_id: '', step_no: 0, actor_user_id: '',
      actor_name: req.session.user?.full_name || req.session.user?.username || '',
      action: 'approved', action_at: now, from_status: po.status, to_status: 'approved',
      approved_qty: null, notes: '',
    }]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/po/:id/reject', requireRole('md', 'admin'), async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes?.trim()) return res.status(400).json({ error: 'Rejection note is required' });
    const pos = await ch.query(
      `SELECT * FROM purchase_orders FINAL WHERE legacy_po_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).json({ error: 'PO not found' });
    const po = pos[0];
    if (po.status !== 'pending_approval')
      return res.status(400).json({ error: `Cannot reject a PO with status: ${po.status}` });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('purchase_orders', [{ ...po, status: 'rejected', notes: notes.trim(), version: ver, updated_at: now }]);
    await ch.insert('approval_actions', [{
      approval_action_id: ch.newUUID(), company_id: ch.COMPANY_ID,
      document_type: 'PO', document_id: po.po_id, document_item_id: '',
      workflow_id: '', step_no: 0, actor_user_id: '',
      actor_name: req.session.user?.full_name || req.session.user?.username || '',
      action: 'rejected', action_at: now, from_status: po.status, to_status: 'rejected',
      approved_qty: null, notes: notes.trim(),
    }]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/po/:id/resubmit', requireRole('purchasing', 'admin'), async (req, res) => {
  try {
    const pos = await ch.query(
      `SELECT * FROM purchase_orders FINAL WHERE legacy_po_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).json({ error: 'PO not found' });
    const po = pos[0];
    if (po.status !== 'rejected')
      return res.status(400).json({ error: `Can only resubmit rejected POs` });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('purchase_orders', [{ ...po, status: 'pending_approval', notes: '', version: ver, updated_at: now }]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po', requireAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    let sql = `
      SELECT
        po.legacy_po_id AS po_id, po.po_id AS uuid,
        po.po_number, po.vendor_name, po.po_date AS date_created,
        po.status AS status, po.total_amount AS total_amount, po.subtotal_amount AS subtotal_amount,
        po.tax_amount AS tax_amount, po.withholding_amount AS withholding_amount,
        groupArray(DISTINCT pr.pr_number) AS pr_numbers_arr
      FROM purchase_orders po FINAL
      LEFT JOIN purchase_order_items poi FINAL ON poi.po_id = toString(po.po_id) AND poi.is_deleted = 0
      LEFT JOIN purchase_request_items pri FINAL ON toString(pri.pr_item_id) = poi.pr_item_id AND pri.is_deleted = 0
      LEFT JOIN purchase_requests pr FINAL ON toString(pr.pr_id) = pri.pr_id AND pr.is_deleted = 0
      WHERE po.is_deleted = 0`;
    const params = {};
    if (search) {
      sql += ` AND (positionCaseInsensitive(po.po_number, {s:String}) > 0 OR positionCaseInsensitive(po.vendor_name, {s:String}) > 0)`;
      params.s = search;
    }
    sql += ` GROUP BY po.legacy_po_id, po.po_id, po.po_number, po.vendor_name, po.po_date,
             po.status, po.total_amount, po.subtotal_amount, po.tax_amount, po.withholding_amount
             ORDER BY po.legacy_po_id DESC`;

    const rows = await ch.query(sql, params);
    res.json(rows.map(r => ({
      ...r,
      pr_numbers: Array.isArray(r.pr_numbers_arr) ? r.pr_numbers_arr.filter(Boolean).join(',') : '',
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/:id', requireAuth, async (req, res) => {
  try {
    const pos = await ch.query(
      `SELECT * FROM purchase_orders FINAL WHERE legacy_po_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).json({ error: 'Not found' });
    const po = pos[0];

    const lineItems = await ch.query(
      `SELECT
         poi.po_item_id, poi.legacy_po_item_id, poi.po_id, poi.line_no,
         poi.item_id, poi.pr_item_id, poi.ordered_qty, poi.received_qty,
         poi.uom AS uom, poi.unit_price, poi.total_price,
         poi.status AS status, poi.notes AS notes,
         i.name_en, i.name_cn, pr.pr_number
       FROM purchase_order_items poi FINAL
       JOIN items i FINAL ON i.item_id = poi.item_id AND i.is_deleted = 0
       LEFT JOIN purchase_request_items pri FINAL ON toString(pri.pr_item_id) = poi.pr_item_id AND pri.is_deleted = 0
       LEFT JOIN purchase_requests pr FINAL ON toString(pr.pr_id) = pri.pr_id AND pr.is_deleted = 0
       WHERE poi.po_id = {poid:String} AND poi.is_deleted = 0`,
      { poid: po.po_id }
    );

    const prNums = [...new Set(lineItems.map(l => l.pr_number).filter(Boolean))].join(',');

    res.json({
      ...po,
      po_id:       po.legacy_po_id,
      date_created: po.po_date,
      include_vat: parseFloat(po.tax_amount) > 0 ? 1 : 0,
      pr_numbers:  prNums,
      line_items:  lineItems.map(l => ({
        ...l, po_item_id: l.legacy_po_item_id, qty: l.ordered_qty,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/:id/print', requireAuth, async (req, res) => {
  try {
    const pos = await ch.query(
      `SELECT * FROM purchase_orders FINAL WHERE legacy_po_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).send('Not found');
    const po = pos[0];

    const lineItems = await ch.query(
      `SELECT
         poi.po_item_id, poi.legacy_po_item_id, poi.po_id, poi.line_no,
         poi.item_id, poi.pr_item_id, poi.ordered_qty, poi.received_qty,
         poi.uom AS uom, poi.unit_price, poi.total_price,
         poi.status AS status, poi.notes AS notes,
         i.name_en, i.name_cn, pr.pr_number
       FROM purchase_order_items poi FINAL
       JOIN items i FINAL ON i.item_id = poi.item_id AND i.is_deleted = 0
       LEFT JOIN purchase_request_items pri FINAL ON toString(pri.pr_item_id) = poi.pr_item_id AND pri.is_deleted = 0
       LEFT JOIN purchase_requests pr FINAL ON toString(pr.pr_id) = pri.pr_id AND pr.is_deleted = 0
       WHERE poi.po_id = {poid:String} AND poi.is_deleted = 0`,
      { poid: po.po_id }
    );

    const PPH_LABELS = {
      pph23: 'PPH 23 Jasa Badan (2%)', pph15: 'PPH 15 Jasa Tongkang (1,2%)',
      pph22_solar: 'PPH 22 Solar (0,3%)', pph22_impor: 'PPH 22 Impor (2,5%)',
    };
    const subtotal   = lineItems.reduce((s, i) => s + parseFloat(i.total_price), 0);
    const vatAmount  = parseFloat(po.tax_amount) || 0;
    const pphAmount  = parseFloat(po.withholding_amount) || 0;
    const pphLabel   = PPH_LABELS[po.pph_type] || 'PPH';
    const grandTotal = subtotal + vatAmount - pphAmount;
    const fmt = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');

    const itemRows = lineItems.map(it => `
      <tr>
        <td>${it.item_id}</td>
        <td>${it.name_en}${it.name_cn ? '<br><span class="cn">' + it.name_cn + '</span>' : ''}</td>
        <td class="num">${parseFloat(it.ordered_qty).toLocaleString('id-ID')}</td>
        <td class="num">${fmt(it.unit_price)}</td>
        <td class="num">0</td>
        <td class="num">${fmt(it.total_price)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8"><title>PO ${po.po_number}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #111; background:#fff; padding:20mm 16mm; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
  .company-name { font-size:22pt; font-weight:700; }
  .company-addr { font-size:8.5pt; color:#444; line-height:1.5; margin-top:4px; max-width:320px; }
  .logo-block { display:flex; align-items:center; gap:10px; }
  .logo-circle { width:52px; height:52px; border-radius:50%; background:#1a1a2e; display:flex; align-items:center; justify-content:center; }
  .logo-circle span { color:#fff; font-weight:700; font-size:9pt; text-align:center; line-height:1.2; }
  .divider { border:none; border-top:2px solid #111; margin:10px 0; }
  .two-col { display:flex; justify-content:space-between; gap:20px; margin-bottom:14px; }
  .to-box .label { font-size:9pt; color:#666; margin-bottom:4px; }
  .to-box .vendor { font-weight:600; font-size:11pt; margin-bottom:3px; }
  .po-box { border:1.5px solid #111; padding:10px 14px; min-width:240px; }
  .po-box .title { font-size:18pt; font-weight:700; margin-bottom:8px; }
  .po-meta { display:grid; grid-template-columns:auto 1fr; gap:3px 8px; font-size:9.5pt; }
  .po-meta .key { color:#555; } .po-meta .val { font-weight:600; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:16px; font-size:9.5pt; }
  table.items thead tr { background:#2c2c2c; color:#fff; }
  table.items th { padding:6px 8px; text-align:left; font-weight:600; }
  table.items th.num, table.items td.num { text-align:right; }
  table.items tbody tr:nth-child(even) { background:#f5f5f5; }
  table.items td { padding:5px 8px; border-bottom:1px solid #ddd; vertical-align:top; }
  .cn { font-size:8.5pt; color:#666; }
  .bottom { display:flex; gap:24px; justify-content:flex-end; }
  .notes-box { flex:1; font-size:9pt; color:#444; border-top:1px solid #ccc; padding-top:8px; }
  .notes-box .label { font-weight:700; font-size:9pt; color:#111; margin-bottom:4px; }
  .totals { min-width:280px; border-top:1px solid #ccc; padding-top:8px; }
  .total-row { display:flex; justify-content:space-between; font-size:9.5pt; padding:3px 0; }
  .total-row.grand { font-weight:700; font-size:11pt; background:#2c2c2c; color:#fff; padding:6px 8px; margin-top:4px; }
  .sigs { display:flex; justify-content:flex-end; gap:60px; margin-top:40px; }
  .sig-block { text-align:center; min-width:140px; }
  .sig-block .sig-label { font-size:9pt; margin-bottom:36px; }
  .sig-block .sig-line { border-top:1.5px solid #111; padding-top:4px; font-size:9pt; font-weight:600; }
  .print-btn { position:fixed; bottom:20px; right:20px; padding:10px 20px; background:#2c2c2c; color:#fff; border:none; border-radius:6px; font-size:11pt; cursor:pointer; z-index:999; }
  @media print { .print-btn { display:none; } body { padding:0; } @page { margin:14mm 12mm; size:A4 portrait; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">⬇ Simpan / Print PDF</button>
<div class="header"><div class="logo-block">
  <div class="logo-circle"><span>Merge<br>Coal</span></div>
  <div><div class="company-name">PT Merge Mining Industri</div>
  <div class="company-addr">Gedung The Honey Lady, Lt. 15 Unit 1503, Pluit, Penjaringan, Jakarta Utara<br>Kota Administrasi Jakarta Utara DKI Jakarta 12190<br>Indonesia</div></div>
</div></div>
<hr class="divider">
<div class="two-col">
  <div class="to-box"><div class="label">To</div><div class="vendor">${po.vendor_name}</div></div>
  <div class="po-box"><div class="title">Purchase Order</div>
  <div class="po-meta">
    <span class="key">Number</span><span class="val">: ${po.po_number}</span>
    <span class="key">Date</span><span class="val">: ${po.po_date}</span>
  </div></div>
</div>
<table class="items"><thead><tr>
  <th style="width:110px">Item Code</th><th>Item Name</th>
  <th class="num" style="width:90px">Quantity</th>
  <th class="num" style="width:130px">@Price</th>
  <th class="num" style="width:80px">Discount</th>
  <th class="num" style="width:140px">Total</th>
</tr></thead><tbody>${itemRows}</tbody></table>
<div class="bottom">
  <div class="notes-box"><div class="label">Notes</div><div>${po.notes || '—'}</div></div>
  <div class="totals">
    <div class="total-row"><span>Sub Total</span><span>${fmt(subtotal)}</span></div>
    <div class="total-row"><span>Diskon</span><span>0</span></div>
    ${vatAmount > 0 ? `<div class="total-row"><span>PPN (11%)</span><span>${fmt(vatAmount)}</span></div>` : ''}
    ${pphAmount > 0 ? `<div class="total-row"><span>${pphLabel}</span><span>− ${fmt(pphAmount)}</span></div>` : ''}
    <div class="total-row"><span>Biaya Lain-lain</span><span>0</span></div>
    <div class="total-row grand"><span>Total</span><span>${fmt(grandTotal)}</span></div>
  </div>
</div>
<div class="sigs">
  <div class="sig-block"><div class="sig-label">Ordered By,</div><div class="sig-line">Purchasing</div></div>
  <div class="sig-block"><div class="sig-label">Approved By,</div><div class="sig-line">Direktur</div></div>
</div>
<p style="text-align:right;font-size:8.5pt;color:#999;margin-top:24px">Halaman 1 dari 1</p>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/po/:id/export', requireAuth, async (req, res) => {
  try {
    const pos = await ch.query(
      `SELECT
         po.po_id, po.legacy_po_id, po.po_number, po.vendor_name, po.po_date,
         po.status AS status, po.total_amount AS total_amount, po.tax_amount AS tax_amount,
         po.withholding_amount AS withholding_amount, po.subtotal_amount AS subtotal_amount,
         po.primary_pr_id, po.notes AS notes,
         pr.pr_number, pr.requested_by_name AS requested_by, pr.department_id AS department
       FROM purchase_orders po FINAL
       LEFT JOIN purchase_requests pr FINAL ON toString(pr.pr_id) = po.primary_pr_id AND pr.is_deleted = 0
       WHERE po.legacy_po_id = {id:Int64} AND po.is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).json({ error: 'Not found' });
    const po = pos[0];
    if (po.status !== 'approved')
      return res.status(400).json({ error: 'GL export is only available for approved POs' });

    const lineItems = await ch.query(
      `SELECT poi.po_item_id, poi.item_id, poi.ordered_qty, poi.unit_price, poi.total_price,
              poi.uom AS uom, i.name_en
       FROM purchase_order_items poi FINAL
       JOIN items i FINAL ON i.item_id = poi.item_id AND i.is_deleted = 0
       WHERE poi.po_id = {poid:String} AND poi.is_deleted = 0`,
      { poid: po.po_id }
    );

    const itemNames   = lineItems.map(i => i.name_en).join(', ');
    const description = `${po.po_number} | ${po.vendor_name} | ${itemNames}`;
    const totalAmount = parseFloat(po.total_amount);
    const dateStr     = po.po_date;

    const glRows = [
      { date: dateStr, account_code: 5000, account_name: 'Inventory/Expense', description, debit: totalAmount.toFixed(2), credit: '' },
      { date: dateStr, account_code: 2100, account_name: 'Accounts Payable',  description, debit: '',                    credit: totalAmount.toFixed(2) },
    ];

    const exportDate = today().replace(/-/g, '');
    const filename   = `GL_${po.po_number}_${exportDate}.csv`;
    const filepath   = path.join(EXPORTS, filename);

    const parser = new Parser({ fields: ['date', 'account_code', 'account_name', 'description', 'debit', 'credit'] });
    const csv = parser.parse(glRows);
    fs.writeFileSync(filepath, csv);

    await ch.insert('gl_exports', [{
      gl_export_id: ch.newUUID(), legacy_log_id: null, company_id: ch.COMPANY_ID,
      source_document_type: 'PO', source_document_id: po.po_id,
      export_number: '', export_date: today(), filename, status: 'generated',
      exported_by_user_id: req.session.user ? String(req.session.user.id) : '', notes: '',
    }]);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin deletes ─────────────────────────────────────────────────────────────
app.delete('/api/pr/:id', requireRole('admin'), async (req, res) => {
  try {
    const prs = await ch.query(
      `SELECT * FROM purchase_requests FINAL WHERE legacy_pr_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!prs.length) return res.status(404).json({ error: 'PR not found' });
    const pr = prs[0];
    const now = ch.nowTs(); const ver = Number(ch.version());
    const items = await ch.query(
      `SELECT * FROM purchase_request_items FINAL WHERE pr_id = {prid:String} AND is_deleted = 0`,
      { prid: pr.pr_id }
    );
    for (const item of items) {
      await ch.insert('purchase_request_items', [{ ...item, is_deleted: 1, version: ver, updated_at: now }]);
    }
    await ch.insert('purchase_requests', [{ ...pr, is_deleted: 1, version: ver, updated_at: now }]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pr-items/:itemId', requireRole('admin'), async (req, res) => {
  try {
    const rows = await ch.query(
      `SELECT * FROM purchase_request_items FINAL WHERE legacy_pr_item_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.itemId }
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('purchase_request_items', [{ ...rows[0], is_deleted: 1, version: ver, updated_at: now }]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/po/:id', requireRole('admin'), async (req, res) => {
  try {
    const pos = await ch.query(
      `SELECT * FROM purchase_orders FINAL WHERE legacy_po_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!pos.length) return res.status(404).json({ error: 'PO not found' });
    const po = pos[0];
    const now = ch.nowTs(); const ver = Number(ch.version());
    const poItems = await ch.query(
      `SELECT * FROM purchase_order_items FINAL WHERE po_id = {poid:String} AND is_deleted = 0`,
      { poid: po.po_id }
    );
    for (const item of poItems) {
      await ch.insert('purchase_order_items', [{ ...item, is_deleted: 1, version: ver, updated_at: now }]);
    }
    await ch.insert('purchase_orders', [{ ...po, is_deleted: 1, version: ver, updated_at: now }]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', requireRole('admin'), async (_req, res) => {
  try {
    const users = await ch.query(
      `SELECT legacy_user_id AS id, username, role, full_name FROM users FINAL WHERE is_deleted = 0 ORDER BY legacy_user_id`
    );
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  try {
    if (String(req.session.user.id) === String(req.params.id))
      return res.status(400).json({ error: 'Cannot delete your own account' });
    const rows = await ch.query(
      `SELECT * FROM users FINAL WHERE legacy_user_id = {id:Int64} AND is_deleted = 0 LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const now = ch.nowTs(); const ver = Number(ch.version());
    await ch.insert('users', [{ ...rows[0], is_deleted: 1, version: ver, updated_at: now }]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log('Connecting to ClickHouse...');
  const ok = await ch.ping();
  if (!ok) { console.error('ClickHouse unreachable — exiting'); process.exit(1); }
  console.log('ClickHouse OK');
  await rebuildFuse();
  console.log(`Fuse index built (${fuse ? 'ok' : 'empty'})`);
  app.listen(PORT, () => console.log(`Procurement app running → http://localhost:${PORT}`));
}
start();
