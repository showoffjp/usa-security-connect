import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Banner, Icon, LoadingPage, useToast } from '../../components/ui.jsx';

/** What a checkpoint's QR encodes: its own tag ID if it has one, otherwise its checkpoint code. */
export const tagValue = (c) => (c.qr_code || c.nfc_tag_id || `USC-CP-${c.id}`).trim();

/**
 * One printable QR tag per checkpoint on a tour, to stick up where the
 * officer has to stand. Scanning it with the officer app records the
 * checkpoint; the code is printed underneath for a phone without a camera
 * scanner.
 */
export default function TourTagsPage() {
  const { id } = useParams();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [svgs, setSvgs] = useState({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.get(`/admin/tours/${id}`), api.get('/admin/tours')]).then(
      ([detail, list]) => {
        if (!alive) return;
        const summary = list.tours.find((t) => String(t.id) === String(id));
        setData({ ...detail, siteName: summary?.site_name || '' });
      },
      (err) => {
        toast.error(err.message);
        alive && setFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [id, toast]);

  useEffect(() => {
    if (!data) return undefined;
    let alive = true;
    // Loaded only here, so the rest of the app never pays for the encoder.
    import('qrcode').then(async ({ default: QRCode }) => {
      const out = {};
      for (const c of data.checkpoints) {
        out[c.id] = await QRCode.toString(tagValue(c), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      }
      if (alive) setSvgs(out);
    });
    return () => {
      alive = false;
    };
  }, [data]);

  if (failed) {
    return (
      <div className="page">
        <Banner kind="danger" title="Tour not found">
          <Link to="/admin/tours?tab=templates">Back to tours</Link>
        </Banner>
      </div>
    );
  }
  if (!data) return <LoadingPage label="Loading tour" />;

  return (
    <div className="page stack">
      <div className="page-head no-print" style={{ marginBottom: 0 }}>
        <div className="eyebrow">
          <Link to="/admin/tours?tab=templates">Tours</Link>
        </div>
        <h1>Checkpoint tags: {data.tour.name}</h1>
        <p className="lead">
          {data.siteName ? `${data.siteName}. ` : ''}Print these, laminate them and fix each one where the officer has to
          stand. Scanning a tag in the officer app records that checkpoint on the tour.
        </p>
      </div>
      <div className="row wrap no-print" style={{ gap: 10 }}>
        <button className="btn btn-primary" onClick={() => window.print()} disabled={!Object.keys(svgs).length}>
          <Icon name="print" size={16} /> Print tags
        </button>
        <span className="small muted">
          {data.checkpoints.length} checkpoint{data.checkpoints.length === 1 ? '' : 's'}, in walking order
        </span>
      </div>
      <div className="tag-sheet">
        {data.checkpoints.map((c, i) => (
          <article key={c.id} className="qr-tag" aria-label={`Tag for ${c.name}`}>
            <div className="qr-brand">USA Security Connect</div>
            <div
              className="qr-img"
              role="img"
              aria-label={`QR code ${tagValue(c)}`}
              // The SVG comes from the qrcode encoder, from our own tag value.
              dangerouslySetInnerHTML={{ __html: svgs[c.id] || '' }}
            />
            <div className="qr-name">
              {i + 1}. {c.name}
            </div>
            <div className="qr-meta">
              {data.tour.name}
              {data.siteName ? ` · ${data.siteName}` : ''}
            </div>
            <div className="qr-code">{tagValue(c)}</div>
          </article>
        ))}
      </div>
    </div>
  );
}
