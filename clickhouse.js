'use strict';

/**
 * clickhouse.js — ClickHouse HTTP client for the procurement app.
 *
 * Thin wrapper around the ClickHouse HTTP interface (port 8123).
 * Uses JSONEachRow format for inserts and selects.
 *
 * Usage:
 *   const ch = require('./clickhouse');
 *   const rows = await ch.query('SELECT * FROM items WHERE company_id = {cid:String}', { cid: 'PTMMI' });
 *   await ch.insert('items', [{ item_id: '...', ... }]);
 */

const http = require('http');
const { randomUUID } = require('crypto');

const COMPANY_ID = 'PTMMI';

const config = {
  host:     process.env.CLICKHOUSE_HOST     || 'localhost',
  port:     parseInt(process.env.CLICKHOUSE_PORT || '8123'),
  db:       process.env.CLICKHOUSE_DB       || 'procurement',
  user:     process.env.CLICKHOUSE_USER     || 'procurement_user',
  password: process.env.CLICKHOUSE_PASSWORD || 'changeme',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpPost(path, body, contentType = 'text/plain') {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf-8');
    const auth    = Buffer.from(`${config.user}:${config.password}`).toString('base64');
    const req     = http.request({
      hostname: config.host,
      port:     config.port,
      path,
      method:   'POST',
      headers: {
        'Content-Type':   contentType,
        'Content-Length': bodyBuf.length,
        'Authorization':  `Basic ${auth}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`ClickHouse error ${res.statusCode}: ${data.slice(0, 400)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a SELECT query and return array of row objects.
 * @param {string} sql - SQL query. Use {param:Type} placeholders.
 * @param {object} params - Query parameters.
 */
async function query(sql, params = {}) {
  // Build query string with params encoded as URL query params
  const paramStr = Object.entries(params)
    .map(([k, v]) => `param_${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const path = `/?database=${config.db}&default_format=JSONEachRow${paramStr ? '&' + paramStr : ''}`;
  const raw  = await httpPost(path, sql);
  if (!raw.trim()) return [];
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * Insert rows into a ClickHouse table.
 * @param {string} table - Target table name.
 * @param {object[]} rows - Array of row objects.
 */
async function insert(table, rows) {
  if (!rows || rows.length === 0) return;
  const ndjson = rows.map(r => JSON.stringify(r)).join('\n');
  const path   = `/?database=${config.db}&query=${encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`)}`;
  await httpPost(path, ndjson, 'application/x-ndjson');
}

/**
 * Run a mutation (INSERT/ALTER/TRUNCATE) that returns no rows.
 */
async function execute(sql) {
  const path = `/?database=${config.db}`;
  await httpPost(path, sql);
}

/**
 * Ping ClickHouse. Returns true if reachable.
 */
async function ping() {
  return new Promise((resolve) => {
    http.get({ hostname: config.host, port: config.port, path: '/ping' }, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Generate a new UUID v4. */
function newUUID() { return randomUUID(); }

/** Current Jakarta timestamp for ClickHouse DateTime64(3) fields. */
function nowTs() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

/** Current version value for ReplacingMergeTree. */
function version() { return BigInt(Date.now()); }

/** Get current state of a single entity (handles ReplacingMergeTree eventual dedup). */
async function getOne(table, idField, idValue, companyId = COMPANY_ID) {
  const rows = await query(
    `SELECT * FROM ${table} FINAL
     WHERE company_id = {cid:String} AND ${idField} = {id:String} AND is_deleted = 0
     LIMIT 1`,
    { cid: companyId, id: String(idValue) }
  );
  return rows[0] || null;
}

/** Soft-delete a single entity by inserting a replacement row with is_deleted=1. */
async function softDelete(table, idField, idValue, current, companyId = COMPANY_ID) {
  const row = { ...current, is_deleted: 1, version: Number(version()), updated_at: nowTs() };
  await insert(table, [row]);
}

module.exports = {
  query,
  insert,
  execute,
  ping,
  newUUID,
  nowTs,
  version,
  getOne,
  softDelete,
  COMPANY_ID,
  config,
};
