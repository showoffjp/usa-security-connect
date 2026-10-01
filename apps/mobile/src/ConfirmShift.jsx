import { useState } from 'react';
import { api } from './api.js';
import { Button, Chip } from './ui.jsx';

/**
 * "I'll be there" for one upcoming shift: a Confirmed chip once done, nothing
 * for a shift that cannot be confirmed yet (over a week out) or any more.
 */
export function ConfirmShift({ shift, notify, onConfirmed }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (shift.confirmed || done) return <Chip tone="ok">Confirmed</Chip>;
  if (!shift.confirmable) return null;

  const confirm = async () => {
    setBusy(true);
    try {
      await api.post(`/schedule/${shift.id}/confirm`, {});
      setDone(true);
      notify?.('Confirmed. Your supervisor can see you will be there.', 'ok');
      onConfirmed?.();
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return <Button variant="primary" title="Confirm I'll be there" onPress={confirm} busy={busy} style={{ paddingVertical: 8 }} />;
}
