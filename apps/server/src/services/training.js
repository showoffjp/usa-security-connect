/**
 * Site training: who is cleared to work a post alone.
 *
 * A post marked as needing it is worked alone only by an officer a supervisor
 * has signed off there - after a shadow shift with a trained officer, a
 * walkthrough, or because they already know the post. Training lapses when an
 * officer has not worked the post for QUALIFICATION_LAPSE_DAYS, and a
 * supervisor can withdraw it. A supervisor can still roster someone untrained
 * (that is a training shift); officers cannot claim or swap into one.
 */

import { db } from '../lib/db.js';
import { isoFields } from '../lib/http.js';
import { toSql } from './compliance.js';
import { trainingState, TRAINING_METHOD_LABEL } from '../shared.js';

/** How far ahead the board looks for untrained officers on the roster. */
export const TRAINING_ROSTER_DAYS = 14;
/** How far ahead an untrained officer on the roster raises an alert. */
export const TRAINING_ALERT_DAYS = 7;
/** A shift worked at the post this recently, untrained, is ready to sign off. */
const READY_DAYS = 30;

const DAY = 86400000;

const lastWorkedSql = `(SELECT MAX(te.clock_in_at) FROM time_entries te
                        WHERE te.post_id = q.post_id AND te.user_id = q.user_id AND te.clock_out_at IS NOT NULL)`;

const qualificationSelect = `
  SELECT q.*, u.first_name || ' ' || u.last_name AS officer, u.employee_code,
         sb.first_name || ' ' || sb.last_name AS signed_off_by_name,
         rb.first_name || ' ' || rb.last_name AS revoked_by_name,
         p.name AS post_name, p.site_id, s.name AS site_name,
         ${lastWorkedSql} AS last_worked_at
  FROM post_qualifications q
  JOIN users u ON u.id = q.user_id
  JOIN posts p ON p.id = q.post_id
  JOIN sites s ON s.id = p.site_id
  LEFT JOIN users sb ON sb.id = q.signed_off_by
  LEFT JOIN users rb ON rb.id = q.revoked_by`;

/** A qualification as the API shows it, with where it stands now. */
export function presentQualification(q, now = new Date()) {
  const row = isoFields(q, ['trained_at', 'revoked_at', 'last_worked_at']);
  return {
    ...row,
    state: trainingState(q, q.last_worked_at, now),
    method_label: TRAINING_METHOD_LABEL[q.method] || q.method,
  };
}

/** One qualification by id, presented. */
export async function qualificationById(id) {
  const q = await db.prepare(`${qualificationSelect} WHERE q.id = ?`).get(id);
  return q ? presentQualification(q) : null;
}

/** Where one officer stands at one post: 'trained', 'lapsed', 'revoked' or 'untrained'. */
export async function trainingStateFor(userId, postId) {
  const q = await db.prepare(`SELECT q.*, ${lastWorkedSql} AS last_worked_at FROM post_qualifications q WHERE q.post_id = ? AND q.user_id = ?`).get(postId, userId);
  return trainingState(q, q?.last_worked_at);
}

/** Every officer's state at one post, for ranking who could cover a shift there. */
export async function trainingStatesForPost(postId) {
  const rows = await db.prepare(`SELECT q.*, ${lastWorkedSql} AS last_worked_at FROM post_qualifications q WHERE q.post_id = ?`).all(postId);
  const states = new Map(rows.map((q) => [q.user_id, trainingState(q, q.last_worked_at)]));
  return (userId) => states.get(userId) || 'untrained';
}

/**
 * Upcoming shifts at posts that need site training, worked by an officer who
 * is not trained there (or whose training has lapsed or been withdrawn).
 */
export async function untrainedOnRoster(days = TRAINING_ROSTER_DAYS) {
  const rows = await db
    .prepare(
      `SELECT sh.id AS shift_id, sh.starts_at, sh.ends_at, sh.user_id, sh.post_id,
              p.name AS post_name, s.name AS site_name, u.first_name || ' ' || u.last_name AS officer,
              q.id AS qualification_id, q.status, q.trained_at,
              (SELECT MAX(te.clock_in_at) FROM time_entries te
                WHERE te.post_id = sh.post_id AND te.user_id = sh.user_id AND te.clock_out_at IS NOT NULL) AS last_worked_at
       FROM shifts sh
       JOIN posts p ON p.id = sh.post_id
       JOIN sites s ON s.id = p.site_id
       JOIN users u ON u.id = sh.user_id
       LEFT JOIN post_qualifications q ON q.post_id = sh.post_id AND q.user_id = sh.user_id
       WHERE p.training_required AND sh.status = 'scheduled'
         AND sh.starts_at > now() AND sh.starts_at < ?
       ORDER BY sh.starts_at`
    )
    .all(toSql(new Date(Date.now() + days * DAY)));
  return rows
    .map((r) => ({
      ...isoFields(r, ['starts_at', 'ends_at', 'last_worked_at']),
      state: trainingState(r.qualification_id ? { status: r.status, trained_at: r.trained_at } : null, r.last_worked_at),
    }))
    .filter((r) => r.state !== 'trained')
    .map(({ status: _s, trained_at: _t, qualification_id: _q, ...r }) => r);
}

/**
 * The office's view: every active post that needs site training, who is
 * trained there, who has worked a shift there and is waiting to be signed
 * off, and who is on the roster there without being trained.
 */
export async function trainingBoard() {
  const posts = await db
    .prepare(
      `SELECT p.id, p.name, p.post_code, p.armed, s.id AS site_id, s.name AS site_name
       FROM posts p JOIN sites s ON s.id = p.site_id
       WHERE p.training_required AND p.active AND s.active
       ORDER BY s.name, p.name`
    )
    .all();
  const quals = (await db.prepare(`${qualificationSelect} WHERE p.training_required ORDER BY q.trained_at DESC`).all())
    .map((q) => presentQualification(q));

  // Untrained officers who have worked a shift at the post lately: usually a
  // training shift, done and waiting for a supervisor's sign-off.
  const recent = await db
    .prepare(
      `SELECT te.post_id, te.user_id, u.first_name || ' ' || u.last_name AS officer, u.employee_code,
              COUNT(*) AS shifts, MAX(te.clock_in_at) AS last_worked_at
       FROM time_entries te
       JOIN posts p ON p.id = te.post_id
       JOIN users u ON u.id = te.user_id
       WHERE p.training_required AND te.clock_out_at IS NOT NULL AND te.clock_in_at >= ? AND u.status = 'active'
       GROUP BY te.post_id, te.user_id, u.first_name, u.last_name, u.employee_code`
    )
    .all(toSql(new Date(Date.now() - READY_DAYS * DAY)));
  const stateOf = new Map(quals.map((q) => [`${q.post_id}:${q.user_id}`, q]));
  const ready = recent
    .filter((r) => {
      const q = stateOf.get(`${r.post_id}:${r.user_id}`);
      return !q || q.state === 'untrained';
    })
    .map((r) => ({ ...isoFields(r, ['last_worked_at']), shifts: Number(r.shifts) }));

  const rostered = await untrainedOnRoster();
  const byPost = (list, id) => list.filter((x) => x.post_id === id);
  const shaped = posts.map((p) => {
    const mine = byPost(quals, p.id);
    return {
      ...p,
      armed: Boolean(p.armed),
      trained: mine.filter((q) => q.state === 'trained'),
      lapsed: mine.filter((q) => q.state === 'lapsed'),
      revoked: mine.filter((q) => q.state === 'revoked'),
      ready: byPost(ready, p.id).sort((a, b) => String(b.last_worked_at).localeCompare(String(a.last_worked_at))),
      rostered: byPost(rostered, p.id),
    };
  });
  return {
    posts: shaped,
    rostered,
    counts: {
      posts: shaped.length,
      trained: shaped.reduce((n, p) => n + p.trained.length, 0),
      lapsed: shaped.reduce((n, p) => n + p.lapsed.length, 0),
      ready: shaped.reduce((n, p) => n + p.ready.length, 0),
      rostered: rostered.length,
      thin: shaped.filter((p) => p.trained.length < 2).length,
    },
  };
}

/**
 * The posts an officer is trained at, or has been - and any post needing
 * training they are rostered at without it - for their own profile.
 */
export async function officerTraining(userId) {
  const quals = (await db.prepare(`${qualificationSelect} WHERE q.user_id = ? ORDER BY s.name, p.name`).all(userId))
    .map((q) => presentQualification(q));
  const upcoming = (await untrainedOnRoster()).filter((r) => r.user_id === userId);
  const shown = quals.map(({ revoke_reason, revoked_by_name, revoked_by, signed_off_by, user_id, employee_code, officer, ...q }) =>
    ({ ...q, revoke_reason: q.state === 'revoked' ? revoke_reason : null }));
  return { posts: shown, training_shifts: upcoming };
}

/** Untrained officers rostered in the next TRAINING_ALERT_DAYS, for the alerts inbox. */
export const trainingAlerts = async () =>
  (await untrainedOnRoster(TRAINING_ALERT_DAYS)).map((r) => ({
    ...r,
    hours_away: Math.round((new Date(r.starts_at).getTime() - Date.now()) / 3600000),
  }));
