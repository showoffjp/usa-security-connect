import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { getPosition } from '../lib/geo.js';
import { Chip, Icon, Field, Spinner, useToast } from './ui.jsx';
import { LOCATION_RULES } from '@shared/domain.js';

/* ------------------------------------------------------------- loading -- */

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

let leafletPromise = null;

/**
 * Load Leaflet once, on demand.
 *
 * Leaflet is used rather than the Google Maps SDK because it needs no API key
 * and no billing account, so the map works the moment the app is installed.
 * Every location also carries an "Open in Google Maps" link, which is what an
 * officer actually wants for turn-by-turn directions.
 */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('The map library could not be loaded.'));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

/**
 * Names, addresses and notes are typed by people, and Leaflet popups are HTML.
 * Everything interpolated into one goes through here.
 */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Directions link that works on desktop and both phone platforms. */
export const googleMapsLink = (lat, lng, label) =>
  `https://www.google.com/maps/search/?api=1&query=${lat},${lng}${label ? `&query_place_id=${encodeURIComponent(label)}` : ''}`;

export const directionsLink = (lat, lng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

/* --------------------------------------------------------------- hooks -- */

function useMap(containerRef, { center, zoom = 15, onReady }) {
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let observer = null;

    loadLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current || mapRef.current) return;

        const map = L.map(containerRef.current, {
          center: center || [27.9944, -81.7603], // Florida, until a pin is set
          zoom: center ? zoom : 6,
          scrollWheelZoom: true,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 19,
        }).addTo(map);

        // Map tiles are decorative: they are hundreds of unlabelled images,
        // and everything the map shows is also on the page as text. Hiding
        // the tile pane keeps a screen reader out of that thicket.
        map.getPane('tilePane')?.setAttribute('aria-hidden', 'true');

        mapRef.current = map;

        // Leaflet measures the container on creation. Inside a card that is
        // still laying out, that measurement is wrong and the tiles render in
        // a strip, so re-measure whenever the container's size settles.
        const invalidate = () => map.invalidateSize({ animate: false });
        observer = new ResizeObserver(invalidate);
        observer.observe(containerRef.current);
        requestAnimationFrame(invalidate);

        setReady(true);
        onReady?.(map, L);
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // Intentionally mounts once: the map instance is reused across prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { map: mapRef, ready, error };
}

/* ------------------------------------------------------ location picker -- */

const PRECISION = { building: ['ok', 'Building'], street: ['info', 'Along the street'], area: ['warn', 'Area only'] };

/**
 * Pick a post's exact location: search an address, drop a pin, drag it, or -
 * most accurate of all - stand at the post and set it from this device, which
 * is only taken with a fix good to LOCATION_RULES.surveyAccuracyM. The circle
 * shows the geofence the officer will have to be standing inside to clock in.
 * onChange is told where each pin came from: 'address', 'map' or 'survey'.
 */
export function LocationPicker({ latitude, longitude, radius = 150, onChange, height = 320 }) {
  const toast = useToast();
  const containerRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);
  const leafletRef = useRef(null);
  const mapObj = useRef(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const hasPin = latitude != null && longitude != null;

  const place = useCallback(
    (lat, lng, { fly = true } = {}) => {
      const L = leafletRef.current;
      const map = mapObj.current;
      if (!L || !map) return;

      if (!markerRef.current) {
        markerRef.current = L.marker([lat, lng], { draggable: true }).addTo(map);
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current.getLatLng();
          onChange?.({ latitude: Number(pos.lat.toFixed(6)), longitude: Number(pos.lng.toFixed(6)), source: 'map' });
        });
      } else {
        markerRef.current.setLatLng([lat, lng]);
      }

      if (!circleRef.current) {
        circleRef.current = L.circle([lat, lng], {
          radius,
          color: '#AA2F19',
          fillColor: '#AA2F19',
          fillOpacity: 0.12,
          weight: 2,
        }).addTo(map);
      } else {
        circleRef.current.setLatLng([lat, lng]);
      }

      if (fly) map.setView([lat, lng], Math.max(map.getZoom(), 16));
    },
    [onChange, radius]
  );

  const { ready, error } = useMap(containerRef, {
    center: hasPin ? [latitude, longitude] : null,
    onReady: (map, L) => {
      mapObj.current = map;
      leafletRef.current = L;

      map.on('click', (e) => {
        onChange?.({
          latitude: Number(e.latlng.lat.toFixed(6)),
          longitude: Number(e.latlng.lng.toFixed(6)),
          source: 'map',
        });
      });

      if (hasPin) place(latitude, longitude, { fly: false });
    },
  });

  // Keep the pin and geofence circle in step with the form fields.
  useEffect(() => {
    if (ready && hasPin) place(latitude, longitude, { fly: false });
  }, [ready, hasPin, latitude, longitude, place]);

  useEffect(() => {
    if (circleRef.current) circleRef.current.setRadius(radius || 150);
  }, [radius]);

  const search = async (e) => {
    e?.preventDefault();
    if (query.trim().length < 3) return;
    setSearching(true);
    try {
      const res = await api.get(`/reports/geocode?q=${encodeURIComponent(query.trim())}`);
      setResults(res.results);
      if (!res.results.length) toast.toast('No match for that address.');
      if (res.error) toast.error(res.error);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSearching(false);
    }
  };

  const [surveying, setSurveying] = useState(false);
  const useMyLocation = async () => {
    setSurveying(true);
    const fix = await getPosition({ timeout: 20000, goodEnough: 5 });
    setSurveying(false);
    if (!fix.ok) return toast.error(fix.message);
    if (fix.accuracy == null || fix.accuracy > LOCATION_RULES.surveyAccuracyM) {
      return toast.error(
        `Your position is only good to ${fix.accuracy ?? '?'} m; it needs to be within ${LOCATION_RULES.surveyAccuracyM} m. Step outside or near a window, wait a moment and try again.`
      );
    }
    onChange?.({ latitude: fix.latitude, longitude: fix.longitude, source: 'survey', accuracy: fix.accuracy });
    place(fix.latitude, fix.longitude);
    toast.success(`Pin set where you are standing, good to ${fix.accuracy} m.`);
  };

  return (
    <div className="stack-sm">
      <form onSubmit={search} className="row">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search for an address"
          placeholder="Search an address, e.g. 1200 Riverside Ave, Jacksonville FL"
          className="grow"
        />
        <button type="submit" className="btn btn-navy btn-sm" disabled={searching}>
          {searching ? <Spinner /> : <Icon name="search" size={15} />}
          Find
        </button>
      </form>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn-navy btn-sm" onClick={useMyLocation} disabled={surveying}>
          <Icon name="gps" size={15} /> {surveying ? 'Getting a precise fix...' : "Set from where I'm standing"}
        </button>
        <span className="tiny muted grow">Most accurate: stand at the post with this phone. Taken only with a fix good to {LOCATION_RULES.surveyAccuracyM} m (about {Math.round(LOCATION_RULES.surveyAccuracyM * 3.28)} ft).</span>
      </div>

      {results.length > 0 && (
        <div className="card" style={{ maxHeight: 150, overflowY: 'auto' }}>
          <div className="list">
            {results.map((r, i) => (
              <button
                key={i}
                type="button"
                className="list-item"
                onClick={() => {
                  onChange?.({ latitude: r.latitude, longitude: r.longitude, label: r.label, source: 'address' });
                  place(r.latitude, r.longitude);
                  setResults([]);
                  setQuery('');
                }}
              >
                <Icon name="pin" size={15} />
                <span className="small grow">{r.label}</span>
                {PRECISION[r.precision] && <Chip kind={PRECISION[r.precision][0]}>{PRECISION[r.precision][1]}</Chip>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          height,
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--line)',
          background: 'var(--surface-3)',
          zIndex: 0,
        }}
      />

      {error ? (
        <span className="small" style={{ color: 'var(--danger)' }}>
          {error} Enter the coordinates by hand below.
        </span>
      ) : (
        <span className="tiny muted">
          Click the map to drop the pin, or drag it. The circle is the {radius}m geofence.
        </span>
      )}

      <div className="grid grid-2">
        <Field label="Latitude">
          <input
            type="number"
            step="0.000001"
            value={latitude ?? ''}
            onChange={(e) =>
              onChange?.({
                latitude: e.target.value === '' ? null : Number(e.target.value),
                longitude,
                source: 'map',
              })
            }
          />
        </Field>
        <Field label="Longitude">
          <input
            type="number"
            step="0.000001"
            value={longitude ?? ''}
            onChange={(e) =>
              onChange?.({
                latitude,
                longitude: e.target.value === '' ? null : Number(e.target.value),
                source: 'map',
              })
            }
          />
        </Field>
      </div>

      {hasPin && (
        <a
          className="btn btn-ghost btn-sm"
          href={googleMapsLink(latitude, longitude)}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="pin" size={14} /> Open in Google Maps
        </a>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- operations -- */

/** Live map: every post, who is standing on it, and any duress alert. */
export function OpsMap({ posts = [], onDuty = [], alerts = [], height = 460, onSelect }) {
  const containerRef = useRef(null);
  const layerRef = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);

  const { ready, error } = useMap(containerRef, {
    onReady: (map, L) => {
      mapRef.current = map;
      leafletRef.current = L;
      layerRef.current = L.layerGroup().addTo(map);
    },
  });

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;

    layer.clearLayers();
    const bounds = [];

    const pin = (color, glyph) =>
      L.divIcon({
        className: '',
        html: `<div style="background:${color};width:26px;height:26px;border-radius:50% 50% 50% 0;
               transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.35);
               display:grid;place-items:center">
               <span style="transform:rotate(45deg);color:#fff;font-size:12px;font-weight:700">${glyph}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 26],
      });

    for (const post of posts) {
      if (post.latitude == null) continue;
      bounds.push([post.latitude, post.longitude]);

      L.circle([post.latitude, post.longitude], {
        radius: post.geofence_radius_m || 150,
        color: '#0C3F72',
        fillColor: '#0C3F72',
        fillOpacity: 0.07,
        weight: 1,
      }).addTo(layer);

      const staffed = onDuty.filter((o) => o.post_id === post.id);
      L.marker([post.latitude, post.longitude], {
        icon: pin(staffed.length ? '#1E8E4E' : '#7E7E7E', post.armed ? 'A' : 'P'),
      })
        .addTo(layer)
        .bindPopup(
          `<strong>${esc(post.name)}</strong><br/>${esc(post.site_name)}<br/>` +
            (staffed.length
              ? `<span style="color:#1E8E4E">On post: ${esc(staffed.map((s) => s.officer).join(', '))}</span>`
              : '<span style="color:#7E7E7E">Unstaffed</span>') +
            `<br/><a href="${directionsLink(post.latitude, post.longitude)}" target="_blank" rel="noreferrer">Directions</a>`
        );
    }

    // Where the officer actually was when they clocked in - the honest position.
    for (const officer of onDuty) {
      if (officer.clock_in_lat == null) continue;
      bounds.push([officer.clock_in_lat, officer.clock_in_lng]);

      const outside = officer.clock_in_geofence === 'outside';
      L.marker([officer.clock_in_lat, officer.clock_in_lng], {
        icon: pin(outside ? '#B26A00' : '#001F3F', 'O'),
      })
        .addTo(layer)
        .bindPopup(
          `<strong>${esc(officer.officer)}</strong><br/>${esc(officer.post_name)}<br/>` +
            `Clocked in ${new Date(officer.clock_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` +
            (outside ? `<br/><span style="color:#B26A00">Clocked in ${officer.clock_in_distance_m}m away</span>` : '') +
            (officer.phone ? `<br/><a href="tel:${esc(officer.phone)}">${esc(officer.phone)}</a>` : '')
        )
        .on('click', () => onSelect?.(officer));
    }

    for (const alert of alerts) {
      if (alert.latitude == null) continue;
      bounds.push([alert.latitude, alert.longitude]);

      L.circle([alert.latitude, alert.longitude], {
        radius: 60,
        color: '#C0392B',
        fillColor: '#C0392B',
        fillOpacity: 0.3,
        weight: 3,
      }).addTo(layer);

      L.marker([alert.latitude, alert.longitude], { icon: pin('#C0392B', '!'), zIndexOffset: 1000 })
        .addTo(layer)
        .bindPopup(
          `<strong style="color:#C0392B">DURESS ALERT</strong><br/>${esc(alert.officer)}<br/>` +
            (alert.phone ? `<a href="tel:${esc(alert.phone)}">${esc(alert.phone)}</a><br/>` : '') +
            `<a href="${directionsLink(alert.latitude, alert.longitude)}" target="_blank" rel="noreferrer">Directions</a>`
        )
        .openPopup();
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
  }, [ready, posts, onDuty, alerts, onSelect]);

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          height,
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--line)',
          background: 'var(--surface-3)',
          zIndex: 0,
        }}
      />
      {error && (
        <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Small read-only map for a single point, used in detail views. */
export function MiniMap({ latitude, longitude, label, radius, height = 200 }) {
  const containerRef = useRef(null);

  const { error } = useMap(containerRef, {
    center: latitude != null ? [latitude, longitude] : null,
    zoom: 16,
    onReady: (map, L) => {
      if (latitude == null) return;
      L.marker([latitude, longitude]).addTo(map).bindPopup(esc(label || 'Location'));
      if (radius) {
        L.circle([latitude, longitude], {
          radius,
          color: '#AA2F19',
          fillColor: '#AA2F19',
          fillOpacity: 0.12,
          weight: 2,
        }).addTo(map);
      }
    },
  });

  if (latitude == null) return <div className="small muted">No location recorded.</div>;

  return (
    <div className="stack-sm">
      <div
        ref={containerRef}
        style={{ height, borderRadius: 'var(--r-md)', border: '1px solid var(--line)', zIndex: 0 }}
      />
      {error && <span className="tiny" style={{ color: 'var(--danger)' }}>{error}</span>}
      <a className="small" href={directionsLink(latitude, longitude)} target="_blank" rel="noreferrer">
        Directions in Google Maps
      </a>
    </div>
  );
}

/* ------------------------------------------------------------ live map -- */

/** Status colours for officer pins. Paired with a letter, so never colour alone. */
export const LIVE_PIN = {
  duress: ['#C0392B', '!'],
  off_post: ['#B3261E', 'X'],
  on_break: ['#145D9E', 'B'],
  on_post: ['#1E7A45', 'O'],
  no_show: ['#7A1F14', '?'],
  late: ['#8A5200', 'L'],
  upcoming: ['#4A5A6A', 'S'],
  off_duty: ['#7E7E7E', '-'],
};

function pinIcon(L, color, glyph, size = 26) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;
           transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.35);
           display:grid;place-items:center">
           <span style="transform:rotate(45deg);color:#fff;font-size:12px;font-weight:700">${esc(glyph)}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
  });
}

/**
 * Every officer at the position their phone last reported, every post with its
 * geofence, and - for anyone outside it - a dashed line back to where they
 * should be standing. That line is the whole point: "where you are" against
 * "where you are meant to be".
 */
export function LiveMap({ officers = [], posts = [], height = 480, focusId = null, onSelect }) {
  const containerRef = useRef(null);
  const layerRef = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const fittedRef = useRef(false);

  const { ready, error } = useMap(containerRef, {
    onReady: (map, L) => {
      mapRef.current = map;
      leafletRef.current = L;
      layerRef.current = L.layerGroup().addTo(map);
    },
  });

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;
    layer.clearLayers();
    const bounds = [];

    for (const post of posts) {
      if (post.latitude == null) continue;
      bounds.push([post.latitude, post.longitude]);
      L.circle([post.latitude, post.longitude], {
        radius: post.geofence_radius_m || 150,
        color: '#0C3F72',
        fillColor: '#0C3F72',
        fillOpacity: 0.06,
        weight: 1,
      })
        .addTo(layer)
        .bindPopup(
          `<strong>${esc(post.name)}</strong> ${post.armed ? '(armed)' : ''}<br/>${esc(post.site_name)}<br/>` +
            `${esc([post.address, post.city].filter(Boolean).join(', '))}<br/>` +
            `<a href="${directionsLink(post.latitude, post.longitude)}" target="_blank" rel="noreferrer">Directions</a>`
        );
    }

    let focus = null;
    for (const o of officers) {
      const loc = o.location;
      if (!loc || loc.latitude == null) continue;
      bounds.push([loc.latitude, loc.longitude]);
      const [color, glyph] = LIVE_PIN[o.status] || LIVE_PIN.off_duty;

      if (o.job && o.job.latitude != null && loc.geofence === 'outside') {
        L.polyline(
          [
            [loc.latitude, loc.longitude],
            [o.job.latitude, o.job.longitude],
          ],
          { color: '#B3261E', weight: 2, dashArray: '6 6' }
        ).addTo(layer);
      }
      if (loc.accuracy) {
        L.circle([loc.latitude, loc.longitude], {
          radius: loc.accuracy,
          color,
          weight: 0,
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(layer);
      }

      const marker = L.marker([loc.latitude, loc.longitude], {
        icon: pinIcon(L, color, glyph, o.user_id === focusId ? 32 : 26),
        zIndexOffset: o.status === 'off_post' || o.status === 'duress' ? 1000 : 0,
        title: `${o.name} - ${o.status_label}`,
      })
        .addTo(layer)
        .bindPopup(
          `<strong>${esc(o.name)}</strong> (${esc(o.employee_code)})<br/>${esc(o.status_label)}<br/>` +
            (o.job ? `${esc(o.job.post_name)} - ${esc(o.job.site_name)}<br/>` : '') +
            (loc.distance_m != null ? `${loc.distance_m} m from post (${esc(loc.geofence)})<br/>` : '') +
            `Last GPS ${loc.minutes_ago != null ? `${loc.minutes_ago} min ago` : ''}` +
            (o.phone ? `<br/><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : '')
        )
        .on('click', () => onSelect?.(o));
      if (o.user_id === focusId) focus = marker;
    }

    if (focus) {
      map.setView(focus.getLatLng(), 16);
      focus.openPopup();
    } else if (bounds.length && !fittedRef.current) {
      // Fit once; after that the supervisor's own pan and zoom are respected
      // across the auto-refresh.
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      fittedRef.current = true;
    }
  }, [ready, officers, posts, focusId, onSelect]);

  return (
    <div>
      <div
        ref={containerRef}
        role="group"
        aria-label="Map of officer positions and posts. The same information is in the table below."
        style={{ height, borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'var(--surface-3)', zIndex: 0 }}
      />
      {error && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/* ----------------------------------------------------------- track map -- */

/**
 * One officer's day: the trail they walked, each post's geofence, and every
 * reading outside it in red.
 */
export function TrackMap({ pings = [], entries = [], height = 380 }) {
  const containerRef = useRef(null);
  const layerRef = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);

  const { ready, error } = useMap(containerRef, {
    onReady: (map, L) => {
      mapRef.current = map;
      leafletRef.current = L;
      layerRef.current = L.layerGroup().addTo(map);
    },
  });

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;
    layer.clearLayers();
    const bounds = [];

    for (const e of entries) {
      if (e.post_lat == null) continue;
      bounds.push([e.post_lat, e.post_lng]);
      L.circle([e.post_lat, e.post_lng], {
        radius: e.geofence_radius_m || 150,
        color: '#0C3F72',
        fillColor: '#0C3F72',
        fillOpacity: 0.08,
        weight: 1,
      })
        .addTo(layer)
        .bindPopup(`<strong>${esc(e.post_name)}</strong><br/>${esc(e.site_name)}`);
    }

    const byEntry = new Map();
    for (const p of pings) {
      if (!byEntry.has(p.time_entry_id)) byEntry.set(p.time_entry_id, []);
      byEntry.get(p.time_entry_id).push(p);
    }
    for (const list of byEntry.values()) {
      const line = list.map((p) => [p.latitude, p.longitude]);
      bounds.push(...line);
      L.polyline(line, { color: '#2A6BB3', weight: 2, opacity: 0.85 }).addTo(layer);
      for (const p of list) {
        const outside = p.geofence === 'outside';
        L.circleMarker([p.latitude, p.longitude], {
          radius: outside ? 5 : 3,
          color: '#fff',
          weight: outside ? 2 : 1,
          fillColor: outside ? '#B3261E' : '#2A6BB3',
          fillOpacity: 1,
        })
          .addTo(layer)
          .bindTooltip(
            `${new Date(p.recorded_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` +
              ` - ${p.distance_m ?? '?'} m from post${outside ? ' (outside)' : ''}` +
              (p.source !== 'watch' ? ` - ${String(p.source).replace('_', ' ')}` : '')
          );
      }
      const first = list[0];
      const last = list[list.length - 1];
      L.marker([first.latitude, first.longitude], { icon: pinIcon(L, '#1E7A45', 'S', 22) })
        .addTo(layer)
        .bindTooltip('Start');
      L.marker([last.latitude, last.longitude], { icon: pinIcon(L, '#062E58', 'E', 22) })
        .addTo(layer)
        .bindTooltip('Latest / end');
    }

    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
  }, [ready, pings, entries]);

  return (
    <div>
      <div
        ref={containerRef}
        role="group"
        aria-label="Map of the officer's GPS trail. The same readings are listed beside it."
        style={{ height, borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'var(--surface-3)', zIndex: 0 }}
      />
      {error && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------- position map -- */

/** You, your post, its geofence, and the straight line between you and it. */
export function PositionMap({ me, post, height = 240 }) {
  const containerRef = useRef(null);
  const layerRef = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);

  const { ready, error } = useMap(containerRef, {
    onReady: (map, L) => {
      mapRef.current = map;
      leafletRef.current = L;
      layerRef.current = L.layerGroup().addTo(map);
    },
  });

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;
    layer.clearLayers();
    const bounds = [];

    if (post?.latitude != null) {
      bounds.push([post.latitude, post.longitude]);
      L.circle([post.latitude, post.longitude], {
        radius: post.radius_m || 150,
        color: '#0C3F72',
        fillColor: '#0C3F72',
        fillOpacity: 0.1,
        weight: 1.5,
      }).addTo(layer);
      L.marker([post.latitude, post.longitude], { icon: pinIcon(L, '#062E58', 'P') })
        .addTo(layer)
        .bindTooltip(esc(post.post_name || 'Your post'));
    }
    if (me?.latitude != null) {
      bounds.push([me.latitude, me.longitude]);
      if (me.accuracy) {
        L.circle([me.latitude, me.longitude], { radius: me.accuracy, weight: 0, color: '#2A6BB3', fillOpacity: 0.15, interactive: false }).addTo(layer);
      }
      L.circleMarker([me.latitude, me.longitude], {
        radius: 8,
        color: '#fff',
        weight: 3,
        fillColor: '#2A6BB3',
        fillOpacity: 1,
      })
        .addTo(layer)
        .bindTooltip('You are here');
      if (post?.latitude != null) {
        L.polyline(
          [
            [me.latitude, me.longitude],
            [post.latitude, post.longitude],
          ],
          { color: '#4A4A4A', weight: 2, dashArray: '5 6' }
        ).addTo(layer);
      }
    }
    if (bounds.length === 1) map.setView(bounds[0], 16);
    else if (bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
  }, [ready, me?.latitude, me?.longitude, me?.accuracy, post?.latitude, post?.longitude, post?.radius_m, post?.post_name]);

  return (
    <div>
      <div
        ref={containerRef}
        role="group"
        aria-label="Map showing your position and your assigned post. The distance is also written above."
        style={{ height, borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'var(--surface-3)', zIndex: 0 }}
      />
      {error && <div className="tiny" style={{ color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}
