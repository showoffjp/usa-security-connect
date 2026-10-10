import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { Modal, Field, Chip, StatusChip, Icon, Spinner, useToast } from './ui.jsx';
import { PunchFixMap } from './Map.jsx';
import { PUNCH_FIX_LABEL, distanceMeters, formatDistance, parseCoordinates } from '@shared/domain.js';

const coords = (p) => (p?.latitude != null ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}` : '');
const feet = (m) => `${Math.round(m * 3.281).toLocaleString()} ft`;

const FLAG_SAID = {
  closed: 'Its flag was closed.',
  raised: 'It is now outside the geofence, so a flag was raised.',
  reopened: 'It is outside the geofence again, so its flag was reopened.',
  updated: 'Its flag now gives the corrected distance.',
};

/**
 * Correct where a clock-in, clock-out or check-in was made, when the phone's
 * reading was wrong: put it at the post in one click, drag the pin, or type
 * the exact coordinates. Shown to supervisors and administrators; a reason is
 * required, and every correction keeps the phone's own reading.
 */
export default function PunchLocationDialog({ kind, refId, onClose, onSaved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [value, setValue] = useState(null);
  const [atPost, setAtPost] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    api
      .get(`/admin/punches/${kind}/${refId}/location`)
      .then((d) => {
        setData(d);
        setValue(d.punch.location.latitude != null ? { latitude: d.punch.location.latitude, longitude: d.punch.location.longitude } : null);
        setTyped(coords(d.punch.location));
      })
      .catch((err) => {
        toast.error(err.message);
        closeRef.current();
      });
  }, [kind, refId, toast]);

  const post = data?.punch.post;
  const phone = data?.summary?.original || data?.punch.location;
  const current = data?.punch.location;

  const place = (v, { fromPost = false } = {}) => {
    setValue(v);
    setAtPost(fromPost);
    setTyped(coords(v));
  };
  const onTyped = (text) => {
    setTyped(text);
    const p = parseCoordinates(text);
    if (p) {
      setValue(p);
      setAtPost(false);
    }
  };
  const typedBad = typed.trim() !== '' && !parseCoordinates(typed);

  // The verdict the correction will get, worked out as the pin moves.
  const verdict = useMemo(() => {
    if (!value || post?.latitude == null) return null;
    const d = distanceMeters(value.latitude, value.longitude, post.latitude, post.longitude);
    return { distance: d, inside: d <= (post.radius_m || 150) };
  }, [value, post]);
  const unchanged = value && current?.latitude === Number(value.latitude.toFixed(6)) && current?.longitude === Number(value.longitude.toFixed(6));

  const save = async () => {
    setBusy(true);
    try {
      const body = atPost ? { atPost: true, reason: reason.trim() } : { latitude: value.latitude, longitude: value.longitude, reason: reason.trim() };
      const res = await api.post(`/admin/punches/${kind}/${refId}/location`, body);
      const loc = res.punch.location;
      const where = loc.geofence === 'inside' ? 'inside the geofence' : loc.geofence === 'outside' ? `${formatDistance(loc.distance_m)} from the post, outside the geofence` : 'saved';
      toast.success(`${PUNCH_FIX_LABEL[kind]} corrected: ${where}. ${FLAG_SAID[res.flag?.action] || ''}`.trim());
      onSaved(res);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const ready = value && !typedBad && !unchanged && reason.trim().length >= 5;

  return (
    <Modal
      wide
      title={`Correct the ${PUNCH_FIX_LABEL[kind]?.toLowerCase()} location`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!ready || busy}>
            {busy ? 'Saving...' : 'Save the location'}
          </button>
        </>
      }
    >
      {!data ? (
        <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
          <Spinner /> <span className="small muted">Loading the punch</span>
        </div>
      ) : (
        <div className="stack" id="punch-location">
          <dl className="kv">
            <dt>Officer</dt>
            <dd>
              {data.punch.officer} ({data.punch.employee_code})
            </dd>
            <dt>{PUNCH_FIX_LABEL[kind]}</dt>
            <dd>
              {fmtDateTime(data.punch.at)} at {post.name}, {data.punch.site_name}
            </dd>
            <dt>Recorded now</dt>
            <dd className="row wrap" style={{ gap: 6 }}>
              {current.latitude != null ? <span className="mono small">{coords(current)}</span> : <span className="small muted">No location</span>}
              {current.geofence && <StatusChip value={current.geofence} />}
              {current.distance_m != null && <span className="small muted">{formatDistance(current.distance_m)} from the post</span>}
            </dd>
            {data.summary && (
              <>
                <dt>The phone said</dt>
                <dd className="small">
                  {phone.latitude != null ? <span className="mono">{coords(phone)}</span> : 'No location'}
                  {phone.accuracy != null && ` (±${Math.round(phone.accuracy)} m)`}
                  {phone.distance_m != null && `, ${formatDistance(phone.distance_m)} from the post`}
                </dd>
              </>
            )}
          </dl>

          <PunchFixMap post={post} phone={phone} value={value} onChange={(v) => place(v)} />
          <p className="tiny muted" style={{ margin: 0 }}>
            The circle is the post's geofence ({post.radius_m || 150} m). Grey is where the phone said; drag the red pin, or click the map, to where the officer really was.
          </p>

          <div className="row wrap" style={{ alignItems: 'flex-end', gap: 10 }}>
            <button
              type="button"
              className="btn btn-navy"
              onClick={() => place({ latitude: post.latitude, longitude: post.longitude }, { fromPost: true })}
              disabled={post.latitude == null}
            >
              <Icon name="pin" size={16} /> At the post
            </button>
            <div className="grow" style={{ minWidth: 220 }}>
              <Field
                id="fix-coordinates"
                label="Exact coordinates"
                hint="Latitude, then longitude, e.g. 30.313263, -81.677997"
                error={typedBad ? 'Two numbers: latitude, then longitude.' : null}
              >
                <input value={typed} onChange={(e) => onTyped(e.target.value)} inputMode="decimal" autoComplete="off" />
              </Field>
            </div>
          </div>

          {verdict && (
            <div className="row wrap" style={{ gap: 8 }} aria-live="polite">
              <Chip kind={verdict.inside ? 'ok' : 'danger'}>{verdict.inside ? 'Inside the geofence' : 'Outside the geofence'}</Chip>
              <span className="small">
                {atPost ? 'On the post pin' : `${formatDistance(verdict.distance)} (${feet(verdict.distance)}) from the post`}
              </span>
              {unchanged && <span className="small muted">That is where it is recorded already.</span>}
            </div>
          )}

          <Field id="fix-reason" label="Why is it being corrected?" hint="Kept with the punch, and on the flag if one closes." required>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Phone GPS drifted in the parking garage. I saw them at the desk at the time."
            />
          </Field>

          {data.fixes.length > 0 && (
            <div>
              <div className="small strong" style={{ marginBottom: 4 }}>
                Corrected before
              </div>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {data.fixes.map((f) => (
                  <li key={f.id}>
                    {fmtDateTime(f.fixed_at)}, {f.fixed_by_name}: {f.from_geofence ? `${f.from_geofence} ` : ''}
                    {f.from_distance_m != null ? `(${formatDistance(f.from_distance_m)})` : ''} to {f.to_geofence}
                    {f.to_distance_m != null ? ` (${formatDistance(f.to_distance_m)})` : ''}. "{f.reason}"
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
