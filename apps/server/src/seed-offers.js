/**
 * Demo shift offers:
 *
 *  - the shift called off sick this evening went out half an hour ago to
 *    four officers who could take it without a warning, the first yes to
 *    take it; one has said no, the rest have not answered yet;
 *  - Marcus Bell has been asked about an open shift in the next few days,
 *    with the supervisor choosing from whoever says yes, so the officer app
 *    has an offer to answer;
 *  - a few hours ago an offer for a shift later today was taken by the
 *    second officer to answer, twelve minutes after it went out.
 *
 * Only officers outside the scripted suites are asked, and nobody's roster
 * moves: the taken offer is told against a shift its officer already holds.
 */

import { toSql } from './services/compliance.js';
import { checkEligibility } from './routes/shiftRequests.js';
import { sqlToIso } from './lib/http.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const SUITE_PEOPLE = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008'];

export async function seedOffers({ db, now = new Date() }) {
  const result = { offers: 0, asked: 0, marcus: false, taken: null };
  const supervisor = await db.prepare(`SELECT id FROM users WHERE employee_code = '1002'`).get();
  const marcus = await db.prepare(`SELECT id FROM users WHERE employee_code = '1003'`).get();
  const at = (ms) => toSql(new Date(now.getTime() + ms));

  // Officers outside the suites, off duty now, in the order a scheduler might
  // try them; `want` of them who can take the shift without a single warning.
  const others = await db
    .prepare(
      `SELECT u.id FROM users u
       WHERE u.status = 'active' AND u.role = 'officer'
         AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.user_id = u.id AND te.clock_out_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM attendance_notices a WHERE a.user_id = u.id AND a.created_at > now() - interval '1 day')
       ORDER BY u.employee_code`
    )
    .all(...SUITE_PEOPLE);
  const pick = async (shift, want, skip = []) => {
    const out = [];
    for (const { id } of others) {
      if (out.length >= want) break;
      if (skip.includes(id) || id === shift.user_id) continue;
      if (!(await checkEligibility(id, shift)).length) out.push(id);
    }
    return out;
  };
  const offer = async ({ shift, firstYes, note, createdAt, status = 'open', filledBy = null, closedAt = null, people }) => {
    const row = await db
      .prepare(
        `INSERT INTO shift_offers (shift_id, offered_by, first_yes, note, status, filled_by, closed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`
      )
      .get(shift.id, supervisor?.id ?? null, firstYes, note, status, filledBy, closedAt, createdAt);
    for (const p of people) {
      await db
        .prepare(`INSERT INTO shift_offer_recipients (offer_id, user_id, asked_at, answer, answered_at) VALUES (?,?,?,?,?)`)
        .run(row.id, p.id, createdAt, p.answer ?? null, p.answeredAt ?? null);
    }
    result.offers += 1;
    result.asked += people.length;
    return row.id;
  };

  /* ----------------------------------------- this evening's called-off shift */
  const calledOff = await db
    .prepare(
      `SELECT sh.* FROM shifts sh JOIN attendance_notices n ON n.shift_id = sh.id AND n.kind = 'call_off'
       WHERE sh.user_id IS NULL AND sh.status = 'scheduled' AND sh.starts_at > ?
       ORDER BY sh.starts_at LIMIT 1`
    )
    .get(at(HOUR));
  if (calledOff) {
    const ids = await pick(calledOff, 4);
    if (ids.length >= 2) {
      await offer({
        shift: calledOff, firstYes: true, note: 'Called off sick. Overtime is approved for this one.', createdAt: at(-30 * MIN),
        people: ids.map((id, i) => (i === 1 ? { id, answer: 'no', answeredAt: at(-21 * MIN) } : { id })),
      });
    }
  }

  /* ------------------------------------------- an open shift asked of Marcus */
  if (marcus) {
    const open = await db
      .prepare(
        `SELECT sh.* FROM shifts sh JOIN posts p ON p.id = sh.post_id
         WHERE sh.user_id IS NULL AND sh.status = 'scheduled' AND p.armed = false AND p.training_required = false
           AND sh.starts_at BETWEEN ? AND ? AND sh.id <> ?
           AND NOT EXISTS (SELECT 1 FROM shift_offers o WHERE o.shift_id = sh.id)
         ORDER BY sh.starts_at, sh.id LIMIT 40`
      )
      .all(at(20 * HOUR), at(6 * 24 * HOUR), calledOff?.id ?? 0);
    for (const sh of open) {
      if ((await checkEligibility(marcus.id, sh)).length) continue;
      const ids = await pick(sh, 2);
      await offer({
        shift: sh, firstYes: false, note: 'Short-staffed this week. Thank you!', createdAt: at(-2 * HOUR),
        people: [{ id: marcus.id }, ...ids.map((id, i) => (i === 0 ? { id, answer: 'no', answeredAt: at(-95 * MIN) } : { id }))],
      });
      result.marcus = true;
      break;
    }
  }

  /* ------------------------------------- one taken a few hours ago, by offer */
  // A shift later today its officer already holds and has confirmed, at a
  // plain post, with nothing else said about it: they were the yes.
  const held = await db
    .prepare(
      `SELECT sh.*, u.first_name || ' ' || u.last_name AS name FROM shifts sh
       JOIN users u ON u.id = sh.user_id JOIN posts p ON p.id = sh.post_id
       WHERE sh.status = 'scheduled' AND sh.confirmed_key IS NOT NULL AND p.armed = false AND p.training_required = false
         AND sh.starts_at BETWEEN ? AND ?
         AND u.role = 'officer' AND u.employee_code NOT IN (${SUITE_PEOPLE.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM attendance_notices a WHERE a.shift_id = sh.id)
         AND NOT EXISTS (SELECT 1 FROM attendance_events a WHERE a.shift_id = sh.id)
         AND NOT EXISTS (SELECT 1 FROM shift_requests r WHERE r.shift_id = sh.id)
       ORDER BY sh.starts_at, sh.id LIMIT 1`
    )
    .get(at(3 * HOUR), at(20 * HOUR), ...SUITE_PEOPLE);
  if (held) {
    const sent = new Date(Math.min(now.getTime() - 3 * HOUR, new Date(sqlToIso(held.starts_at)).getTime() - 4 * HOUR));
    const ids = await pick({ ...held, user_id: null }, 3, [held.user_id]);
    if (ids.length >= 2) {
      const t = (m) => toSql(new Date(sent.getTime() + m * MIN));
      await offer({
        shift: held, firstYes: true, note: null, createdAt: toSql(sent), status: 'filled', filledBy: held.user_id, closedAt: t(12),
        people: [
          { id: ids[0], answer: 'no', answeredAt: t(5) },
          { id: held.user_id, answer: 'yes', answeredAt: t(12) },
          ...ids.slice(1).map((id) => ({ id })),
        ],
      });
      result.taken = held.name;
    }
  }
  return result;
}
