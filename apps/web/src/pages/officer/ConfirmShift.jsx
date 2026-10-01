import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Chip, Icon, useToast } from '../../components/ui.jsx';

/**
 * "I'll be there" for one upcoming shift. Shows as a Confirmed chip once
 * done, and as nothing at all for a shift that cannot be confirmed yet
 * (more than a week out) or any more (started, cancelled).
 */
export default function ConfirmShift({ shift, onConfirmed, block = false }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (shift.confirmed || done) {
    return (
      <Chip kind="ok">
        <Icon name="check" size={12} /> Confirmed
      </Chip>
    );
  }
  if (!shift.confirmable) return null;

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/schedule/${shift.id}/confirm`, {});
      setDone(true);
      toast.success('Confirmed. Your supervisor can see you will be there.');
      onConfirmed?.(r.shift);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`btn btn-primary btn-sm${block ? ' btn-block' : ''}`}
      onClick={confirm}
      disabled={busy}
      aria-label={`Confirm your shift at ${shift.post_name}`}
    >
      <Icon name="check" size={14} /> {busy ? 'Confirming...' : "Confirm I'll be there"}
    </button>
  );
}
