/**
 * The company works in Florida, so "today", payroll weeks and the demo's
 * shift times are Eastern time rather than the server's UTC.
 * Imported first by index.mjs so it applies before anything reads a date.
 */
process.env.TZ = process.env.USC_TIMEZONE || 'America/New_York';
