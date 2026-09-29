/**
 * Post orders: a post's standing instructions, versioned.
 *
 * The text officers read lives on the post (posts.instructions), where the
 * Sites screen has always edited it. Every change to it becomes a new version
 * here, never an edit in place, so the orders in force on any date can be
 * produced - and each version needs acknowledging by the officers who work
 * the post.
 */

import { db } from '../lib/db.js';
import { isoFields } from '../lib/http.js';

/** The latest version for a post, creating version 1 from the post's text if it has none. */
export async function currentOrders(postId) {
  let row = await db.prepare(`SELECT * FROM post_orders WHERE post_id = ? ORDER BY version DESC LIMIT 1`).get(postId);
  if (!row) {
    const post = await db.prepare(`SELECT instructions FROM posts WHERE id = ?`).get(postId);
    if (!post?.instructions?.trim()) return null;
    await db
      .prepare(`INSERT INTO post_orders (post_id, version, body) VALUES (?, 1, ?) ON CONFLICT (post_id, version) DO NOTHING`)
      .run(postId, post.instructions);
    row = await db.prepare(`SELECT * FROM post_orders WHERE post_id = ? ORDER BY version DESC LIMIT 1`).get(postId);
  }
  return row;
}

/**
 * Record new orders for a post if the text has changed. Returns the version
 * in force afterwards, and whether this call created it.
 */
export async function reviseOrders(postId, body, userId, changeNote = null) {
  const text = String(body || '').trim();
  const latest = await db.prepare(`SELECT * FROM post_orders WHERE post_id = ? ORDER BY version DESC LIMIT 1`).get(postId);
  if (latest && latest.body.trim() === text) return { order: latest, created: false };
  if (!text && !latest) return { order: null, created: false };
  const version = (latest?.version || 0) + 1;
  await db
    .prepare(`INSERT INTO post_orders (post_id, version, body, change_note, created_by) VALUES (?,?,?,?,?)`)
    .run(postId, version, text, changeNote, userId);
  await db.prepare(`UPDATE posts SET instructions = ? WHERE id = ?`).run(text || null, postId);
  const order = await db.prepare(`SELECT * FROM post_orders WHERE post_id = ? AND version = ?`).get(postId, version);
  return { order, created: true };
}

/** The current orders as an officer sees them, with whether they have acknowledged them. */
export async function ordersForOfficer(postId, userId) {
  const order = await currentOrders(postId);
  // Orders withdrawn (the post's instructions cleared) leave nothing to read.
  if (!order?.body.trim()) return null;
  const ack = await db.prepare(`SELECT acked_at FROM post_order_acks WHERE post_order_id = ? AND user_id = ?`).get(order.id, userId);
  const author = order.created_by
    ? await db.prepare(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = ?`).get(order.created_by)
    : null;
  return {
    ...isoFields(order, ['created_at']),
    author_name: author?.name || null,
    acked_at: ack ? isoFields(ack, ['acked_at']).acked_at : null,
  };
}
