import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDay, fmtRange } from './format.js';
import { Button, Card, Chip } from './ui.jsx';
import { C, S } from './theme.js';

/** Where an offer stands for the officer asked, in a line. The same as the web app's. */
function outcome(o) {
  if (o.state === 'filled' && o.mine) return ['ok', 'It is yours: on your schedule, and confirmed.'];
  if (o.state === 'filled' || o.state === 'covered') return ['plain', 'It went to somebody else. Thank you for saying yes.'];
  if (o.state === 'withdrawn') return ['plain', 'The supervisor no longer needs it covered.'];
  if (o.state === 'expired') return ['plain', 'The shift has started.'];
  if (o.answer === 'yes') return ['info', 'You said yes. A supervisor will confirm who gets it.'];
  if (o.answer === 'no') return ['plain', 'You said no.'];
  return null;
}

function Offer({ o, last, notify, onDone }) {
  const [busy, setBusy] = useState(false);
  const say = async (answer) => {
    setBusy(true);
    try {
      const r = await api.post(`/shift-offers/${o.id}/answer`, { answer });
      notify?.(
        r.result === 'assigned'
          ? 'The shift is yours. It is on your schedule.'
          : r.result === 'claimed'
            ? 'Thanks. A supervisor will confirm who gets it.'
            : 'Thanks for letting us know.',
        'ok'
      );
    } catch (err) {
      notify?.(err.message, 'err');
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const said = outcome(o);
  const open = o.state === 'open';
  return (
    <View style={[S.listItem, { flexDirection: 'column', alignItems: 'stretch', gap: 4 }, last && { borderBottomWidth: 0 }]}>
      <Text style={[S.small, S.strong]}>{`${o.post_name}, ${o.site_name}`}</Text>
      <Text style={S.small}>{`${fmtDay(o.starts_at)}, ${fmtRange(o.starts_at, o.ends_at)}${o.armed ? ' · armed post' : ''}`}</Text>
      {o.note ? <Text style={[S.tiny, S.muted]}>{`"${o.note}"${o.offered_by_name ? ` - ${o.offered_by_name}` : ''}`}</Text> : null}
      {open && !o.answer && (
        <Text style={[S.tiny, S.muted]}>
          {`${o.asked > 1 ? `Asked of ${o.asked} officers. ` : ''}${o.first_yes ? 'The first to say yes gets it.' : 'A supervisor will choose from those who say yes.'}`}
        </Text>
      )}
      {said && <Text style={[S.small, S.strong, { color: said[0] === 'ok' ? C.ok : said[0] === 'info' ? C.info : C.ink3 }]}>{said[1]}</Text>}
      {open && o.refusal ? <Text style={[S.tiny, { color: C.danger }]}>{`You cannot take it: ${o.refusal}`}</Text> : null}
      {open && o.answer !== 'yes' && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          {o.can_say_yes && (
            <Button variant="primary" title={o.answer === 'no' ? 'Yes after all' : 'Yes, I can'} onPress={() => say('yes')} busy={busy} style={{ flex: 1, paddingVertical: 8 }} />
          )}
          {!o.answer && <Button title="No" onPress={() => say('no')} disabled={busy} style={{ flex: 1, paddingVertical: 8 }} />}
        </View>
      )}
    </View>
  );
}

/**
 * "Can you cover?": open shifts a supervisor has asked this officer about,
 * answered with a tap, and how the ones they said yes to turned out.
 */
export function ShiftOffersCard({ notify, refreshKey }) {
  const [offers, setOffers] = useState([]);
  const load = useCallback(() => {
    api.get('/shift-offers/mine').then(
      (d) => setOffers(d.offers || []),
      () => setOffers([])
    );
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  if (!offers.length) return null;
  const waiting = offers.filter((o) => o.state === 'open' && !o.answer).length;
  return (
    <Card title="Can you cover?" right={waiting ? <Chip tone="warn">{`${waiting} to answer`}</Chip> : null}>
      {offers.map((o, i) => (
        <Offer key={o.id} o={o} last={i === offers.length - 1} notify={notify} onDone={load} />
      ))}
    </Card>
  );
}
