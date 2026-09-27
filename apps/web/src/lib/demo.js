import { useEffect, useState } from 'react';

/**
 * Whether this deployment is the self-contained demo (the API reports it on
 * /api/health). Asked once per page load and shared by everything that cares.
 */
let asked = null;
const ask = () =>
  (asked ??= fetch('/api/health')
    .then((r) => r.json())
    .then((d) => Boolean(d.demo))
    .catch(() => false));

export function useDemo() {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    let alive = true;
    ask().then((v) => alive && setDemo(v));
    return () => {
      alive = false;
    };
  }, []);
  return demo;
}
