/**
 * NFC checkpoint scanning.
 *
 * The native module only exists in a development or production build, never in
 * Expo Go. Everything here degrades to `available: false` so the tour screen can
 * fall back to typing the tag ID, which the server validates identically.
 */

let nfcManager = null;
let NfcTech = null;
let loadAttempted = false;

function load() {
  if (loadAttempted) return nfcManager;
  loadAttempted = true;
  try {
    const mod = require('react-native-nfc-manager');
    nfcManager = mod.default;
    NfcTech = mod.NfcTech;
  } catch {
    nfcManager = null;
  }
  return nfcManager;
}

/** True only when the module is present *and* the handset has NFC switched on. */
export async function isNfcAvailable() {
  const manager = load();
  if (!manager) return false;
  try {
    const supported = await manager.isSupported();
    if (!supported) return false;
    await manager.start();
    return await manager.isEnabled();
  } catch {
    return false;
  }
}

/** Pull a printable identifier out of whatever the tag actually carries. */
function readTagId(tag) {
  if (!tag) return null;

  // Prefer a text or URI NDEF record, which is what our checkpoint tags carry.
  const records = tag.ndefMessage || [];
  for (const record of records) {
    if (!record?.payload?.length) continue;
    try {
      const bytes = record.payload;
      // A text record's first byte is a status byte holding the language length.
      const languageLength = bytes[0] & 0x3f;
      const text = String.fromCharCode(...bytes.slice(1 + languageLength));
      const cleaned = text.replace(/^https?:\/\//i, '').trim();
      if (cleaned) return cleaned;
    } catch {
      /* fall through to the hardware id */
    }
  }

  // Otherwise fall back to the tag's own serial number.
  if (tag.id) {
    return String(tag.id)
      .replace(/[^0-9a-fA-F]/g, '')
      .toUpperCase();
  }
  return null;
}

/**
 * Wait for the officer to hold the phone against a tag.
 * Always resolves - a cancelled or failed scan is a normal outcome.
 */
export async function scanTag({ timeoutMs = 20000 } = {}) {
  const manager = load();
  if (!manager) return { ok: false, reason: 'unavailable' };

  try {
    await manager.requestTechnology(NfcTech.Ndef);

    const tag = await Promise.race([
      manager.getTag(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (!tag) return { ok: false, reason: 'timeout' };

    const tagId = readTagId(tag);
    if (!tagId) return { ok: false, reason: 'unreadable' };

    return { ok: true, tagId };
  } catch (err) {
    // Cancelling the system scan sheet lands here, which is not an error.
    const message = String(err?.message || err || '');
    if (/cancel/i.test(message)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'error', message };
  } finally {
    try {
      await manager.cancelTechnologyRequest();
    } catch {
      /* nothing to cancel */
    }
  }
}

export function stopNfc() {
  const manager = load();
  if (!manager) return;
  manager.cancelTechnologyRequest().catch(() => {});
}
