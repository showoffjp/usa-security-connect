import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtTime, fmtDay } from '../lib/format.js';
import { Icon, Chip } from './ui.jsx';
import { PositionMap, directionsLink } from './Map.jsx';
import { locationOffset, formatDistance, RULES } from '@shared/domain.js';

/**
 * Where you are, against where you are supposed to be.
 *
 * The browser watches the device position while this screen is open. On duty,
 * each fix is sent to dispatch at the ping cadence so the live board and the
 * shift's GPS trail stay current. Off duty nothing leaves the device: the
 * comparison with the next post is worked out here and only shown to you.
 */
export default function GpsPanel({ status }) {
  const [fix, setFix] = useState(null);
  const [problem, setProblem] = useState('');
  const [lastSent, setLastSent] = useState(null);
  const [serverOffset, setServerOffset] = useState(null);
  const [showMap, setShowMap] = useState(true);
  const fixRef = useRef(null);

  const onDuty = Boolean(status?.onDuty);
  const entry = status?.entry;
  const shift = status?.shift || status?.nextShift;
  const target = onDuty
    ? entry && {
        post_name: entry.post_name,
        site_name: entry.site_name,
        address: [entry.address, entry.city].filter(Boolean).join(', '),
        latitude: entry.post_lat,
        longitude: entry.post_lng,
        radius_m: entry.geofence_radius_m,
      }
    : shift && {
        post_name: shift.post_name,
        site_name: shift.site_name,
        address: [shift.address, shift.city].filter(Boolean).join(', '),
        latitude: shift.post_lat,
        longitude: shift.post_lng,
        radius_m: shift.geofence_radius_m,
        starts_at: shift.starts_at,
      };

  // Watch the position for as long as the panel is on screen.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setProblem('This device cannot report its location.');
      return undefined;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const next = {
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
          accuracy: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
          speed: pos.coords.speed ?? null,
          heading: pos.coords.heading ?? null,
          at: new Date(pos.timestamp),
        };
        fixRef.current = next;
        setFix(next);
        setProblem('');
      },
      (err) =>
        setProblem(
          err.code === 1
            ? 'Location permission is blocked. Allow it for this site so dispatch can see you are on post.'
            : 'Your location is unavailable right now. Move to an open area.'
        ),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // On duty: report the latest fix at the ping cadence.
  useEffect(() => {
    if (!onDuty) {
      setServerOffset(null);
      return undefined;
    }
    let alive = true;
    const send = async () => {
      const current = fixRef.current;
      if (!current) return;
      try {
        const res = await api.post('/timeclock/location', {
          latitude: current.latitude,
          longitude: current.longitude,
          accuracy: current.accuracy,
          speed: current.speed,
          heading: current.heading,
        });
        if (!alive) return;
        if (res.recorded) setLastSent(new Date());
        setServerOffset(res.offset);
      } catch {
        /* a dropped report is fine; the next one follows */
      }
    };
    const first = setTimeout(send, 1500);
    const every = (status?.rules?.locationPingSeconds || RULES.locationPingSeconds) * 1000;
    const t = setInterval(send, every);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [onDuty, status?.rules?.locationPingSeconds]);

  if (!target && !fix) return null;

  const offset =
    fix && target?.latitude != null
      ? locationOffset({
          lat: fix.latitude,
          lng: fix.longitude,
          accuracy: fix.accuracy,
          post: { latitude: target.latitude, longitude: target.longitude, geofence_radius_m: target.radius_m },
        })
      : null;
  const shown = offset || serverOffset;
  const inside = shown?.status === 'inside';
  const outside = shown?.status === 'outside';

  return (
    <div className="card" style={outside && onDuty ? { borderColor: '#f3c9c3' } : undefined}>
      <div className="card-head">
        <div className="row">
          <Icon name="gps" size={18} style={{ color: 'var(--navy-700)' }} />
          <h3>{onDuty ? 'Your location vs your post' : 'Your location vs your next post'}</h3>
        </div>
        {onDuty && (
          <Chip kind={lastSent ? 'ok' : ''} dot={Boolean(lastSent)}>
            {lastSent ? `Shared ${fmtTime(lastSent)}` : 'Sharing on'}
          </Chip>
        )}
      </div>
      <div className="card-body stack">
        {problem && (
          <div className="small row" style={{ color: 'var(--warn)' }}>
            <Icon name="alert" size={15} /> {problem}
          </div>
        )}

        <div className="gps-compare">
          <div>
            <div className="tiny muted strong" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              You are
            </div>
            {fix ? (
              <>
                <div className="small mono">
                  {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
                </div>
                <div className="tiny muted">
                  {fix.accuracy != null ? `accurate to ±${fix.accuracy} m` : 'accuracy unknown'} · {fmtTime(fix.at)}
                </div>
              </>
            ) : (
              <div className="small muted">{problem ? 'No position' : 'Finding you...'}</div>
            )}
          </div>
          <div>
            <div className="tiny muted strong" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              You should be at
            </div>
            {target ? (
              <>
                <div className="small strong">{target.post_name}</div>
                <div className="tiny muted">
                  {target.site_name}
                  {target.address ? ` - ${target.address}` : ''}
                </div>
                {!onDuty && target.starts_at && (
                  <div className="tiny muted">
                    from {fmtDay(target.starts_at)} {fmtTime(target.starts_at)}
                  </div>
                )}
              </>
            ) : (
              <div className="small muted">No post scheduled</div>
            )}
          </div>
        </div>

        {shown && shown.distance != null && (
          <div
            className="gps-verdict"
            data-state={inside ? 'inside' : outside ? (onDuty ? 'outside' : 'away') : 'unknown'}
            role="status"
          >
            {inside ? (
              <>
                <Icon name="check" size={18} />
                <span>
                  <strong>Inside the geofence</strong> - {formatDistance(shown.distance)} from the post centre (limit{' '}
                  {formatDistance(shown.radius)}).
                </span>
              </>
            ) : shown.status === 'unverified' ? (
              <>
                <Icon name="alert" size={18} />
                <span>
                  <strong>GPS signal too weak to verify</strong> (±{shown.accuracy} m). About {formatDistance(shown.distance)} from the post.
                </span>
              </>
            ) : (
              <>
                <Icon name={onDuty ? 'alert' : 'route'} size={18} />
                <span>
                  <strong>{formatDistance(shown.distance)} from your post</strong>
                  {shown.heading ? ` - head ${shown.heading}` : ''}.{' '}
                  {onDuty
                    ? 'You are outside the geofence. Dispatch can see this - return to post or radio in.'
                    : `You can clock in once you are within ${formatDistance(shown.radius)} of it.`}
                </span>
              </>
            )}
          </div>
        )}

        {target?.latitude != null && (
          <div className="row wrap">
            <a className="btn btn-ghost btn-sm" href={directionsLink(target.latitude, target.longitude)} target="_blank" rel="noreferrer">
              <Icon name="map" size={14} /> Directions to post
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap}>
              <Icon name="pin" size={14} /> {showMap ? 'Hide map' : 'Show map'}
            </button>
          </div>
        )}

        {showMap && target?.latitude != null && <PositionMap me={fix} post={target} />}

        <p className="tiny muted" style={{ margin: 0 }}>
          {onDuty
            ? 'Your position is shared with dispatch about once a minute while you are clocked in, and stops when you clock out.'
            : 'You are off the clock, so your position stays on this device - nothing is sent.'}
        </p>
      </div>
    </div>
  );
}
