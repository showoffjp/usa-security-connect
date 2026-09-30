import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDay, fmtRelative } from './format.js';
import { Banner, Button, Card, Chip } from './ui.jsx';
import { C, S } from './theme.js';

/**
 * Post orders the officer has not yet acknowledged. When a supervisor
 * changes them, they lead the home screen until the officer confirms.
 */
function PostOrdersCard({ orders, onAcked, notify }) {
  const [busy, setBusy] = useState(false);
  if (!orders || orders.acked_at) return null;
  const ack = async () => {
    setBusy(true);
    try {
      const d = await api.post(`/post-log/orders/${orders.id}/ack`);
      notify('Post orders acknowledged.', 'ok');
      onAcked(d.orders);
    } catch (err) {
      notify(err.message, 'err');
      if (err.status === 409) onAcked(null, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ borderColor: '#F0D7AE', borderLeftWidth: 4, borderLeftColor: C.warn }}>
      <View style={S.cardPad}>
        <View style={S.rowBetween}>
          <Text style={[S.h3, { flex: 1 }]} accessibilityRole="header">
            {orders.version > 1 ? 'Your post orders have changed' : 'Read your post orders'}
          </Text>
          <Chip tone="warn">Unread</Chip>
        </View>
        <Text style={S.tiny}>
          Version {orders.version}
          {orders.author_name ? `, from ${orders.author_name}` : ''}, {fmtDay(orders.created_at)}
        </Text>
        {!!orders.change_note && orders.version > 1 && (
          <Banner tone="warn" title="What changed">
            {orders.change_note}
          </Banner>
        )}
        <Text style={[S.small, { lineHeight: 20 }]}>{orders.body}</Text>
        <Button title="I have read these orders" variant="primary" onPress={ack} busy={busy} />
      </View>
    </Card>
  );
}

/** Notes the last shift left for this post, acknowledged one at a time. */
function PassdownCard({ notes, onAcked, notify }) {
  const [busy, setBusy] = useState(null);
  const unread = notes.filter((n) => !n.mine && !n.acked_at);
  if (!unread.length) return null;
  const ack = async (n) => {
    setBusy(n.id);
    try {
      await api.post(`/post-log/passdown/${n.id}/ack`);
      onAcked(n.id);
    } catch (err) {
      notify(err.message, 'err');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Pass-down" right={<Chip tone={unread.some((n) => n.priority === 'important') ? 'danger' : 'warn'}>{unread.length} new</Chip>}>
      {unread.map((n, i) => (
        <View
          key={n.id}
          style={[S.cardPad, { gap: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}
        >
          <View style={[S.row, { gap: 8, flexWrap: 'wrap' }]}>
            {n.priority === 'important' && <Chip tone="danger">Important</Chip>}
            <Text style={S.tiny}>
              {n.author_name || 'Previous shift'} · {fmtRelative(n.created_at)}
            </Text>
          </View>
          <Text style={[S.small, { lineHeight: 20 }]}>{n.body}</Text>
          <Button title="Got it" onPress={() => ack(n)} busy={busy === n.id} />
        </View>
      ))}
    </Card>
  );
}

/** Who to call at this site, a tap away. */
function SiteContactsCard({ site }) {
  if (!site?.post || !site.contacts?.length) return null;
  return (
    <Card title="Site contacts" right={<Text style={[S.small, S.muted]}>{site.post.site_name}</Text>}>
      {site.contacts.map((c, i) => (
        <View
          key={c.id}
          style={[S.rowBetween, { paddingHorizontal: 16, paddingVertical: 12, gap: 10 }, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}
        >
          <View style={S.grow}>
            <Text style={[S.small, S.strong, { color: C.ink }]}>{c.name}</Text>
            <Text style={S.tiny}>
              {c.role}
              {c.after_hours ? ' · after hours' : ''}
            </Text>
          </View>
          {!!c.phone && (
            <Pressable
              onPress={() => Linking.openURL(`tel:${c.phone.replace(/[^\d+]/g, '')}`)}
              accessibilityRole="button"
              accessibilityLabel={`Call ${c.name}, ${c.phone}`}
              style={({ pressed }) => ({
                paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
                backgroundColor: pressed ? C.navy100 : C.surface3,
              })}
            >
              <Text style={[S.small, S.strong, { color: C.navy700 }]}>{c.phone}</Text>
            </Pressable>
          )}
        </View>
      ))}
    </Card>
  );
}

/**
 * The post log's home-screen cards: changed orders first, then unread
 * pass-down, with the site's contacts further down. `refreshKey` reloads
 * them on pull-to-refresh and when duty state changes.
 */
export function usePostLog(refreshKey) {
  const [log, setLog] = useState(null);
  const [site, setSite] = useState(null);
  const load = useCallback(async () => {
    const [l, s] = await Promise.allSettled([api.get('/post-log'), api.get('/post-log/site')]);
    if (l.status === 'fulfilled') setLog(l.value);
    if (s.status === 'fulfilled') setSite(s.value);
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  return { log, site, setLog, reload: load };
}

export function PostLogCards({ postLog, notify }) {
  const { log, setLog, reload } = postLog;
  if (!log?.post) return null;
  return (
    <>
      <PostOrdersCard
        orders={log.orders}
        notify={notify}
        onAcked={(orders, stale) => (stale ? reload() : setLog((l) => ({ ...l, orders })))}
      />
      <PassdownCard
        notes={log.passdown || []}
        notify={notify}
        onAcked={(id) =>
          setLog((l) => ({
            ...l,
            passdown: l.passdown.map((n) => (n.id === id ? { ...n, acked_at: new Date().toISOString() } : n)),
          }))
        }
      />
    </>
  );
}

export { SiteContactsCard };
