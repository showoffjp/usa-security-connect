/**
 * The rest of what an officer records on post, alongside the post log:
 *
 *   * the activity log - short, time-stamped entries through the shift, which
 *     are what a daily activity report is made of;
 *   * maintenance and hazard reports - things wrong with the building that the
 *     client has to fix, which the client acknowledges and closes from the
 *     portal;
 *   * lost and found - property found on site, where it is kept, and how it
 *     left.
 *
 * Mounted on /api/post-log next to postLog.js and written the same way: an
 * officer writes only to the post they are clocked in at, and reads their
 * own site; supervisors read and manage every site.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields, parseDay } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, atLeast } from '../shared.js';
import { toSql } from '../services/compliance.js';
import { requireDuty, readingPost } from './postLog.js';

export const siteLogRouter = Router();
siteLogRouter.use(requireAuth);

export const ACTIVITY_CATEGORIES = ['patrol', 'observation', 'access', 'alarm', 'safety', 'customer_service', 'other'];
export const ISSUE_CATEGORIES = ['lighting', 'door_lock', 'leak', 'damage', 'hazard', 'cleanliness', 'equipment', 'other'];
export const ISSUE_PRIORITIES = ['low', 'normal', 'urgent'];
export const FOUND_CATEGORIES = ['phone', 'wallet', 'keys', 'bag', 'id', 'clothing', 'jewelry', 'other'];

const supervisor = requireRole(ROLES.SUPERVISOR);
const isSupervisor = (req) => atLeast(req.user.role, ROLES.SUPERVISOR);

const activitySelect = `
  SELECT a.*, s.name AS site_name, p.name AS post_name, u.first_name || ' ' || u.last_name AS officer_name
  FROM activity_entries a
  JOIN sites s ON s.id = a.site_id
  LEFT JOIN posts p ON p.id = a.post_id
  LEFT JOIN users u ON u.id = a.user_id`;
const presentActivity = (a) => ({ ...isoFields(a, ['occurred_at', 'created_at']), client_visible: Boolean(a.client_visible) });

const issueSelect = `
  SELECT i.*, s.name AS site_name, p.name AS post_name, u.first_name || ' ' || u.last_name AS reported_by_name,
         c.name AS closed_by_client_name, cs.first_name || ' ' || cs.last_name AS closed_by_staff_name
  FROM site_issues i
  JOIN sites s ON s.id = i.site_id
  LEFT JOIN posts p ON p.id = i.post_id
  LEFT JOIN users u ON u.id = i.reported_by
  LEFT JOIN client_users c ON c.id = i.closed_by_client
  LEFT JOIN users cs ON cs.id = i.closed_by_staff`;
const ISSUE_TIMES = ['created_at', 'acknowledged_at', 'fixed_at'];
const presentIssue = (i) => isoFields(i, ISSUE_TIMES);

const foundSelect = `
  SELECT f.*, s.name AS site_name, u.first_name || ' ' || u.last_name AS found_by_name,
         cb.first_name || ' ' || cb.last_name AS closed_by_name
  FROM lost_found f
  JOIN sites s ON s.id = f.site_id
  LEFT JOIN users u ON u.id = f.found_by
  LEFT JOIN users cb ON cb.id = f.closed_by`;
const presentFound = (f) => isoFields(f, ['found_at', 'closed_at', 'created_at']);

/* ================================================================ officer == */

/** The officer's site: today's activity on the post, open issues, property held. */
siteLogRouter.get(
  '/site',
  wrap(async (req, res) => {
    const post = await readingPost(req.user.id);
    if (!post) return res.json({ post: null, activity: [], issues: [], found: [] });
    const since = toSql(new Date(Date.now() - 24 * 3600000));
    const activity = await db
      .prepare(`${activitySelect} WHERE a.site_id = ? AND a.occurred_at >= ? ORDER BY a.occurred_at DESC LIMIT 100`)
      .all(post.site_id, since);
    const issues = await db
      .prepare(
        `${issueSelect} WHERE i.site_id = ? AND (i.status <> 'fixed' OR i.fixed_at >= ?)
         ORDER BY CASE i.status WHEN 'fixed' THEN 1 ELSE 0 END, CASE i.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, i.created_at DESC
         LIMIT 50`
      )
      .all(post.site_id, toSql(new Date(Date.now() - 7 * 86400000)));
    const found = await db
      .prepare(
        `${foundSelect} WHERE f.site_id = ? AND (f.status = 'held' OR f.closed_at >= ?) ORDER BY f.status = 'held' DESC, f.found_at DESC LIMIT 50`
      )
      .all(post.site_id, toSql(new Date(Date.now() - 7 * 86400000)));
    res.json({
      post,
      // The officer can take back their own entries from the shift they are on.
      activity: activity.map((a) => ({
        ...presentActivity(a),
        removable: a.user_id === req.user.id && Boolean(post.time_entry_id) && a.time_entry_id === post.time_entry_id,
      })),
      issues: issues.map(presentIssue),
      found: found.map(presentFound),
      categories: { activity: ACTIVITY_CATEGORIES, issues: ISSUE_CATEGORIES, priorities: ISSUE_PRIORITIES, found: FOUND_CATEGORIES },
    });
  })
);

/* ------------------------------------------------------------- activity -- */

const activitySchema = z.object({
  category: z.enum(ACTIVITY_CATEGORIES).default('observation'),
  body: z.string().trim().min(3, 'Write what happened.').max(1000),
  clientVisible: z.boolean().default(true),
  /** When it happened, if logged after the fact - within the shift, never the future. */
  occurredAt: z.string().datetime({ offset: true }).optional().nullable(),
});

siteLogRouter.post(
  '/activity',
  wrap(async (req, res) => {
    const body = parse(activitySchema, req.body);
    const post = await requireDuty(req);
    let when = new Date();
    if (body.occurredAt) {
      when = new Date(body.occurredAt);
      const entry = await db.prepare(`SELECT clock_in_at FROM time_entries WHERE id = ?`).get(post.time_entry_id);
      if (when > new Date(Date.now() + 60000) || when < new Date(entry.clock_in_at)) {
        throw new HttpError(422, 'An entry has to be for a time during this shift.', [
          { field: 'occurredAt', message: 'Pick a time since you clocked in.' },
        ]);
      }
    }
    const info = await db
      .prepare(
        `INSERT INTO activity_entries (site_id, post_id, user_id, time_entry_id, category, body, client_visible, occurred_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(post.site_id, post.post_id, req.user.id, post.time_entry_id, body.category, body.body, body.clientVisible, toSql(when));
    const row = await db.prepare(`${activitySelect} WHERE a.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ entry: presentActivity(row) });
  })
);

/** An officer can correct their own entry the same shift; a supervisor any. */
siteLogRouter.delete(
  '/activity/:id',
  wrap(async (req, res) => {
    const row = await db.prepare(`SELECT * FROM activity_entries WHERE id = ?`).get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Entry not found.');
    if (!isSupervisor(req)) {
      const post = await requireDuty(req);
      if (row.user_id !== req.user.id || row.time_entry_id !== post.time_entry_id) {
        throw new HttpError(403, 'You can only remove your own entries from this shift.');
      }
    }
    await db.prepare(`DELETE FROM activity_entries WHERE id = ?`).run(row.id);
    await audit(req.user.id, 'activity.removed', 'activity_entry', row.id, { body: row.body }, req.ip);
    res.json({ ok: true });
  })
);

/* --------------------------------------------------------------- issues -- */

const issueSchema = z.object({
  category: z.enum(ISSUE_CATEGORIES),
  priority: z.enum(ISSUE_PRIORITIES).default('normal'),
  locationText: z.string().trim().max(160).optional().nullable(),
  description: z.string().trim().min(5, 'Describe what is wrong.').max(1000),
});

siteLogRouter.post(
  '/issues',
  wrap(async (req, res) => {
    const body = parse(issueSchema, req.body);
    const post = await requireDuty(req);
    const info = await db
      .prepare(
        `INSERT INTO site_issues (site_id, post_id, reported_by, category, priority, location_text, description)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(post.site_id, post.post_id, req.user.id, body.category, body.priority, body.locationText || null, body.description);
    await audit(req.user.id, 'issue.reported', 'site_issue', info.lastInsertRowid, { priority: body.priority }, req.ip);
    const row = await db.prepare(`${issueSelect} WHERE i.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ issue: presentIssue(row) });
  })
);

/** Supervisors can close an issue too - the client fixed it and told us by phone. */
siteLogRouter.post(
  '/issues/:id/status',
  supervisor,
  wrap(async (req, res) => {
    const body = parse(z.object({ status: z.enum(['open', 'acknowledged', 'fixed']), note: z.string().trim().max(500).optional().nullable() }), req.body);
    const issue = await db.prepare(`SELECT * FROM site_issues WHERE id = ?`).get(Number(req.params.id));
    if (!issue) throw new HttpError(404, 'Issue not found.');
    // Worked out here rather than in SQL: a bound parameter inside a CASE
    // has no type Postgres can infer.
    const now = new Date().toISOString();
    const fixed = body.status === 'fixed';
    await db
      .prepare(
        `UPDATE site_issues SET status = ?, acknowledged_at = ?, fixed_at = ?, closed_by_staff = ?, closed_by_client = ?,
           client_note = COALESCE(?, client_note)
         WHERE id = ?`
      )
      .run(
        body.status,
        body.status === 'open' ? null : issue.acknowledged_at || now,
        fixed ? now : null,
        fixed ? req.user.id : null,
        fixed ? issue.closed_by_client : null,
        body.note || null,
        issue.id
      );
    await audit(req.user.id, `issue.${body.status}`, 'site_issue', issue.id, null, req.ip);
    const row = await db.prepare(`${issueSelect} WHERE i.id = ?`).get(issue.id);
    res.json({ issue: presentIssue(row) });
  })
);

/* --------------------------------------------------------- lost and found -- */

const foundSchema = z.object({
  description: z.string().trim().min(3, 'Describe the item.').max(300),
  category: z.enum(FOUND_CATEGORIES).default('other'),
  foundLocation: z.string().trim().max(160).optional().nullable(),
  storedLocation: z.string().trim().min(2, 'Say where it is being kept.').max(160),
});

siteLogRouter.post(
  '/found',
  wrap(async (req, res) => {
    const body = parse(foundSchema, req.body);
    const post = await requireDuty(req);
    const info = await db
      .prepare(
        `INSERT INTO lost_found (site_id, post_id, found_by, description, category, found_location, stored_location)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(post.site_id, post.post_id, req.user.id, body.description, body.category, body.foundLocation || null, body.storedLocation);
    await audit(req.user.id, 'found.logged', 'lost_found', info.lastInsertRowid, null, req.ip);
    const row = await db.prepare(`${foundSelect} WHERE f.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ item: presentFound(row) });
  })
);

/**
 * Hand an item back, or record that it was disposed of. Anyone on duty at the
 * site can do the first - the owner turns up at whichever desk - and it
 * records who took it and how to reach them, which is what matters if they
 * turn out not to be the owner.
 */
siteLogRouter.post(
  '/found/:id/close',
  wrap(async (req, res) => {
    const body = parse(
      z.discriminatedUnion('status', [
        z.object({
          status: z.literal('returned'),
          returnedTo: z.string().trim().min(2, 'Who collected it?').max(120),
          returnedContact: z.string().trim().min(5, 'A phone number or ID seen, in case of a dispute.').max(120),
        }),
        z.object({ status: z.literal('disposed') }),
      ]),
      req.body
    );
    const item = await db.prepare(`SELECT * FROM lost_found WHERE id = ?`).get(Number(req.params.id));
    if (!item) throw new HttpError(404, 'Item not found.');
    if (!isSupervisor(req)) {
      const post = await requireDuty(req);
      if (post.site_id !== item.site_id) throw new HttpError(404, 'Item not found.');
      if (body.status === 'disposed') throw new HttpError(403, 'Only a supervisor can dispose of property.');
    }
    if (item.status !== 'held') throw new HttpError(409, 'That item has already left lost and found.');
    await db
      .prepare(`UPDATE lost_found SET status = ?, returned_to = ?, returned_contact = ?, closed_at = now(), closed_by = ? WHERE id = ?`)
      .run(body.status, body.returnedTo || null, body.returnedContact || null, req.user.id, item.id);
    await audit(req.user.id, `found.${body.status}`, 'lost_found', item.id, null, req.ip);
    const row = await db.prepare(`${foundSelect} WHERE f.id = ?`).get(item.id);
    res.json({ item: presentFound(row) });
  })
);

/* ============================================================ supervisors == */

siteLogRouter.get(
  '/admin/activity',
  supervisor,
  wrap(async (req, res) => {
    const start = parseDay(req.query.date);
    if (!start) throw new HttpError(422, 'That date is not valid.');
    const end = new Date(start.getTime() + 86400000);
    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const rows = await db
      .prepare(
        `${activitySelect} WHERE a.occurred_at >= ? AND a.occurred_at < ? ${siteId ? 'AND a.site_id = ?' : ''}
         ORDER BY a.occurred_at DESC LIMIT 500`
      )
      .all(toSql(start), toSql(end), ...(siteId ? [siteId] : []));
    res.json({ entries: rows.map(presentActivity) });
  })
);

siteLogRouter.get(
  '/admin/issues',
  supervisor,
  wrap(async (req, res) => {
    const status = ['open', 'acknowledged', 'fixed', 'all', 'unresolved'].includes(req.query.status) ? req.query.status : 'unresolved';
    const siteId = req.query.siteId ? Number(req.query.siteId) : null;
    const where = [];
    const params = [];
    if (status === 'unresolved') where.push(`i.status <> 'fixed'`);
    else if (status !== 'all') {
      where.push('i.status = ?');
      params.push(status);
    }
    if (siteId) {
      where.push('i.site_id = ?');
      params.push(siteId);
    }
    const rows = await db
      .prepare(
        `${issueSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY CASE i.status WHEN 'fixed' THEN 1 ELSE 0 END, CASE i.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, i.created_at DESC
         LIMIT 300`
      )
      .all(...params);
    const counts = await db
      .prepare(`SELECT status, COUNT(*) AS n FROM site_issues GROUP BY status`)
      .all();
    res.json({ issues: rows.map(presentIssue), counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
  })
);

siteLogRouter.get(
  '/admin/found',
  supervisor,
  wrap(async (req, res) => {
    const status = ['held', 'returned', 'disposed', 'all'].includes(req.query.status) ? req.query.status : 'held';
    const rows = await db
      .prepare(`${foundSelect} ${status === 'all' ? '' : 'WHERE f.status = ?'} ORDER BY f.found_at DESC LIMIT 300`)
      .all(...(status === 'all' ? [] : [status]));
    // Held more than 30 days: due for the disposal decision.
    const stale = rows.filter((f) => f.status === 'held' && new Date(f.found_at) < new Date(Date.now() - 30 * 86400000)).length;
    res.json({ items: rows.map(presentFound), overdue: stale });
  })
);
