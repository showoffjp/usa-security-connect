import { useEffect, useState } from 'react';
import { api, clientApi } from '../lib/api.js';

/**
 * An image that sits behind authentication.
 *
 * Incident photos are served by the API rather than handed out as storage
 * URLs, so they need a bearer token - and an `<img src>` cannot carry one.
 * The bytes are fetched and handed to the browser as an object URL instead.
 *
 * Pass `client` for the client portal, which holds its own token.
 */
export function AuthedImage({ src, alt, client = false, onClick, style }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;

    setUrl(null);
    setFailed(false);

    (client ? clientApi : api)
      .get(src, { raw: true })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, client]);

  if (failed) {
    return (
      <div className="tiny muted" style={{ padding: 8, ...style }}>
        Photo unavailable
      </div>
    );
  }
  if (!url) {
    return (
      <div className="tiny muted" style={{ padding: 8, ...style }}>
        Loading...
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      onClick={onClick ? () => onClick(url) : undefined}
      style={onClick ? { cursor: 'zoom-in', ...style } : style}
    />
  );
}
