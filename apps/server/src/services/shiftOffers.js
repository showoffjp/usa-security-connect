/**
 * Shift offers: an open shift sent to several officers at once, each of whom
 * answers yes or no from the app.
 *
 * A supervisor picks who to ask, usually the top of the suggested officers,
 * and how a yes is taken: given straight to the first officer who says yes
 * and can still work it, or put in the request queue as a claim for a
 * supervisor to approve. An offer ends when the shift is taken by any route
 * (this one, a claim, a supervisor assigning it), when it is withdrawn, or
 * when the shift starts with nobody on it. Its state is worked out from the
 * shift as well as the offer, so one whose shift went some other way reads
 * as covered even before anything closed it.
 */

import { db } from '../lib/db.js';
import { isoFields, sqlToIso } from '../lib/http.js';
import { OFFER_STATE_LABEL, OFFER_ALERT_HOURS } from '../shared.js';
import { pushAsync } from './push.js';

const STATE_SQL = `CASE WHEN o.status <> 'open' THEN o.status
  WHEN sh.status = 'cancelled' THEN 'withdrawn'
  WHEN sh.user_id IS NOT NULL THEN 'covered'
  WHEN sh.starts_at <= now() THEN 'expired'
  ELSE 'open' END`;

const OFFER_SELECT = `
  SELECT o.*, ${STATE_SQL} AS state,
         sh.post_id, sh.starts_at, sh.ends_at, sh.user_id AS shift_user_id,
         p.name AS post_name, p.armed, s.name AS site_name, s.city,
         ob.first_name || ' ' || ob.last_name AS offered_by_name,
         fb.first_name || ' ' || fb.last_name AS filled_by_name,
         cu.first_name || ' ' || cu.last_name AS shift_officer
  FROM shift_offers o
  JOIN shifts sh ON sh.id = o.shift_id
  JOIN posts p ON p.id = sh.post_id
  JOIN sites s ON s.id = p.site_id
  LEFT JOIN users ob ON ob.id = o.offered_by
  LEFT JOIN users fb ON fb.id = o.filled_by
  LEFT JOIN users cu ON cu.id = sh.user_id`;

const OFFER_TIMES = ['created_at', 'closed_at', 'starts_at', 'ends_at'];

const present = (o) => ({
  ...isoFields(o, OFFER_TIMES),
  state_label: OFFER_STATE_LABEL[o.state] || o.state,
  // Who has the shift now, whichever way it went.
  taken_by: o.state === 'filled' ? o.filled_by_name : o.state === 'covered' ? o.filled_by_name || o.shift_officer : null,
});

/** When a shift starts, as an officer reads it on a lock screen. */
export const whenText = (startsAt, endsAt) => {
  const a = new Date(sqlToIso(startsAt));
  const b = new Date(sqlToIso(endsAt));
  const day = a.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const t = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${t(a)}-${t(b)}`;
};

async function recipientsOf(offerIds) {
  if (!offerIds.length) return new Map();
  const rows = await db
    .prepare(
      `SELECT r.*, u.first_name || ' ' || u.last_name AS name, u.employee_code
       FROM shift_offer_recipients r JOIN users u ON u.id = r.user_id
       WHERE r.offer_id IN (${offerIds.map(() => '?').join(',')})
       ORDER BY r.answered_at IS NULL, r.answered_at, u.last_name, u.first_name`
    )
    .all(...offerIds);
  const out = new Map(offerIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.offer_id).push(isoFields(r, ['asked_at', 'answered_at']));
  return out;
}

const tally = (recipients) => ({
  asked: recipients.length,
  yes: recipients.filter((r) => r.answer === 'yes').length,
  no: recipients.filter((r) => r.answer === 'no').length,
  waiting: recipients.filter((r) => !r.answer).length,
});

/** Offers with who was asked and what they said, newest first. */
export async function offers(where = 'true', params = []) {
  const rows = await db.prepare(`${OFFER_SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT 100`).all(...params);
  const people = await recipientsOf(rows.map((o) => o.id));
  return rows.map((o) => {
    const recipients = people.get(o.id) || [];
    return { ...present(o), recipients, counts: tally(recipients) };
  });
}

export async function offerDetail(id) {
  return (await offers('o.id = ?', [id]))[0] || null;
}

/** The latest offer on a shift, open or not. */
export async function latestOfferForShift(shiftId) {
  return (await offers('o.shift_id = ?', [shiftId]))[0] || null;
}

/** The open offer on each of these shifts, in brief, by shift. */
export async function openOffersOn(shiftIds) {
  if (!shiftIds.length) return new Map();
  const rows = await offers(`o.status = 'open' AND o.shift_id IN (${shiftIds.map(() => '?').join(',')})`, shiftIds);
  return new Map(rows.filter((o) => o.state === 'open').map((o) => [o.shift_id, { id: o.id, first_yes: o.first_yes, counts: o.counts }]));
}

/**
 * The shift has been taken, or is no longer needed: end any open offer on it
 * and let whoever was waiting on it know. `userId` is who has it now.
 */
export async function closeOffersForShift(shiftId, { userId = null, withdrawn = false } = {}) {
  const open = await db.prepare(`SELECT id FROM shift_offers WHERE shift_id = ? AND status = 'open'`).all(shiftId);
  for (const { id } of open) {
    const saidYes = userId
      ? Boolean(await db.prepare(`SELECT 1 FROM shift_offer_recipients WHERE offer_id = ? AND user_id = ? AND answer = 'yes'`).get(id, userId))
      : false;
    const status = withdrawn ? 'withdrawn' : saidYes ? 'filled' : 'covered';
    await db
      .prepare(`UPDATE shift_offers SET status = ?, filled_by = ?, closed_at = now() WHERE id = ? AND status = 'open'`)
      .run(status, userId, id);
    // Nobody should be left wondering about a shift that has gone.
    const tell = (
      await db.prepare(`SELECT user_id FROM shift_offer_recipients WHERE offer_id = ? AND (answer IS NULL OR answer = 'yes')`).all(id)
    )
      .map((r) => r.user_id)
      .filter((u) => u !== userId);
    if (tell.length) {
      const o = await offerDetail(id);
      pushAsync(tell, {
        title: withdrawn ? 'Shift no longer needed' : 'Shift covered',
        body: `${o.post_name}, ${whenText(o.starts_at, o.ends_at)}: ${withdrawn ? 'the offer was withdrawn' : 'it has been covered'}. Thanks.`,
        data: { type: 'shift_offer', id },
      });
    }
  }
  return open.length;
}

/**
 * Offers sent to one officer: every one still open, and those of the last
 * day they said yes to, so they see how it went.
 */
export async function offersFor(userId) {
  const rows = await offers(
    `EXISTS (SELECT 1 FROM shift_offer_recipients mr WHERE mr.offer_id = o.id AND mr.user_id = ?)
     AND (${STATE_SQL} = 'open'
          OR (o.closed_at > now() - interval '1 day'
              AND EXISTS (SELECT 1 FROM shift_offer_recipients my WHERE my.offer_id = o.id AND my.user_id = ? AND my.answer = 'yes')))`,
    [userId, userId]
  );
  return rows.map(({ recipients, counts, ...o }) => {
    const me = recipients.find((r) => r.user_id === userId);
    return {
      ...o,
      answer: me?.answer || null,
      answered_at: me?.answered_at || null,
      // An officer sees how many were asked, never who.
      asked: counts.asked,
      mine: o.state === 'filled' && o.filled_by === userId,
    };
  });
}

/**
 * For the alerts inbox: offers taken in the last day, and open ones where
 * everybody asked has said no, or nobody has said yes this close to the start.
 */
export async function offerAlerts() {
  const recent = await offers(`o.status = 'filled' AND o.closed_at > now() - interval '1 day'`);
  const open = (await offers(`${STATE_SQL} = 'open'`)).filter(
    (o) =>
      o.counts.yes === 0 &&
      (o.counts.waiting === 0 || new Date(o.starts_at) - Date.now() <= OFFER_ALERT_HOURS * 3600000)
  );
  return { filled: recent, stuck: open };
}
