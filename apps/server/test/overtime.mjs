/**
 * Overtime watch: who is heading past 40 hours in a payroll week.
 *
 * Only W-2 officers paid by the hour earn overtime, so only they are watched.
 * A week's projection is what has been worked plus what is still rostered;
 * the shift that first carries someone over the line is named, with the
 * hours and the premium it costs. A scheduler can still prevent it while
 * that shift has not started, and those are the ones the alerts inbox and
 * the sidebar count raise.
 *
 * The suite builds its own week: a new officer and a new contractor, each
 * rostered 45 hours next week.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const supervisor = await signIn('1002', '3571');
const officer = await signIn('1003', '4812');
log(Boolean(admin && supervisor && officer), 'signed in as administrator, supervisor and an officer');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nextMonday = new Date();
nextMonday.setHours(0, 0, 0, 0);
nextMonday.setDate(nextMonday.getDate() - ((nextMonday.getDay() + 6) % 7) + 7);
const at = (dayOffset, hour) => {
  const d = new Date(nextMonday);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

/* ============================================================ the board === */
section('the board');

const thisWeek = await call('/admin/overtime', { token: supervisor });
log(thisWeek.status === 200 && thisWeek.data.threshold_hours === 40 && Array.isArray(thisWeek.data.officers), 'supervisors read the overtime watch');
log((await call('/admin/overtime', { token: officer })).status === 403, 'officers do not');
log((await call('/admin/overtime?week=not-a-date', { token: supervisor })).status === 422, 'a nonsense week is refused');
log(thisWeek.data.officers.every((o) => o.projected_hours >= 36 && Math.abs(o.worked_hours + o.scheduled_hours - o.projected_hours) < 0.05),
  'everyone listed is within four hours of the line, and worked plus rostered makes the projection');

/* ======================================================= a week of its own === */
section('a week built to go over');

const sites = (await call('/admin/sites', { token: admin })).data;
const post = sites.posts.find((p) => !p.armed && p.active !== 0 && p.active !== false);
const stamp = String(Date.now()).slice(-5);
async function hire(employmentType, extra = {}) {
  const r = await call('/admin/employees', {
    token: admin,
    method: 'POST',
    body: {
      firstName: employmentType === 'w2' ? 'Owen' : 'Lena',
      lastName: `Suite${stamp}${employmentType === 'w2' ? 'W' : 'C'}`,
      role: 'officer',
      employmentType,
      payType: 'hourly',
      payRate: 20,
      ...extra,
    },
  });
  return r.data?.employee?.id ?? r.data?.user?.id ?? r.data?.id;
}
const w2 = await hire('w2');
const contractor = await hire('1099', { businessName: 'Suite Security LLC', taxIdLast4: '1234', w9OnFile: true });
log(Boolean(w2 && contractor), 'a new W-2 officer and a 1099 contractor, both $20 an hour');

async function roster(userId, days) {
  for (const [day, from, to] of days) {
    const r = await call('/admin/shifts', {
      token: admin,
      method: 'POST',
      body: { userId, postId: post.id, startsAt: at(day, from), endsAt: at(day, to), override: true, overrideReason: 'Suite: overtime scenario.' },
    });
    if (r.status !== 201) return r;
  }
  return { status: 201 };
}
// Monday to Friday, nine hours a day: 45 hours, 5 of them overtime, tipped over on Friday.
const week = [[0, 7, 16], [1, 7, 16], [2, 7, 16], [3, 7, 16], [4, 7, 16]];
const r1 = await roster(w2, week);
const r2 = await roster(contractor, week);
log(r1.status === 201 && r2.status === 201, 'each is rostered 45 hours next week', r1.data?.error || r2.data?.error);

const next = (await call(`/admin/overtime?week=${ymd(nextMonday)}`, { token: supervisor })).data;
const mine = next.officers.find((o) => o.user_id === w2);
log(next.week_start === ymd(nextMonday), 'the board reads the week asked for', next.week_start);
log(mine && mine.projected_hours === 45 && mine.worked_hours === 0 && mine.scheduled_hours === 45 && mine.status === 'over',
  'the officer is projected at 45 hours', mine && `${mine.projected_hours}h`);
log(mine && mine.overtime_hours === 5 && mine.premium === 50, 'five hours over, $50 of premium at time and a half', mine && `$${mine.premium}`);
const tip = mine?.tipping_shift;
log(tip && new Date(tip.starts_at).getTime() === new Date(at(4, 7)).getTime() && tip.overtime_hours === 5 && !tip.already_over,
  'Friday\'s shift is the one that tips it, with all five hours on it');
log(!next.officers.some((o) => o.user_id === contractor), 'the contractor, who does not earn overtime, is not on it');
log(next.totals.avoidable >= 1 && next.totals.over >= 1, 'and it counts as overtime still avoidable');

// A Saturday on top: still Friday that tips it, now with a shift after it already over.
await roster(w2, [[5, 8, 16]]);
const more = (await call(`/admin/overtime?week=${ymd(nextMonday)}`, { token: supervisor })).data.officers.find((o) => o.user_id === w2);
log(more.projected_hours === 53 && more.overtime_hours === 13 && more.tipping_shift.shift_id === tip.shift_id,
  'another shift adds to the overtime, but the shift that tips it is still Friday\'s', `${more.overtime_hours}h`);

/* ================================================================ alerts === */
section('alerts');

const now = (await call('/admin/overtime', { token: supervisor })).data;
const counts = (await call('/admin/dashboard', { token: supervisor })).data.counts;
log(counts.overtimeRisk === now.totals.avoidable, 'the sidebar counts this week\'s avoidable overtime', `${counts.overtimeRisk}`);
const alerts = (await call('/admin/alerts', { token: supervisor })).data.alerts.filter((a) => a.kind === 'overtime');
log(alerts.length === now.totals.avoidable, 'and each one is in the alerts inbox', `${alerts.length}`);
log(!alerts.some((a) => a.key.startsWith(`overtime:${w2}:`)), 'next week\'s is not raised yet');

finish('Overtime watch suite');
