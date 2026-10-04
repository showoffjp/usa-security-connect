/** Minimal test harness shared by the API suites. */

export const BASE = process.env.USC_TEST_BASE || 'http://localhost:4000/api';

let failures = 0;

export function log(ok, label, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
}

export const section = (title) => console.log(`\n--- ${title} ---`);

export async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON responses (CSV exports) are read by the caller */
  }
  return { status: res.status, data };
}

export async function signIn(employeeCode, pin) {
  const res = await call('/auth/login', { method: 'POST', body: { employeeCode, pin } });
  return res.data?.token;
}

export function finish(suite) {
  console.log(`\n${failures === 0 ? `${suite}: all checks passed.` : `${suite}: ${failures} CHECK(S) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/** A calendar day as the app reads it - local, not UTC - some days from today. */
export function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
