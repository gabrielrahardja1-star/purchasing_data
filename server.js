'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const Fuse    = require('fuse.js');
const { Parser } = require('json2csv');
const bcrypt  = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT    = 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'procurement.db');
const SCHEMA  = path.join(__dirname, 'db', 'schema.sql');
const EXPORTS = path.join(__dirname, 'exports');

if (!fs.existsSync(EXPORTS)) fs.mkdirSync(EXPORTS, { recursive: true });

// ── DB init ───────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaSql = fs.readFileSync(SCHEMA, 'utf8');
// Run each statement; ignore ALTER TABLE errors (column already exists)
schemaSql.split(';').forEach(stmt => {
  const s = stmt.trim();
  if (!s) return;
  try { db.prepare(s).run(); } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
});
// One-time migrations
db.prepare("UPDATE pr_items SET qty_requested = qty WHERE qty_requested IS NULL").run();
db.prepare("UPDATE pr_items SET status = 'pending' WHERE status IS NULL").run();

// Seed default users if table is empty
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const insert = db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)`
  );
  const seed = db.transaction(() => {
    insert.run('requester1',  bcrypt.hashSync('merge2026', 10), 'requester',  'Requester One');
    insert.run('purchasing1', bcrypt.hashSync('merge2026', 10), 'purchasing', 'Purchasing One');
    insert.run('md1',         bcrypt.hashSync('merge2026', 10), 'md',         'MD One');
    insert.run('admin1',      bcrypt.hashSync('merge2026', 10), 'admin',      'Administrator');
  });
  seed();
  console.log('[AUTH] Default accounts seeded');
}

// Fix PRs whose items are all decided but PR status is still pending
db.prepare(`
  UPDATE pr SET status = 'approved'
  WHERE status = 'pending'
  AND pr_id NOT IN (
    SELECT DISTINCT pr_id FROM pr_items WHERE status = 'pending' OR status IS NULL
  )
  AND pr_id IN (SELECT DISTINCT pr_id FROM pr_items WHERE status = 'approved')
`).run();
console.log(`DB ready: ${DB_PATH}`);

// ── Fuse.js search (rebuilt when items change) ────────────────────────────────
let fuse;
function rebuildFuse() {
  const items = db.prepare('SELECT * FROM items').all();
  fuse = new Fuse(items, { threshold: 0.4, keys: ['name_en', 'name_cn'], includeScore: true });
}
rebuildFuse();

// ── Helpers ───────────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function nextPrNumber() {
  const year = new Date().getFullYear();
  const row = db.prepare(
    `SELECT pr_number FROM pr WHERE pr_number LIKE ? ORDER BY pr_id DESC LIMIT 1`
  ).get(`PR-${year}-%`);
  if (!row) return `PR-${year}-001`;
  const seq = parseInt(row.pr_number.split('-')[2], 10) + 1;
  return `PR-${year}-${String(seq).padStart(3, '0')}`;
}

function nextPoNumber() {
  const year = new Date().getFullYear();
  const row = db.prepare(
    `SELECT po_number FROM po WHERE po_number LIKE ? ORDER BY po_id DESC LIMIT 1`
  ).get(`PO-${year}-%`);
  if (!row) return `PO-${year}-001`;
  const seq = parseInt(row.po_number.split('-')[2], 10) + 1;
  return `PO-${year}-${String(seq).padStart(3, '0')}`;
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

// ── Auth middleware ────────────────────────────────────────────────────────────
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

// ── Auth routes ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  req.session.user = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.session.user });
});

// ── Items ─────────────────────────────────────────────────────────────────────

// GET /api/items — all items (for admin item master)
app.get('/api/items', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY item_id').all();
  res.json(rows);
});

// GET /api/items/search?q=
app.get('/api/items/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const results = fuse.search(q).slice(0, 5).map(r => r.item);
  res.json(results);
});

// GET /api/items/departments
app.get('/api/items/departments', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT department FROM items WHERE department IS NOT NULL ORDER BY department').all();
  res.json(rows.map(r => r.department));
});

// POST /api/items — add new item
app.post('/api/items', requireAuth, (req, res) => {
  const { name_en, name_cn, category, uom, department } = req.body;
  if (!name_en) return res.status(400).json({ error: 'name_en required' });

  // auto-generate item_id
  const last = db.prepare("SELECT item_id FROM items ORDER BY item_id DESC LIMIT 1").get();
  let nextNum = 1;
  if (last) {
    const m = last.item_id.match(/ITEM-(\d+)/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  const item_id = `ITEM-${String(nextNum).padStart(4, '0')}`;

  db.prepare(
    `INSERT INTO items (item_id, name_en, name_cn, category, uom, department)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(item_id, name_en, name_cn || '', category || '', uom || '', department || '');

  rebuildFuse();
  res.json({ item_id });
});

// ── Purchase Requests ─────────────────────────────────────────────────────────

// POST /api/pr
app.post('/api/pr', requireRole('requester', 'purchasing', 'admin'), (req, res) => {
  const { requested_by, notes, items } = req.body;
  const requester_id = req.session.user ? String(req.session.user.id) : '';
  if (!requested_by || !items?.length)
    return res.status(400).json({ error: 'requested_by and items required' });

  // Department is now per line item; derive PR-level dept from first item for legacy fields
  const department = (items[0] && items[0].department) || '';
  const pr_number = nextPrNumber();

  const insertPr = db.prepare(
    `INSERT INTO pr (pr_number, requested_by, department, date_requested, status, notes, requester_id)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO pr_items (pr_id, item_id, qty, qty_requested, uom, est_unit_price, notes, status, department)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );

  const run = db.transaction(() => {
    const { lastInsertRowid: pr_id } = insertPr.run(pr_number, requested_by, department, today(), notes || '', requester_id || '');
    for (const it of items) {
      insertItem.run(pr_id, it.item_id, it.qty, it.qty, it.uom, it.est_unit_price || null, it.notes || '', it.department || '');
    }
    return pr_id;
  });

  const pr_id = run();
  res.json({ pr_id, pr_number });
});

// GET /api/uom — all distinct UOM values
app.get('/api/uom', requireAuth, (_req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT uom FROM items WHERE uom IS NOT NULL AND uom != '' ORDER BY uom"
  ).all();
  res.json(rows.map(r => r.uom));
});

// GET /api/vendors/search?q=
app.get('/api/vendors/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q.toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT vendor_id, name, category, contact, phone, email, city
    FROM vendors
    WHERE LOWER(name) LIKE ? OR LOWER(vendor_id) LIKE ?
    ORDER BY name LIMIT 10
  `).all(like, like);
  res.json(rows);
});

// GET /api/pr — optional ?requester_id= and ?search= filters
app.get('/api/pr', requireAuth, (req, res) => {
  const requester_id = req.query.requester_id;
  const search = (req.query.search || '').trim();
  let sql = `
    SELECT p.*,
           COUNT(pi.pr_item_id) AS item_count,
           SUM(CASE WHEN pi.status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
           SUM(CASE WHEN pi.status = 'approved' AND (
             SELECT COALESCE(SUM(poi.qty), 0) FROM po_items poi WHERE poi.pr_item_id = pi.pr_item_id
           ) >= COALESCE(pi.qty_approved, pi.qty_requested, pi.qty) THEN 1 ELSE 0 END) AS fulfilled_count,
           (SELECT COUNT(*) FROM po
             JOIN po_items poi ON poi.po_id = po.po_id
             JOIN pr_items pi2 ON pi2.pr_item_id = poi.pr_item_id
             WHERE pi2.pr_id = p.pr_id) AS has_po,
           (SELECT COUNT(*) FROM gl_export_log gel
             JOIN po ON po.po_id = gel.po_id
             JOIN po_items poi ON poi.po_id = po.po_id
             JOIN pr_items pi3 ON pi3.pr_item_id = poi.pr_item_id
             WHERE pi3.pr_id = p.pr_id) AS has_gl
    FROM pr p
    LEFT JOIN pr_items pi ON pi.pr_id = p.pr_id
  `;
  const params = [];
  const conditions = [];
  if (requester_id) {
    conditions.push('p.requester_id = ?');
    params.push(requester_id);
  }
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    conditions.push(`(
      LOWER(p.pr_number) LIKE ? OR
      LOWER(p.requested_by) LIKE ? OR
      p.pr_id IN (
        SELECT DISTINCT pi2.pr_id FROM pr_items pi2
        JOIN items i ON i.item_id = pi2.item_id
        WHERE LOWER(i.name_en) LIKE ? OR LOWER(i.name_cn) LIKE ?
      )
    )`);
    params.push(like, like, like, like);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ` GROUP BY p.pr_id ORDER BY p.pr_id DESC`;
  const rows = db.prepare(sql).all(...params);
  const result = rows.map(r => {
    const approved = r.approved_count || 0;
    const fulfilled = r.fulfilled_count || 0;
    let fulfillment_status = null;
    if (r.status === 'approved') {
      if (approved === 0)           fulfillment_status = 'unfulfilled';
      else if (fulfilled >= approved) fulfillment_status = 'fulfilled';
      else if (fulfilled > 0)         fulfillment_status = 'partial';
      else                            fulfillment_status = 'unfulfilled';
    }
    return {
      ...r,
      approval_summary: `${approved}/${r.item_count || 0} approved`,
      fulfillment_status,
      fulfilled_count: fulfilled,
    };
  });
  res.json(result);
});

// GET /api/pr/:id
app.get('/api/pr/:id', requireAuth, (req, res) => {
  const pr = db.prepare('SELECT * FROM pr WHERE pr_id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });

  const rawItems = db.prepare(`
    SELECT pi.*, i.name_en, i.name_cn, i.category,
           COALESCE((
             SELECT SUM(poi.qty)
             FROM po_items poi
             WHERE poi.pr_item_id = pi.pr_item_id
           ), 0) AS qty_fulfilled
    FROM pr_items pi
    JOIN items i ON i.item_id = pi.item_id
    WHERE pi.pr_id = ?
  `).all(req.params.id);

  const lineItems = rawItems.map(item => {
    const qtyFulfilled = item.qty_fulfilled;
    const qtyApproved  = item.qty_approved ?? item.qty_requested ?? item.qty;
    let fulfillment_status;
    if      (qtyFulfilled === 0)             fulfillment_status = 'unfulfilled';
    else if (qtyFulfilled >= qtyApproved)    fulfillment_status = 'fulfilled';
    else                                     fulfillment_status = 'partial';
    return { ...item, fulfillment_status };
  });

  const history = db.prepare('SELECT * FROM approvals WHERE pr_id = ? ORDER BY approval_id').all(req.params.id);
  const { estimated_total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_unit_price * qty), 0) AS estimated_total FROM pr_items WHERE pr_id = ?`
  ).get(req.params.id);
  res.json({ ...pr, line_items: lineItems, history, estimated_total });
});


// POST /api/pr/:id/approve
app.post('/api/pr/:id/approve', requireRole('md', 'admin'), (req, res) => {
  const { approved_by, action, notes } = req.body;
  if (!approved_by || !action) return res.status(400).json({ error: 'approved_by and action required' });
  if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'action must be approved or rejected' });

  const pr = db.prepare('SELECT * FROM pr WHERE pr_id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO approvals (pr_id, approved_by, action, timestamp, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(pr.pr_id, approved_by, action, nowIso(), notes || '');
    db.prepare('UPDATE pr SET status = ? WHERE pr_id = ?').run(action, pr.pr_id);
  });
  run();

  res.json({ success: true, status: action });
});

// POST /api/pr/:id/items/:itemId/approve — per-item approval
app.post('/api/pr/:id/items/:itemId/approve', requireRole('md', 'admin'), (req, res) => {
  const { approved_by, action, qty_approved, notes } = req.body;
  if (!approved_by || !action) return res.status(400).json({ error: 'approved_by and action required' });
  if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'action must be approved or rejected' });

  const pr = db.prepare('SELECT * FROM pr WHERE pr_id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'PR not found' });

  const prItem = db.prepare('SELECT * FROM pr_items WHERE pr_item_id = ? AND pr_id = ?').get(req.params.itemId, req.params.id);
  if (!prItem) return res.status(404).json({ error: 'PR item not found' });

  const run = db.transaction(() => {
    if (action === 'approved') {
      db.prepare('UPDATE pr_items SET status = ?, qty_approved = ? WHERE pr_item_id = ?').run(action, qty_approved ?? prItem.qty_requested, prItem.pr_item_id);
    } else {
      db.prepare('UPDATE pr_items SET status = ? WHERE pr_item_id = ?').run(action, prItem.pr_item_id);
    }

    const itemName = db.prepare('SELECT name_en FROM items WHERE item_id = ?').get(prItem.item_id)?.name_en || prItem.item_id;
    db.prepare(
      `INSERT INTO approvals (pr_id, approved_by, action, timestamp, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(pr.pr_id, approved_by, action, nowIso(), `Item: ${itemName}${notes ? ' — ' + notes : ''}`);

    // Auto-update PR status based on all item statuses
    const allItems = db.prepare('SELECT status FROM pr_items WHERE pr_id = ?').all(pr.pr_id);
    const anyPending = allItems.some(i => !i.status || i.status === 'pending');
    const allRejected = allItems.every(i => i.status === 'rejected');
    if (!anyPending) {
      const newPrStatus = allRejected ? 'rejected' : 'approved';
      db.prepare('UPDATE pr SET status = ? WHERE pr_id = ?').run(newPrStatus, pr.pr_id);
    }
  });

  run();

  const updated = db.prepare('SELECT * FROM pr_items WHERE pr_item_id = ?').get(req.params.itemId);
  res.json(updated);
});

// ── Purchase Orders ───────────────────────────────────────────────────────────

// GET /api/pr-items/approved — all approved items not yet fully fulfilled (for PO creation)
app.get('/api/pr-items/approved', requireRole('purchasing', 'admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      pi.pr_item_id, pi.pr_id, pi.item_id, pi.qty_approved, pi.qty_requested, pi.uom,
      pi.estimated_unit_price, pi.est_unit_price,
      i.name_en, i.name_cn, i.category,
      p.pr_number, p.requested_by, p.date_requested,
      COALESCE(pi.department, p.department) AS department,
      COALESCE((
        SELECT SUM(poi.qty) FROM po_items poi WHERE poi.pr_item_id = pi.pr_item_id
      ), 0) AS qty_fulfilled
    FROM pr_items pi
    JOIN items i ON i.item_id = pi.item_id
    JOIN pr p ON p.pr_id = pi.pr_id
    WHERE pi.status = 'approved'
    ORDER BY p.pr_id DESC, pi.pr_item_id
  `).all();

  // Only return items not fully fulfilled
  const result = rows.filter(r => {
    const approved = r.qty_approved ?? r.qty_requested;
    return r.qty_fulfilled < approved;
  });
  res.json(result);
});

// POST /api/po — accepts array of items for multi-PR PO
// Body: { vendor_name, items: [{ pr_item_id, unit_price, qty_ordered, qty_note? }] }
app.post('/api/po', requireRole('purchasing', 'admin'), (req, res) => {
  const PPH_RATES = { pph23: 0.02, pph15: 0.012, pph22_solar: 0.003, pph22_impor: 0.025 };
  const { vendor_name, items, include_vat = false, pph_type = null } = req.body;
  if (!vendor_name || !items?.length)
    return res.status(400).json({ error: 'vendor_name and items array required' });
  if (pph_type && !PPH_RATES[pph_type])
    return res.status(400).json({ error: `Unknown pph_type: ${pph_type}` });

  // Validate all items
  for (const it of items) {
    if (!it.pr_item_id || it.unit_price == null || it.qty_ordered == null)
      return res.status(400).json({ error: 'Each item needs pr_item_id, unit_price, qty_ordered' });
    const prItem = db.prepare('SELECT * FROM pr_items WHERE pr_item_id = ?').get(it.pr_item_id);
    if (!prItem) return res.status(400).json({ error: `pr_item_id ${it.pr_item_id} not found` });
    if (prItem.status !== 'approved') return res.status(400).json({ error: `Item ${it.pr_item_id} is not approved` });
  }

  const subtotal   = items.reduce((s, it) => s + it.unit_price * it.qty_ordered, 0);
  const vat_amount = include_vat ? subtotal * 0.11 : 0;
  const pph_rate   = pph_type ? PPH_RATES[pph_type] : 0;
  const pph_amount = subtotal * pph_rate;
  const total_amount = subtotal + vat_amount - pph_amount;

  const po_number = nextPoNumber();
  // Use first item's pr_id as the primary reference
  const firstPrItem = db.prepare('SELECT * FROM pr_items WHERE pr_item_id = ?').get(items[0].pr_item_id);
  const pr_id = firstPrItem.pr_id;

  let po_id;
  const run = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO po (po_number, pr_id, vendor_name, date_created, status, total_amount, include_vat, pph_type)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`
    ).run(po_number, pr_id, vendor_name, today(), total_amount, include_vat ? 1 : 0, pph_type || null);
    po_id = r.lastInsertRowid;

    const insertItem = db.prepare(
      `INSERT INTO po_items (po_id, pr_item_id, item_id, qty, uom, unit_price, total_price, vendor_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const it of items) {
      const prItem = db.prepare('SELECT * FROM pr_items WHERE pr_item_id = ?').get(it.pr_item_id);
      insertItem.run(po_id, it.pr_item_id, prItem.item_id, it.qty_ordered, prItem.uom, it.unit_price, it.unit_price * it.qty_ordered, vendor_name);
    }
  });

  try { run(); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ po_id, po_number });
});

// GET /api/po — optional ?search= filter
app.get('/api/po', requireAuth, (req, res) => {
  const search = (req.query.search || '').trim();
  let sql = `
    SELECT po.*,
      GROUP_CONCAT(DISTINCT pr.pr_number) AS pr_numbers
    FROM po
    LEFT JOIN po_items poi ON poi.po_id = po.po_id
    LEFT JOIN pr_items pi ON pi.pr_item_id = poi.pr_item_id
    LEFT JOIN pr ON pr.pr_id = pi.pr_id
  `;
  const params = [];
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    sql += `
    WHERE (
      LOWER(po.po_number) LIKE ? OR
      LOWER(po.vendor_name) LIKE ? OR
      po.po_id IN (
        SELECT DISTINCT poi2.po_id FROM po_items poi2
        JOIN items i ON i.item_id = poi2.item_id
        WHERE LOWER(i.name_en) LIKE ? OR LOWER(i.name_cn) LIKE ?
      )
    )`;
    params.push(like, like, like, like);
  }
  sql += `
    GROUP BY po.po_id
    ORDER BY po.po_id DESC
  `;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET /api/po/:id
app.get('/api/po/:id', requireAuth, (req, res) => {
  const po = db.prepare(`
    SELECT po.*, GROUP_CONCAT(DISTINCT pr.pr_number) AS pr_numbers
    FROM po
    LEFT JOIN po_items poi ON poi.po_id = po.po_id
    LEFT JOIN pr_items pi ON pi.pr_item_id = poi.pr_item_id
    LEFT JOIN pr ON pr.pr_id = pi.pr_id
    WHERE po.po_id = ?
    GROUP BY po.po_id
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });

  const lineItems = db.prepare(`
    SELECT poi.*, i.name_en, i.name_cn, pr.pr_number
    FROM po_items poi
    JOIN items i ON i.item_id = poi.item_id
    LEFT JOIN pr_items pi ON pi.pr_item_id = poi.pr_item_id
    LEFT JOIN pr ON pr.pr_id = pi.pr_id
    WHERE poi.po_id = ?
  `).all(req.params.id);

  res.json({ ...po, line_items: lineItems });
});

// GET /api/po/:id/print — printable HTML for PDF export
app.get('/api/po/:id/print', requireAuth, (req, res) => {
  const po = db.prepare(`SELECT * FROM po WHERE po_id = ?`).get(req.params.id);
  if (!po) return res.status(404).send('Not found');

  const lineItems = db.prepare(`
    SELECT poi.*, i.name_en, i.name_cn, pr.pr_number
    FROM po_items poi
    JOIN items i ON i.item_id = poi.item_id
    LEFT JOIN pr_items pi ON pi.pr_item_id = poi.pr_item_id
    LEFT JOIN pr ON pr.pr_id = pi.pr_id
    WHERE poi.po_id = ?
  `).all(req.params.id);

  const PPH_LABELS = {
    pph23:      'PPH 23 Jasa Badan (2%)',
    pph15:      'PPH 15 Jasa Tongkang (1,2%)',
    pph22_solar:'PPH 22 Solar (0,3%)',
    pph22_impor:'PPH 22 Impor (2,5%)',
  };
  const PPH_RATES = { pph23: 0.02, pph15: 0.012, pph22_solar: 0.003, pph22_impor: 0.025 };

  const subtotal   = lineItems.reduce((s, i) => s + i.total_price, 0);
  const vatAmount  = po.include_vat  ? subtotal * 0.11 : 0;
  const pphRate    = PPH_RATES[po.pph_type] || 0;
  const pphAmount  = subtotal * pphRate;
  const pphLabel   = PPH_LABELS[po.pph_type] || 'PPH';
  const grandTotal = subtotal + vatAmount - pphAmount;

  const fmt = n => 'Rp ' + Math.round(n).toLocaleString('id-ID');

  const itemRows = lineItems.map(it => `
    <tr>
      <td>${it.item_id}</td>
      <td>${it.name_en}${it.name_cn ? '<br><span class="cn">' + it.name_cn + '</span>' : ''}</td>
      <td class="num">${it.qty.toLocaleString('id-ID')}</td>
      <td class="num">${fmt(it.unit_price)}</td>
      <td class="num">0</td>
      <td class="num">${fmt(it.total_price)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>PO ${po.po_number}</title>
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
  .to-box { flex:1; }
  .to-box .label { font-size:9pt; color:#666; margin-bottom:4px; }
  .to-box .vendor { font-weight:600; font-size:11pt; margin-bottom:3px; }
  .to-box .addr { font-size:9.5pt; color:#333; }
  .po-box { border:1.5px solid #111; padding:10px 14px; min-width:240px; }
  .po-box .title { font-size:18pt; font-weight:700; margin-bottom:8px; }
  .po-meta { display:grid; grid-template-columns:auto 1fr; gap:3px 8px; font-size:9.5pt; }
  .po-meta .key { color:#555; }
  .po-meta .val { font-weight:600; }
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
  @media print {
    .print-btn { display:none; }
    body { padding:0; }
    @page { margin:14mm 12mm; size:A4 portrait; }
  }
</style>
</head>
<body>

<button class="print-btn" onclick="window.print()">⬇ Simpan / Print PDF</button>

<div class="header">
  <div class="logo-block">
    <div class="logo-circle"><span>Merge<br>Coal</span></div>
    <div>
      <div class="company-name">PT Merge Mining Industri</div>
      <div class="company-addr">Gedung The Honey Lady, Lt. 15 Unit 1503, Pluit, Penjaringan, Jakarta Utara<br>Kota Administrasi Jakarta Utara DKI Jakarta 12190<br>Indonesia</div>
    </div>
  </div>
</div>

<hr class="divider">

<div class="two-col">
  <div class="to-box">
    <div class="label">To</div>
    <div class="vendor">${po.vendor_name}</div>
  </div>
  <div class="po-box">
    <div class="title">Purchase Order</div>
    <div class="po-meta">
      <span class="key">Number</span><span class="val">: ${po.po_number}</span>
      <span class="key">Date</span><span class="val">: ${po.date_created}</span>
    </div>
  </div>
</div>

<table class="items">
  <thead>
    <tr>
      <th style="width:110px">Item Code</th>
      <th>Item Name</th>
      <th class="num" style="width:90px">Quantity</th>
      <th class="num" style="width:130px">@Price</th>
      <th class="num" style="width:80px">Discount</th>
      <th class="num" style="width:140px">Total</th>
    </tr>
  </thead>
  <tbody>
    ${itemRows}
  </tbody>
</table>

<div class="bottom">
  <div class="notes-box">
    <div class="label">Notes</div>
    <div>${po.qty_note || '—'}</div>
  </div>
  <div class="totals">
    <div class="total-row"><span>Sub Total</span><span>${fmt(subtotal)}</span></div>
    <div class="total-row"><span>Diskon</span><span>0</span></div>
    ${po.include_vat ? `<div class="total-row"><span>PPN (11%)</span><span>${fmt(vatAmount)}</span></div>` : ''}
    ${po.pph_type    ? `<div class="total-row"><span>${pphLabel}</span><span>− ${fmt(pphAmount)}</span></div>` : ''}
    <div class="total-row"><span>Biaya Lain-lain</span><span>0</span></div>
    <div class="total-row grand"><span>Total</span><span>${fmt(grandTotal)}</span></div>
  </div>
</div>

<div class="sigs">
  <div class="sig-block">
    <div class="sig-label">Ordered By,</div>
    <div class="sig-line">Purchasing</div>
  </div>
  <div class="sig-block">
    <div class="sig-label">Approved By,</div>
    <div class="sig-line">Direktur</div>
  </div>
</div>

<p style="text-align:right;font-size:8.5pt;color:#999;margin-top:24px">Halaman 1 dari 1</p>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// GET /api/po/:id/export — GL CSV download
app.get('/api/po/:id/export', requireAuth, (req, res) => {
  const po = db.prepare(`
    SELECT po.*, pr.pr_number, pr.requested_by, pr.department
    FROM po JOIN pr ON pr.pr_id = po.pr_id
    WHERE po.po_id = ?
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });

  const lineItems = db.prepare(`
    SELECT poi.*, i.name_en FROM po_items poi
    JOIN items i ON i.item_id = poi.item_id
    WHERE poi.po_id = ?
  `).all(req.params.id);

  const itemNames = lineItems.map(i => i.name_en).join(', ');
  const description = `${po.po_number} | ${po.vendor_name} | ${itemNames}`;
  const dateStr = po.date_created;

  const glRows = [
    {
      date: dateStr,
      account_code: 5000,
      account_name: 'Inventory/Expense',
      description,
      debit: po.total_amount.toFixed(2),
      credit: ''
    },
    {
      date: dateStr,
      account_code: 2100,
      account_name: 'Accounts Payable',
      description,
      debit: '',
      credit: po.total_amount.toFixed(2)
    }
  ];

  const exportDate = today().replace(/-/g, '');
  const filename = `GL_${po.po_number}_${exportDate}.csv`;
  const filepath = path.join(EXPORTS, filename);

  const parser = new Parser({ fields: ['date', 'account_code', 'account_name', 'description', 'debit', 'credit'] });
  const csv = parser.parse(glRows);
  fs.writeFileSync(filepath, csv);

  db.prepare(
    `INSERT INTO gl_export_log (po_id, export_date, filename) VALUES (?, ?, ?)`
  ).run(po.po_id, today(), filename);

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// ── Admin: Delete routes ───────────────────────────────────────────────────────

// Delete PR (cascades to pr_items and approvals)
app.delete('/api/pr/:id', requireRole('admin'), (req, res) => {
  const pr = db.prepare('SELECT pr_id FROM pr WHERE pr_id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'PR not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM approvals WHERE pr_id = ?').run(req.params.id);
    db.prepare('DELETE FROM pr_items WHERE pr_id = ?').run(req.params.id);
    db.prepare('DELETE FROM pr WHERE pr_id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// Delete a single PR line item
app.delete('/api/pr-items/:itemId', requireRole('admin'), (req, res) => {
  const item = db.prepare('SELECT pr_item_id FROM pr_items WHERE pr_item_id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM pr_items WHERE pr_item_id = ?').run(req.params.itemId);
  res.json({ ok: true });
});

// Delete PO (cascades to po_items and gl_export_log)
app.delete('/api/po/:id', requireRole('admin'), (req, res) => {
  const po = db.prepare('SELECT po_id FROM po WHERE po_id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM gl_export_log WHERE po_id = ?').run(req.params.id);
    db.prepare('DELETE FROM po_items WHERE po_id = ?').run(req.params.id);
    db.prepare('DELETE FROM po WHERE po_id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// Delete item from item master
app.delete('/api/items/:id', requireRole('admin'), (req, res) => {
  const item = db.prepare('SELECT item_id FROM items WHERE item_id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM items WHERE item_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Get all users
app.get('/api/users', requireRole('admin'), (_req, res) => {
  const users = db.prepare('SELECT id, username, role, full_name FROM users ORDER BY id').all();
  res.json(users);
});

// Delete user
app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  if (String(req.session.user.id) === String(req.params.id)) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Procurement app running → http://localhost:${PORT}`));
