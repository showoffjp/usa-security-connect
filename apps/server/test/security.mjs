/**
 * Set-password links and the shared rate limiter.
 *
 * Both exist to stop something, so the suite is almost entirely about what is
 * refused: a spent link, a stale link, a guessed token, and a caller who keeps
 * trying.
 */

import { call, log, section, signIn, finish } from './harness.mjs';

const admin = await signIn('1001', '2468');
const sites = (await call('/admin/sites', { token: admin })).data.sites;
const coral = sites.find((s) => s.name.includes('Coral'));

const tokenFrom = (link) => new URL(link, 'http://localhost').searchParams.get('token');

const newContact = async (email, name = 'Link Tester') =>
  call('/admin/clients', {
    token: admin,
    method: 'POST',
    body: { email, name, company: 'Test Co', siteIds: [coral.id] },
  });

/* ============================================================== issuing === */
section('issuing a link');

const created = await newContact('link.one@example.com');
log(created.status === 201, 'a contact is created');
log(/\/portal\/set-password\?token=/.test(created.data.link), 'the response carries a set-password link');
log(
  tokenFrom(created.data.link).length >= 40,
  'the token is long enough not to be guessed',
  `${tokenFrom(created.data.link).length} chars`
);
log(new Date(created.data.expiresAt) > new Date(), 'and it has a future expiry');

// A contact created this way has no password at all until they choose one.
const noPassword = await call('/client/login', {
  method: 'POST',
  body: { email: 'link.one@example.com', password: 'anything-at-all' },
});
log(noPassword.status === 401, 'there is no password to guess before they set one');

/* ========================================================== inspecting === */
section('checking a link before using it');

const peek = await call(`/client/set-password/${tokenFrom(created.data.link)}`);
log(peek.status === 200 && peek.data.valid === true, 'a fresh link reports itself valid');
log(peek.data.name === 'Link Tester', 'and says who it is for');

const unknown = await call('/client/set-password/not-a-real-token-at-all-0000000000');
log(unknown.status === 404, 'an unknown token is not found');

/* ============================================================== using === */
section('using a link');

const short = await call('/client/set-password', {
  method: 'POST',
  body: { token: tokenFrom(created.data.link), password: 'short', confirmPassword: 'short' },
});
log(short.status === 422, 'a short password is refused');

const mismatch = await call('/client/set-password', {
  method: 'POST',
  body: {
    token: tokenFrom(created.data.link),
    password: 'a-perfectly-fine-password',
    confirmPassword: 'a-different-password',
  },
});
log(mismatch.status === 422, 'a mismatched confirmation is refused');

// Neither failure should have spent the link.
const stillValid = await call(`/client/set-password/${tokenFrom(created.data.link)}`);
log(stillValid.data.valid === true, 'a rejected attempt does not burn the link');

const PASSWORD = 'a-perfectly-fine-password';
const used = await call('/client/set-password', {
  method: 'POST',
  body: { token: tokenFrom(created.data.link), password: PASSWORD, confirmPassword: PASSWORD },
});
log(used.status === 200 && Boolean(used.data.token), 'a good password is accepted and signs them in');

const sessionWorks = await call('/client/me', { token: used.data.token });
log(sessionWorks.status === 200, 'the session it hands back is usable');

const again = await call('/client/set-password', {
  method: 'POST',
  body: { token: tokenFrom(created.data.link), password: PASSWORD, confirmPassword: PASSWORD },
});
log(again.status === 410, 'the link cannot be used a second time', again.data?.error);

const peekUsed = await call(`/client/set-password/${tokenFrom(created.data.link)}`);
log(peekUsed.data.valid === false && peekUsed.data.reason === 'used', 'and reports itself as used');

log(
  Boolean(
    (await call('/client/login', {
      method: 'POST',
      body: { email: 'link.one@example.com', password: PASSWORD },
    })).data?.token
  ),
  'the password they chose works'
);

/* =================================================== superseding a link === */
section('a newer link retires the older one');

const first = await call(`/admin/clients/${created.data.client.id}/reset-password`, {
  token: admin,
  method: 'POST',
});
const second = await call(`/admin/clients/${created.data.client.id}/reset-password`, {
  token: admin,
  method: 'POST',
});
log(first.status === 200 && second.status === 200, 'two reset links are issued in a row');

const firstPeek = await call(`/client/set-password/${tokenFrom(first.data.link)}`);
log(
  firstPeek.data.valid === false && firstPeek.data.reason === 'expired',
  'the earlier link has been retired',
  firstPeek.data?.reason
);

const secondPeek = await call(`/client/set-password/${tokenFrom(second.data.link)}`);
log(secondPeek.data.valid === true, 'only the most recent one works');

/* ================================================== suspended contacts === */
section('a suspended contact');

await call(`/admin/clients/${created.data.client.id}`, {
  token: admin,
  method: 'PATCH',
  body: { status: 'suspended' },
});
const suspendedPeek = await call(`/client/set-password/${tokenFrom(second.data.link)}`);
log(
  suspendedPeek.data.valid === false && suspendedPeek.data.reason === 'inactive',
  'their outstanding link stops working too'
);

await call(`/admin/clients/${created.data.client.id}`, { token: admin, method: 'DELETE' });

/* ========================================================= rate limits === */
section('the rate limiter counts in the database');

// Deliberately past the per-email limit of 10 in five minutes.
const attempts = [];
for (let i = 0; i < 13; i++) {
  attempts.push(
    await call('/client/login', {
      method: 'POST',
      body: { email: 'ratelimit.probe@example.com', password: `guess-${i}` },
    })
  );
}
const limited = attempts.filter((a) => a.status === 429);
log(limited.length > 0, 'repeated attempts are eventually refused', `${limited.length} of 13 refused`);
log(
  attempts.findIndex((a) => a.status === 429) >= 10,
  'and only after the allowance is spent',
  `first 429 at attempt ${attempts.findIndex((a) => a.status === 429) + 1}`
);

// The count lives in the database, which is the whole point: it is shared
// rather than per-process, so it survives anything the process does.
const audit = await call('/admin/audit?limit=5', { token: admin });
log(audit.status === 200, 'the API is still healthy after being rate limited');

const otherEmail = await call('/client/login', {
  method: 'POST',
  body: { email: 'someone.else@example.com', password: 'whatever-it-is' },
});
log(
  otherEmail.status !== 429,
  'a different address is not caught by that limit',
  `${otherEmail.status}`
);

finish('security');
