/**
 * Company-wide settings, one row per key in company_settings. A key nobody
 * has set reads as its default here, so a new install behaves sensibly.
 */

import { db } from '../lib/db.js';
import { RULES } from '../shared.js';

const DEFAULTS = {
  /** Minutes between status check-ins at a post that does not set its own; 0 is off. */
  'checkIns.everyMin': RULES.defaultCheckInIntervalMinutes,
};

export async function getSetting(key) {
  const row = await db.prepare(`SELECT value FROM company_settings WHERE key = ?`).get(key);
  const v = row ? row.value : DEFAULTS[key];
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
}

export async function setSetting(key, value, userId = null) {
  await db
    .prepare(
      `INSERT INTO company_settings (key, value, updated_by, updated_at) VALUES (?, ?::jsonb, ?, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`
    )
    .run(key, JSON.stringify(value), userId);
}

/** The company's check-in interval, in minutes. */
export const defaultCheckInMinutes = async () => Number(await getSetting('checkIns.everyMin')) || 0;

/** A post's own interval, or the company's when it follows the default. */
export async function checkInMinutesFor(post) {
  if (post?.check_in_interval_min != null) return Number(post.check_in_interval_min);
  return defaultCheckInMinutes();
}
