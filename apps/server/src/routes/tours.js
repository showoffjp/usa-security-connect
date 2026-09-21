import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../lib/db.js';
import { HttpError, wrap, parse, isoFields } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { toSql } from '../services/compliance.js';

export const toursRouter = Router();
toursRouter.use(requireAuth);

/** Tours available at the site the officer is currently posted to. */
toursRouter.get(
  '/',
  wrap(async (req, res) => {
    const open = db
      .prepare(
        `SELECT te.*, p.site_id FROM time_entries te
         JOIN posts p ON p.id = te.post_id
         WHERE te.user_id = ? AND te.clock_out_at IS NULL LIMIT 1`
      )
      .get(req.user.id);

    const siteId = Number(req.query.siteId) || open?.site_id || req.user.default_site_id;
    if (!siteId) return res.json({ tours: [], activeRun: null });

    const tours = db
      .prepare(
        `SELECT t.*, s.name AS site_name,
                (SELECT COUNT(*) FROM checkpoints c WHERE c.tour_id = t.id) AS checkpoint_count
         FROM tours t JOIN sites s ON s.id = t.site_id
         WHERE t.site_id = ? AND t.active = 1
         ORDER BY t.name`
      )
      .all(siteId);

    const activeRun = db
      .prepare(
        `SELECT tr.*, t.name AS tour_name FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         WHERE tr.user_id = ? AND tr.status = 'in_progress'
         ORDER BY tr.started_at DESC LIMIT 1`
      )
      .get(req.user.id);

    res.json({
      tours,
      activeRun: activeRun ? isoFields(activeRun, ['started_at', 'completed_at']) : null,
    });
  })
);

/** Full detail for a run: checkpoints in order, each with its task list. */
function runDetail(runId, userId) {
  const run = db
    .prepare(
      `SELECT tr.*, t.name AS tour_name, t.description, t.expected_minutes, s.name AS site_name
       FROM tour_runs tr
       JOIN tours t ON t.id = tr.tour_id
       JOIN sites s ON s.id = t.site_id
       WHERE tr.id = ?`
    )
    .get(runId);
  if (!run) throw new HttpError(404, 'Tour not found.');
  if (userId && run.user_id !== userId) throw new HttpError(403, 'That tour belongs to another officer.');

  const checkpoints = db
    .prepare(
      `SELECT trc.*, c.name, c.sequence, c.instructions, c.nfc_tag_id, c.qr_code,
              c.required, c.latitude, c.longitude
       FROM tour_run_checkpoints trc
       JOIN checkpoints c ON c.id = trc.checkpoint_id
       WHERE trc.tour_run_id = ?
       ORDER BY c.sequence, c.id`
    )
    .all(runId);

  const tasks = db
    .prepare(
      `SELECT trt.*, ct.label, ct.required, ct.sequence, trt.tour_run_checkpoint_id
       FROM tour_run_tasks trt
       JOIN checkpoint_tasks ct ON ct.id = trt.checkpoint_task_id
       JOIN tour_run_checkpoints trc ON trc.id = trt.tour_run_checkpoint_id
       WHERE trc.tour_run_id = ?
       ORDER BY ct.sequence, ct.id`
    )
    .all(runId);

  const done = checkpoints.filter((c) => c.status !== 'pending').length;

  return {
    run: isoFields(run, ['started_at', 'completed_at']),
    progress: { done, total: checkpoints.length },
    checkpoints: checkpoints.map((c) => ({
      ...isoFields(c, ['scanned_at']),
      tasks: tasks
        .filter((t) => t.tour_run_checkpoint_id === c.id)
        .map((t) => isoFields(t, ['completed_at'])),
    })),
  };
}

toursRouter.post(
  '/:tourId/start',
  wrap(async (req, res) => {
    const tour = db.prepare(`SELECT * FROM tours WHERE id = ? AND active = 1`).get(req.params.tourId);
    if (!tour) throw new HttpError(404, 'Tour not found.');

    const existing = db
      .prepare(`SELECT * FROM tour_runs WHERE user_id = ? AND status = 'in_progress' LIMIT 1`)
      .get(req.user.id);
    if (existing) {
      throw new HttpError(409, 'Finish or abandon your current tour before starting another.', {
        activeRunId: existing.id,
      });
    }

    const entry = db
      .prepare(`SELECT id FROM time_entries WHERE user_id = ? AND clock_out_at IS NULL LIMIT 1`)
      .get(req.user.id);

    const runId = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO tour_runs (tour_id, user_id, time_entry_id, started_at)
           VALUES (?,?,?,?)`
        )
        .run(tour.id, req.user.id, entry?.id ?? null, toSql(new Date()));
      const id = Number(info.lastInsertRowid);

      // Snapshot the checkpoints + tasks so later edits to the tour template
      // never rewrite the history of a walk that already happened.
      const checkpoints = db
        .prepare(`SELECT * FROM checkpoints WHERE tour_id = ? ORDER BY sequence, id`)
        .all(tour.id);

      for (const cp of checkpoints) {
        const cpInfo = db
          .prepare(`INSERT INTO tour_run_checkpoints (tour_run_id, checkpoint_id) VALUES (?,?)`)
          .run(id, cp.id);
        const tasks = db
          .prepare(`SELECT * FROM checkpoint_tasks WHERE checkpoint_id = ? ORDER BY sequence, id`)
          .all(cp.id);
        for (const task of tasks) {
          db.prepare(
            `INSERT INTO tour_run_tasks (tour_run_checkpoint_id, checkpoint_task_id) VALUES (?,?)`
          ).run(Number(cpInfo.lastInsertRowid), task.id);
        }
      }
      return id;
    })();

    audit(req.user.id, 'tour.started', 'tour_run', runId, { tour: tour.name }, req.ip);
    res.status(201).json(runDetail(runId, req.user.id));
  })
);

toursRouter.get(
  '/runs/:runId',
  wrap(async (req, res) => {
    res.json(runDetail(Number(req.params.runId), req.user.id));
  })
);

const scanSchema = z.object({
  method: z.enum(['nfc', 'qr', 'manual', 'gps']).default('manual'),
  tagId: z.string().max(200).optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
});

toursRouter.post(
  '/runs/:runId/checkpoints/:checkpointId/scan',
  wrap(async (req, res) => {
    const body = parse(scanSchema, req.body);
    const run = db.prepare(`SELECT * FROM tour_runs WHERE id = ?`).get(req.params.runId);
    if (!run || run.user_id !== req.user.id) throw new HttpError(404, 'Tour not found.');
    if (run.status !== 'in_progress') throw new HttpError(409, 'This tour is already finished.');

    const trc = db
      .prepare(`SELECT * FROM tour_run_checkpoints WHERE tour_run_id = ? AND checkpoint_id = ?`)
      .get(run.id, req.params.checkpointId);
    if (!trc) throw new HttpError(404, 'Checkpoint is not part of this tour.');

    // When the officer taps a physical tag, confirm it is the right one.
    if (body.tagId) {
      const cp = db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(req.params.checkpointId);
      const expected = (cp.nfc_tag_id || cp.qr_code || '').trim();
      if (expected && expected.toLowerCase() !== body.tagId.trim().toLowerCase()) {
        throw new HttpError(409, `That tag belongs to a different checkpoint.`);
      }
    }

    db.prepare(
      `UPDATE tour_run_checkpoints
       SET status = 'done', scanned_at = ?, method = ?, latitude = ?, longitude = ?
       WHERE id = ?`
    ).run(toSql(new Date()), body.method, body.latitude ?? null, body.longitude ?? null, trc.id);

    res.json(runDetail(run.id, req.user.id));
  })
);

const skipSchema = z.object({ reason: z.string().trim().min(3, 'Say why you are skipping it.').max(500) });

toursRouter.post(
  '/runs/:runId/checkpoints/:checkpointId/skip',
  wrap(async (req, res) => {
    const body = parse(skipSchema, req.body);
    const run = db.prepare(`SELECT * FROM tour_runs WHERE id = ?`).get(req.params.runId);
    if (!run || run.user_id !== req.user.id) throw new HttpError(404, 'Tour not found.');

    const trc = db
      .prepare(`SELECT * FROM tour_run_checkpoints WHERE tour_run_id = ? AND checkpoint_id = ?`)
      .get(run.id, req.params.checkpointId);
    if (!trc) throw new HttpError(404, 'Checkpoint is not part of this tour.');

    db.prepare(
      `UPDATE tour_run_checkpoints SET status = 'skipped', skip_reason = ?, scanned_at = ? WHERE id = ?`
    ).run(body.reason, toSql(new Date()), trc.id);

    res.json(runDetail(run.id, req.user.id));
  })
);

const taskSchema = z.object({
  status: z.enum(['done', 'skipped', 'pending']),
  note: z.string().max(500).optional(),
});

toursRouter.patch(
  '/runs/:runId/tasks/:taskId',
  wrap(async (req, res) => {
    const body = parse(taskSchema, req.body);
    const row = db
      .prepare(
        `SELECT trt.*, tr.user_id, tr.id AS run_id
         FROM tour_run_tasks trt
         JOIN tour_run_checkpoints trc ON trc.id = trt.tour_run_checkpoint_id
         JOIN tour_runs tr ON tr.id = trc.tour_run_id
         WHERE trt.id = ? AND tr.id = ?`
      )
      .get(req.params.taskId, req.params.runId);
    if (!row || row.user_id !== req.user.id) throw new HttpError(404, 'Task not found.');

    db.prepare(
      `UPDATE tour_run_tasks SET status = ?, note = ?, completed_at = ? WHERE id = ?`
    ).run(body.status, body.note ?? null, body.status === 'pending' ? null : toSql(new Date()), row.id);

    res.json(runDetail(row.run_id, req.user.id));
  })
);

toursRouter.post(
  '/runs/:runId/complete',
  wrap(async (req, res) => {
    const run = db.prepare(`SELECT * FROM tour_runs WHERE id = ?`).get(req.params.runId);
    if (!run || run.user_id !== req.user.id) throw new HttpError(404, 'Tour not found.');
    if (run.status !== 'in_progress') throw new HttpError(409, 'This tour is already finished.');

    const outstanding = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tour_run_checkpoints trc
         JOIN checkpoints c ON c.id = trc.checkpoint_id
         WHERE trc.tour_run_id = ? AND trc.status = 'pending' AND c.required = 1`
      )
      .get(run.id).n;

    if (outstanding > 0) {
      throw new HttpError(409, `${outstanding} required checkpoint${outstanding === 1 ? '' : 's'} still outstanding. Scan or skip them first.`);
    }

    const skipped = db
      .prepare(`SELECT COUNT(*) AS n FROM tour_run_checkpoints WHERE tour_run_id = ? AND status = 'skipped'`)
      .get(run.id).n;

    db.prepare(`UPDATE tour_runs SET status = ?, completed_at = ? WHERE id = ?`).run(
      skipped > 0 ? 'completed_with_skips' : 'completed',
      toSql(new Date()),
      run.id
    );

    audit(req.user.id, 'tour.completed', 'tour_run', run.id, { skipped }, req.ip);
    res.json(runDetail(run.id, req.user.id));
  })
);

toursRouter.get(
  '/runs',
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const rows = db
      .prepare(
        `SELECT tr.*, t.name AS tour_name, s.name AS site_name,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id) AS total,
                (SELECT COUNT(*) FROM tour_run_checkpoints x WHERE x.tour_run_id = tr.id AND x.status = 'done') AS done
         FROM tour_runs tr
         JOIN tours t ON t.id = tr.tour_id
         JOIN sites s ON s.id = t.site_id
         WHERE tr.user_id = ?
         ORDER BY tr.started_at DESC LIMIT ?`
      )
      .all(req.user.id, limit);
    res.json({ runs: rows.map((r) => isoFields(r, ['started_at', 'completed_at'])) });
  })
);
