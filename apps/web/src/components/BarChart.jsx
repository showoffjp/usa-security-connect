import { useMemo, useState } from 'react';

/**
 * One measure, one hue. Ranked horizontal bars for "who / where", columns in
 * date order for "when". Every value is also in the table under the chart, so
 * the chart is for seeing the shape, not for reading exact numbers.
 *
 * #2a6bb3 is used rather than the brand navy: navy is too dark to sit inside
 * the lightness band a data mark needs against white (checked with the
 * palette validator), and this is the nearest step that passes.
 */
const MARK = '#2a6bb3';
const MARK_HOVER = '#1d5796';

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div
      role="status"
      style={{
        position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(-50%, calc(-100% - 8px))',
        background: 'var(--navy-900)', color: '#fff', padding: '6px 9px', borderRadius: 6,
        fontSize: '0.76rem', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 5, boxShadow: 'var(--shadow-2)',
      }}
    >
      <div style={{ fontWeight: 650 }}>{tip.label}</div>
      <div>{tip.value}</div>
    </div>
  );
}

/** Ranked bars: the top `limit` rows, largest first. */
export function RankedBars({ data, format, limit = 12, title }) {
  const [tip, setTip] = useState(null);
  const rows = useMemo(() => [...data].sort((a, b) => b.value - a.value).slice(0, limit), [data, limit]);
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;

  if (!rows.length) return null;
  return (
    <figure style={{ margin: 0, position: 'relative' }} aria-label={title}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 200px) 1fr', rowGap: 6, columnGap: 12, alignItems: 'center' }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'contents' }}>
            <div className="small truncate" title={r.label} style={{ color: 'var(--ink-3)', textAlign: 'right' }}>
              {r.label}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div
                role="img"
                tabIndex={0}
                aria-label={`${r.label}: ${format(r.value)}`}
                onMouseEnter={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const host = e.currentTarget.closest('figure').getBoundingClientRect();
                  setTip({ x: box.right - host.left, y: box.top - host.top, label: r.label, value: format(r.value) });
                }}
                onFocus={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const host = e.currentTarget.closest('figure').getBoundingClientRect();
                  setTip({ x: box.right - host.left, y: box.top - host.top, label: r.label, value: format(r.value) });
                }}
                onMouseLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
                style={{
                  height: 16,
                  width: `${Math.max(1, (r.value / max) * 100)}%`,
                  maxWidth: 'calc(100% - 70px)',
                  background: tip?.label === r.label ? MARK_HOVER : MARK,
                  // Square at the baseline, rounded at the data end.
                  borderRadius: '0 4px 4px 0',
                  cursor: 'default',
                }}
              />
              <span className="tiny strong nowrap" style={{ color: 'var(--ink-2)' }}>
                {format(r.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <Tooltip tip={tip} />
    </figure>
  );
}

/** Columns in date order, with three recessive gridlines and the peak labelled. */
export function TimeColumns({ data, format, title }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(...data.map((d) => d.value), 0);
  const top = niceCeil(max);
  const peak = data.reduce((best, d) => (d.value > (best?.value ?? -1) ? d : best), null);
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  if (!data.length) return null;
  return (
    <figure style={{ margin: 0, position: 'relative' }} aria-label={title}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          aria-hidden="true"
          className="tiny muted"
          style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: 180, textAlign: 'right', minWidth: 34 }}
        >
          <span>{format(top)}</span>
          <span>{format(top / 2)}</span>
          <span>0</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ position: 'relative', height: 180 }}>
            {[0, 0.5, 1].map((f) => (
              <div
                key={f}
                aria-hidden="true"
                style={{ position: 'absolute', left: 0, right: 0, top: `${f * 100}%`, borderTop: '1px solid var(--line)' }}
              />
            ))}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
              {data.map((d) => (
                <div key={d.label} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', position: 'relative' }}>
                  {d === peak && d.value > 0 && (
                    <span
                      className="tiny strong nowrap"
                      style={{ position: 'absolute', bottom: `calc(${(d.value / (top || 1)) * 100}% + 3px)`, color: 'var(--ink-2)' }}
                    >
                      {format(d.value)}
                    </span>
                  )}
                  <div
                    role="img"
                tabIndex={0}
                    aria-label={`${d.label}: ${format(d.value)}`}
                    onMouseEnter={(e) => {
                      const box = e.currentTarget.getBoundingClientRect();
                      const host = e.currentTarget.closest('figure').getBoundingClientRect();
                      setTip({ x: box.left + box.width / 2 - host.left, y: box.top - host.top, label: d.label, value: format(d.value) });
                    }}
                    onFocus={(e) => {
                      const box = e.currentTarget.getBoundingClientRect();
                      const host = e.currentTarget.closest('figure').getBoundingClientRect();
                      setTip({ x: box.left + box.width / 2 - host.left, y: box.top - host.top, label: d.label, value: format(d.value) });
                    }}
                    onMouseLeave={() => setTip(null)}
                    onBlur={() => setTip(null)}
                    style={{
                      width: '100%',
                      maxWidth: 24,
                      height: `${top ? (d.value / top) * 100 : 0}%`,
                      minHeight: d.value > 0 ? 2 : 0,
                      background: tip?.label === d.label ? MARK_HOVER : MARK,
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden="true" style={{ display: 'flex', gap: 2, marginTop: 4 }}>
            {data.map((d, i) => (
              <div key={d.label} className="tiny muted" style={{ flex: 1, textAlign: 'center', overflow: 'visible', whiteSpace: 'nowrap' }}>
                {i % labelEvery === 0 ? d.short || d.label : ''}
              </div>
            ))}
          </div>
        </div>
      </div>
      <Tooltip tip={tip} />
    </figure>
  );
}

function niceCeil(value) {
  if (value <= 0) return 0;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * exp;
}
