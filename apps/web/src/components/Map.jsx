import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, Field, Spinner, useToast } from './ui.jsx';

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

/**
 * Pick a post's exact location: search an address, drop a pin, drag it, or use
 * the browser's own position. The circle shows the geofence the officer will
 * have to be standing inside to clock in.
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
          onChange?.({ latitude: Number(pos.lat.toFixed(6)), longitude: Number(pos.lng.toFixed(6)) });
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

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error('This browser cannot report its location.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        onChange?.({
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
        }),
      () => toast.error('Could not get your location.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <div className="stack-sm">
      <form onSubmit={search} className="row">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search an address, e.g. 1200 Riverside Ave, Jacksonville FL"
          className="grow"
        />
        <button type="submit" className="btn btn-navy btn-sm" disabled={searching}>
          {searching ? <Spinner /> : <Icon name="search" size={15} />}
          Find
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={useMyLocation} title="Use my current location">
          <Icon name="pin" size={15} />
        </button>
      </form>

      {results.length > 0 && (
        <div className="card" style={{ maxHeight: 150, overflowY: 'auto' }}>
          <div className="list">
            {results.map((r, i) => (
              <button
                key={i}
                type="button"
                className="list-item"
                onClick={() => {
                  onChange?.({ latitude: r.latitude, longitude: r.longitude, label: r.label });
                  place(r.latitude, r.longitude);
                  setResults([]);
                  setQuery('');
                }}
              >
                <Icon name="pin" size={15} />
                <span className="small grow">{r.label}</span>
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
          `<strong>${post.name}</strong><br/>${post.site_name}<br/>` +
            (staffed.length
              ? `<span style="color:#1E8E4E">On post: ${staffed.map((s) => s.officer).join(', ')}</span>`
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
          `<strong>${officer.officer}</strong><br/>${officer.post_name}<br/>` +
            `Clocked in ${new Date(officer.clock_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` +
            (outside ? `<br/><span style="color:#B26A00">Clocked in ${officer.clock_in_distance_m}m away</span>` : '') +
            (officer.phone ? `<br/><a href="tel:${officer.phone}">${officer.phone}</a>` : '')
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
          `<strong style="color:#C0392B">DURESS ALERT</strong><br/>${alert.officer}<br/>` +
            (alert.phone ? `<a href="tel:${alert.phone}">${alert.phone}</a><br/>` : '') +
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
      L.marker([latitude, longitude]).addTo(map).bindPopup(label || 'Location');
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
