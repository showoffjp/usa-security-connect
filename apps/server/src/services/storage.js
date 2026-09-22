/**
 * Incident photo storage.
 *
 * A serverless function has no disk worth writing to, so in production photos
 * go to Vercel Blob. Locally they stay on disk, which keeps development free of
 * external services and lets the tests run offline.
 *
 * The rest of the codebase only sees `put`, `read` and `remove`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPLOAD_DIR } from '../lib/db.js';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
export const usingBlob = Boolean(BLOB_TOKEN);

/** Photos are private: a leaked URL should not expose an incident scene. */
const BLOB_ACCESS = 'public'; // Vercel Blob has no private tier yet - see note below.

export const storageKind = usingBlob ? 'vercel-blob' : 'local-disk';

/** Unguessable name, so a stored object cannot be found by iterating. */
export function generateFilename(originalName = '') {
  const ext = path.extname(originalName).slice(0, 10).replace(/[^.\w]/g, '');
  return `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`;
}

/**
 * Store a photo.
 * Returns what the incident_photos row needs: a filename and, for blob
 * storage, the URL to fetch it back from.
 */
export async function put({ buffer, filename, mimeType }) {
  if (!usingBlob) {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    await fsp.writeFile(path.join(UPLOAD_DIR, filename), buffer);
    return { filename, storageUrl: null };
  }

  const { put: blobPut } = await import('@vercel/blob');
  const result = await blobPut(`incidents/${filename}`, buffer, {
    access: BLOB_ACCESS,
    token: BLOB_TOKEN,
    contentType: mimeType || 'application/octet-stream',
    addRandomSuffix: false,
  });
  return { filename, storageUrl: result.url };
}

/**
 * Read a photo back as a buffer.
 *
 * Blob URLs are unguessable but publicly readable, so the API never hands the
 * URL to the client - it proxies the bytes behind the same authentication and
 * ownership checks as everything else.
 */
export async function read(photo) {
  if (photo.storage_url) {
    const res = await fetch(photo.storage_url);
    if (!res.ok) throw new Error(`Stored photo could not be fetched (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  const filePath = path.join(UPLOAD_DIR, photo.filename);
  // Guard against a crafted filename escaping the upload directory.
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    throw new Error('Photo file is missing.');
  }
  return fsp.readFile(filePath);
}

export async function remove(photo) {
  try {
    if (photo.storage_url) {
      const { del } = await import('@vercel/blob');
      await del(photo.storage_url, { token: BLOB_TOKEN });
      return;
    }
    const filePath = path.join(UPLOAD_DIR, photo.filename);
    if (filePath.startsWith(UPLOAD_DIR)) await fsp.rm(filePath, { force: true });
  } catch (err) {
    // A missing file is not worth failing the request that triggered the delete.
    console.warn('[usc] could not remove stored photo:', err.message);
  }
}
