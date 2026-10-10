import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, idParam, sqlToIso } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { ROLES, blocksAssignment, OFFER_MAX_RECIPIENTS } from '../shared.js';
import { checkEligibility } from './shiftRequests.js';
import { pushAsync, supervisorIds } from '../services/push.js';
import { confirmShift } from '../services/confirmations.js';
import { offers, offerDetail, latestOfferForShift, offersFor, closeOffersForShift, whenText } from '../services/shiftOffers.js';

/**
 * Shift offers (see services/shiftOffers.js). A supervisor sends an open
 * shift to the officers they pick; each answers from the app. The first
 * eligible yes is given the shift, or, if the supervisor would rather
 * choose, becomes a claim in the request queue.
 */
export const shiftOffersRouter = Router();
shiftOffersRouter.use(requireAuth);

const HOUR = 3600000;
const firstBlock = (reasons) => reasons.find((r) => !r.advisory);

/* ------------------------------------------------------------ officers --- */

/** Offers sent to me: open ones, and yeses of the last day with how they went. */
shiftOffersRouter.get(
  '/mine',
  wrap(async (req, res) => {
    const mine = await offersFor(req.user.id);
    const out = [];
    for (const o of mine) {
      let refusal = null;
      if (o.state === 'open' && o.answer !== 'yes') {
        // Something may have changed since they were asked: another shift, leave.
        const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(o.shift_id);
        const block = firstBlock(await checkEligibility(req.user.id, shift));
        if (block) refusal = block.officerMessage || block.message;
      }
      out.push({ ...o, can_say_yes: o.state === 'open' && o.answer !== 'yes' && !refusal, refusal });
    }
    res.json({ offers: out });
  })
);

const answerSchema = z.object({ answer: z.enum(['yes', 'no']) });

const closedMessage = (o) =>
  ({
    filled: 'Somebody else has taken this shift.',
    covered: 'This shift has been covered.',
    withdrawn: 'This offer was withdrawn.',
    expired: 'This shift has already started.',
  })[o.state] || 'This offer has closed.';

/**
 * Yes or no. A yes is checked against the same rule as every assignment; on
 * an offer the first yes takes, it is given the shift there and then (and
 * that counts as confirming it), otherwise it goes to the supervisors as a
 * claim. A no can be changed to a yes while the offer is open.
 */
shiftOffersRouter.post(
  '/:id/answer',
  wrap(async (req, res) => {
    const id = idParam(req.params.id, 'offer');
    const { answer } = parse(answerSchema, req.body);
    const me = await db.prepare(`SELECT * FROM shift_offer_recipients WHERE offer_id = ? AND user_id = ?`).get(id, req.user.id);
    if (!me) throw new HttpError(404, 'Offer not found.');
    const offer = await offerDetail(id);
    if (offer.state !== 'open') throw new HttpError(409, closedMessage(offer));
    if (me.answer === 'yes') throw new HttpError(409, 'You have already said yes to this shift.');
    const name = `${req.user.first_name} ${req.user.last_name}`;
    const when = whenText(offer.starts_at, offer.ends_at);

    if (answer === 'no') {
      await db
        .prepare(`UPDATE shift_offer_recipients SET answer = 'no', answered_at = now() WHERE offer_id = ? AND user_id = ?`)
        .run(id, req.user.id);
      await audit(req.user.id, 'shift.offer_declined', 'shift', offer.shift_id, { offer: id }, req.ip);
      return res.json({ result: 'declined', offer: (await offersFor(req.user.id)).find((o) => o.id === id) || null });
    }

    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(offer.shift_id);
    const block = firstBlock(await checkEligibility(req.user.id, shift));
    if (block) throw new HttpError(409, `You cannot take this shift: ${block.officerMessage || block.message}`);

    if (!offer.first_yes) {
      // The supervisor chooses: the yes is a claim in their queue.
      let request = await db
        .prepare(`SELECT id FROM shift_requests WHERE shift_id = ? AND requested_by = ? AND kind = 'claim' AND status IN ('pending','accepted')`)
        .get(shift.id, req.user.id);
      await db.transaction(async () => {
        if (!request) {
          const info = await db
            .prepare(`INSERT INTO shift_requests (kind, shift_id, requested_by, note) VALUES ('claim', ?, ?, 'Said yes to a shift offer.')`)
            .run(shift.id, req.user.id);
          request = { id: Number(info.lastInsertRowid) };
        }
        await db
          .prepare(`UPDATE shift_offer_recipients SET answer = 'yes', answered_at = now() WHERE offer_id = ? AND user_id = ?`)
          .run(id, req.user.id);
      })();
      await audit(req.user.id, 'shift.offer_accepted', 'shift', shift.id, { offer: id, request: request.id }, req.ip);
      pushAsync(await supervisorIds(), {
        title: 'Yes to a shift offer',
        body: `${name} can cover ${offer.post_name}, ${when}. Approve it in Shift requests.`,
        data: { type: 'shift_request', id: request.id },
      });
      return res.json({ result: 'claimed', offer: (await offersFor(req.user.id)).find((o) => o.id === id) || null });
    }

    // First yes takes it: only one officer can win the update.
    let taken = false;
    await db.transaction(async () => {
      const r = await db
        .prepare(
          `UPDATE shifts SET user_id = ?, is_open = false, confirmed_key = NULL, reminded_key = NULL
           WHERE id = ? AND user_id IS NULL AND status = 'scheduled' AND starts_at > now()`
        )
        .run(req.user.id, shift.id);
      if (!r.changes) return;
      taken = true;
      await db
        .prepare(`UPDATE shift_offer_recipients SET answer = 'yes', answered_at = now() WHERE offer_id = ? AND user_id = ?`)
        .run(id, req.user.id);
      // Anyone else who asked for the shift has lost it; their own claim is settled.
      await db
        .prepare(
          `UPDATE shift_requests SET status = CASE WHEN requested_by = ? THEN 'approved' ELSE 'denied' END, decided_at = now(),
                  decision_note = CASE WHEN requested_by = ? THEN 'Taken from a shift offer.' ELSE 'The shift went to another officer.' END
           WHERE shift_id = ? AND kind = 'claim' AND status = 'pending'`
        )
        .run(req.user.id, req.user.id, shift.id);
    })();
    if (!taken) throw new HttpError(409, 'Somebody else has just taken this shift.');

    await closeOffersForShift(shift.id, { userId: req.user.id });
    await confirmShift(await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shift.id), {
      byUserId: req.user.id, method: 'app', note: 'Said yes to a shift offer.',
    });
    await audit(req.user.id, 'shift.offer_taken', 'shift', shift.id, { offer: id }, req.ip);
    pushAsync(await supervisorIds(), {
      title: 'Shift offer taken',
      body: `${name} is taking ${offer.post_name}, ${offer.site_name}: ${when}.`,
      data: { type: 'shift_offer', id },
    });
    res.json({ result: 'assigned', offer: (await offersFor(req.user.id)).find((o) => o.id === id) || null });
  })
);

/* --------------------------------------------------------- supervisors --- */

const supervisor = requireRole(ROLES.SUPERVISOR);

/** Offers still open, and those of the last two days, with every answer. */
shiftOffersRouter.get(
  '/',
  supervisor,
  wrap(async (req, res) => {
    const all = await offers(`o.status = 'open' OR o.created_at > now() - interval '2 days'`);
    res.json({ offers: all, open: all.filter((o) => o.state === 'open').length });
  })
);

/** The latest offer on one shift, for the shift dialog. */
shiftOffersRouter.get(
  '/shift/:shiftId',
  supervisor,
  wrap(async (req, res) => {
    res.json({ offer: await latestOfferForShift(idParam(req.params.shiftId, 'shift')) });
  })
);

const sendSchema = z.object({
  shiftId: z.number().int().positive(),
  userIds: z.array(z.number().int().positive()).min(1, 'Choose who to ask.').max(OFFER_MAX_RECIPIENTS, `Ask at most ${OFFER_MAX_RECIPIENTS} officers at once.`),
  firstYes: z.boolean().default(true),
  note: z.string().trim().max(300).optional(),
});

/**
 * Ask officers to cover an open shift. Anyone the rules block is refused
 * before anybody is asked; warnings (short of rest, not trained here, over
 * the attendance limit) come back with the offer, since the supervisor chose
 * them knowing. Asking again on a shift with an open offer adds to it.
 */
shiftOffersRouter.post(
  '/',
  supervisor,
  wrap(async (req, res) => {
    const body = parse(sendSchema, req.body);
    const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(body.shiftId);
    if (!shift) throw new HttpError(404, 'Shift not found.');
    if (shift.status !== 'scheduled') throw new HttpError(409, 'That shift is cancelled.');
    if (shift.user_id) throw new HttpError(409, 'That shift already has an officer.');
    const startsAt = new Date(sqlToIso(shift.starts_at));
    if (startsAt <= new Date()) throw new HttpError(409, 'That shift has already started.');

    const ids = [...new Set(body.userIds)];
    const people = await db
      .prepare(`SELECT id, first_name, last_name, role, status FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
    if (people.length !== ids.length || people.some((p) => p.status !== 'active' || !['officer', 'supervisor'].includes(p.role))) {
      throw new HttpError(422, 'Only active officers can be offered a shift.');
    }
    const blocked = [];
    const warnings = [];
    for (const p of people) {
      const reasons = await checkEligibility(p.id, shift);
      const name = `${p.first_name} ${p.last_name}`;
      if (blocksAssignment(reasons)) blocked.push({ user_id: p.id, name, message: firstBlock(reasons).message });
      else for (const r of reasons) warnings.push({ user_id: p.id, name, code: r.code, message: r.message });
    }
    if (blocked.length) {
      throw new HttpError(409, `Not offered: ${blocked.map((b) => `${b.name} - ${b.message}`).join(' ')}`, { code: 'ineligible', blocked });
    }

    let offer = await db.prepare(`SELECT * FROM shift_offers WHERE shift_id = ? AND status = 'open'`).get(shift.id);
    const asked = [];
    await db.transaction(async () => {
      if (!offer) {
        offer = await db
          .prepare(`INSERT INTO shift_offers (shift_id, offered_by, first_yes, note) VALUES (?,?,?,?) RETURNING *`)
          .get(shift.id, req.user.id, body.firstYes, body.note || null);
      } else if (body.note) {
        await db.prepare(`UPDATE shift_offers SET note = ? WHERE id = ?`).run(body.note, offer.id);
      }
      for (const uid of ids) {
        const r = await db
          .prepare(`INSERT INTO shift_offer_recipients (offer_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`)
          .run(offer.id, uid);
        if (r.changes) asked.push(uid);
      }
    })();
    if (!asked.length) throw new HttpError(409, 'Everyone chosen has been asked already.');

    const detail = await offerDetail(offer.id);
    const note = body.note || offer.note;
    pushAsync(asked, {
      title: 'Can you cover a shift?',
      body: `${detail.post_name}, ${detail.site_name}: ${whenText(shift.starts_at, shift.ends_at)}.${note ? ` ${note}` : ''} Open the app to say yes or no.`,
      data: { type: 'shift_offer', id: offer.id },
      priority: startsAt - Date.now() <= 12 * HOUR ? 'high' : 'default',
    });
    await audit(req.user.id, 'shift.offer_sent', 'shift', shift.id, { offer: offer.id, asked, first_yes: detail.first_yes }, req.ip);
    res.status(201).json({ offer: detail, asked: asked.length, warnings });
  })
);

/** Call it off: anyone still waiting is told the shift is no longer needed. */
shiftOffersRouter.post(
  '/:id/withdraw',
  supervisor,
  wrap(async (req, res) => {
    const offer = await offerDetail(idParam(req.params.id, 'offer'));
    if (!offer) throw new HttpError(404, 'Offer not found.');
    if (offer.state !== 'open') throw new HttpError(409, 'That offer has already closed.');
    await closeOffersForShift(offer.shift_id, { withdrawn: true });
    await audit(req.user.id, 'shift.offer_withdrawn', 'shift', offer.shift_id, { offer: offer.id }, req.ip);
    res.json({ offer: await offerDetail(offer.id) });
  })
);
