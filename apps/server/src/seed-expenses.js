/**
 * Demo expense claims:
 *
 *   - Marcus Bell (1003): parking today, waiting; 24 miles between sites last
 *     week, approved and due with the payroll waiting to close; and mileage
 *     paid with the closed week before last.
 *   - Dwayne Foster (1005): supplies with a receipt, waiting.
 *   - Alicia Nunez (1006): a meal, declined with the reason.
 *   - Alexis (1042): tolls this week, approved.
 *   - Isaiah Coleman (1023): mileage between campus buildings, waiting.
 *
 * Nothing waiting is dated inside a period that has ended, so closing last
 * week's payroll is never held up by the demo.
 */

import * as storage from './services/storage.js';
import { toDateString } from './lib/http.js';
import { MILEAGE_RATE_CENTS } from './shared.js';

/** A receipt drawn as an SVG, so the demo has something to look at. */
function receiptSvg(lines, total) {
  const rows = lines.map(([item, price], i) =>
    `<text x="20" y="${110 + i * 26}">${item}</text><text x="280" y="${110 + i * 26}" text-anchor="end">${price}</text>`).join('');
  const y = 110 + lines.length * 26 + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${y + 70}" font-family="monospace" font-size="15">
<rect width="100%" height="100%" fill="#fdfdf8"/>
<text x="150" y="40" text-anchor="middle" font-weight="bold" font-size="18">OFFICE DEPOT #2214</text>
<text x="150" y="64" text-anchor="middle">Jacksonville FL</text>
<line x1="20" y1="82" x2="280" y2="82" stroke="#999" stroke-dasharray="4"/>${rows}
<line x1="20" y1="${y - 8}" x2="280" y2="${y - 8}" stroke="#999" stroke-dasharray="4"/>
<text x="20" y="${y + 16}" font-weight="bold">TOTAL</text><text x="280" y="${y + 16}" text-anchor="end" font-weight="bold">${total}</text>
<text x="150" y="${y + 50}" text-anchor="middle" font-size="12">VISA ****4417  THANK YOU</text>
</svg>`;
}

export async function seedExpenses({ db }) {
  const user = async (code) => db.prepare(`SELECT id FROM users WHERE employee_code = ?`).get(code);
  const site = async (name) => db.prepare(`SELECT id FROM sites WHERE name = ?`).get(name);
  const admin = await db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  const periods = await db.prepare(`SELECT * FROM pay_periods ORDER BY period_start`).all();
  const closed = periods.find((p) => p.status === 'closed');
  const waiting = periods.find((p) => p.status === 'open');
  const day = (d) => (d instanceof Date ? toDateString(d) : String(d).slice(0, 10));
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return toDateString(d);
  };
  const hoursAgo = (n) => new Date(Date.now() - n * 3600000);
  const midOf = (p) => {
    const d = new Date(day(p.period_start) + 'T12:00:00');
    d.setDate(d.getDate() + 3);
    return toDateString(d);
  };

  const add = async (c) => {
    const u = await user(c.code);
    if (!u) return 0;
    let receipt = null;
    if (c.receipt) {
      receipt = await storage.put({ buffer: Buffer.from(c.receipt), filename: storage.generateFilename('receipt.svg'), mimeType: 'image/svg+xml' });
    }
    await db
      .prepare(
        `INSERT INTO expense_claims (user_id, site_id, category, incurred_on, miles, amount_cents, description,
           receipt_filename, receipt_url, receipt_type, status, decided_by, decided_at, decision_note, pay_period_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        u.id, c.site ? (await site(c.site))?.id ?? null : null, c.category, c.on, c.miles ?? null,
        c.miles ? Math.round(c.miles * MILEAGE_RATE_CENTS) : c.cents, c.description,
        receipt?.filename ?? null, receipt?.storageUrl ?? null, receipt ? 'image/svg+xml' : null,
        c.status, c.status === 'pending' ? null : admin?.id ?? null, c.status === 'pending' ? null : c.decidedAt,
        c.note ?? null, c.period ?? null, c.created
      );
    return 1;
  };

  let n = 0;
  n += await add({ code: '1003', category: 'parking', on: daysAgo(0), cents: 1800, site: 'Riverfront Commerce Center',
    description: 'Visitor garage while the staff lot was closed for resurfacing.', status: 'pending', created: hoursAgo(3) });
  if (waiting) {
    n += await add({ code: '1003', category: 'mileage', on: midOf(waiting), miles: 24, site: 'Capital Plaza Office Tower',
      description: 'Covered the Capital Plaza desk mid-shift: Riverfront to Capital Plaza and back.', status: 'approved',
      decidedAt: hoursAgo(30), note: null, created: hoursAgo(70) });
  }
  if (closed) {
    n += await add({ code: '1003', category: 'mileage', on: midOf(closed), miles: 31,
      description: 'Relief run to Harborview when their officer went home sick.', status: 'paid', period: closed.id,
      decidedAt: hoursAgo(24 * 9), created: hoursAgo(24 * 11) });
  }
  n += await add({ code: '1005', category: 'supplies', on: daysAgo(0), cents: 4225, site: 'Gulfport Logistics Yard',
    description: 'Replacement flashlight and batteries for the yard patrol; the issued one failed.', status: 'pending',
    receipt: receiptSvg([['Tactical flashlight', '$29.99'], ['AA batteries x12', '$9.49'], ['Sales tax', '$2.77']], '$42.25'),
    created: hoursAgo(20) });
  n += await add({ code: '1006', category: 'meals', on: daysAgo(4), cents: 3500,
    description: 'Dinner on the double shift at Seaside.', status: 'declined', decidedAt: hoursAgo(50),
    note: 'Meals are covered on shifts over 12 hours; this one was 10. Ask your supervisor before a long one.', created: hoursAgo(80) });
  n += await add({ code: '1042', category: 'tolls', on: daysAgo(0), cents: 650,
    description: 'Toll road to the Pensacola site for the relief shift.', status: 'approved', decidedAt: hoursAgo(1), created: hoursAgo(5) });
  n += await add({ code: '1023', category: 'mileage', on: daysAgo(0), miles: 38, site: 'Sunshine State University Research Park',
    description: 'Mobile patrol in my own car while the campus patrol car was in the shop.', status: 'pending', created: hoursAgo(2) });
  return { claims: n };
}
