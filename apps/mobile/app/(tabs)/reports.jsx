import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, Pressable } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { api } from '../../src/api.js';
import { useAuth } from '../../src/auth.jsx';
import { fmtDateTime, fmtMoney } from '../../src/format.js';
import {
  Card, Chip, StatusChip, Button, Empty, Loading, Sheet, KeyValue, Toast, useToastState,
} from '../../src/ui.jsx';
import { C, S } from '../../src/theme.js';

export default function ReportsScreen() {
  const router = useRouter();
  const { isSupervisor } = useAuth();
  const [toast, setToast] = useToastState();
  const [incidents, setIncidents] = useState(null);
  const [detail, setDetail] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setIncidents((await api.get('/incidents')).incidents);
    } catch (err) {
      setToast({ message: err.message, tone: 'err' });
      setIncidents([]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const open = async (id) => {
    try {
      setDetail(await api.get(`/incidents/${id}`));
    } catch (err) {
      setToast({ message: err.message, tone: 'err' });
    }
  };

  if (!incidents) return <Loading label="Loading your reports" />;

  return (
    <View style={S.screen}>
      <ScrollView
        contentContainerStyle={S.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.brand600} />
        }
      >
        <View>
          <Text style={S.eyebrow}>Documentation</Text>
          <Text style={S.h1}>My reports</Text>
        </View>

        <Button title="Report an incident" variant="primary" onPress={() => router.push('/incident-new')} />

        {isSupervisor && (
          <Button title="Log a supervisor visit" variant="navy" onPress={() => router.push('/supervisor-visit')} />
        )}

        <Card>
          {incidents.length === 0 ? (
            <Empty title="No reports filed">
              Anything out of the ordinary on post belongs in a report.
            </Empty>
          ) : (
            incidents.map((i, idx) => (
              <Pressable
                key={i.id}
                onPress={() => open(i.id)}
                style={[S.listItem, idx === incidents.length - 1 && { borderBottomWidth: 0 }]}
              >
                <View style={S.grow}>
                  <View style={S.row}>
                    <Text style={[S.small, S.strong]}>{i.ref_number}</Text>
                    <StatusChip value={i.status} />
                  </View>
                  <Text style={S.tiny} numberOfLines={1}>
                    {i.category ? `${i.category} - ` : ''}
                    {i.location_text || i.site_name}
                  </Text>
                  <Text style={S.tiny}>{fmtDateTime(i.occurred_at)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <StatusChip value={i.severity} />
                  {i.photo_count > 0 && <Text style={S.tiny}>{i.photo_count} photo(s)</Text>}
                </View>
              </Pressable>
            ))
          )}
        </Card>
      </ScrollView>

      <Sheet
        visible={!!detail}
        title={detail?.incident?.ref_number || ''}
        onClose={() => setDetail(null)}
      >
        {!!detail && (
          <>
            <View style={[S.row, S.wrap]}>
              <StatusChip value={detail.incident.status} />
              <StatusChip value={detail.incident.severity} />
              {!!detail.incident.category && <Chip tone="navy">{detail.incident.category}</Chip>}
              {!!detail.incident.police_notified && <Chip tone="info">Police notified</Chip>}
            </View>

            <KeyValue
              rows={[
                ['Occurred', fmtDateTime(detail.incident.occurred_at)],
                ['Location', detail.incident.location_text || '--'],
                ['Site', detail.incident.site_name || '--'],
                detail.incident.cost_recovery_cents != null && [
                  'Cost recovery',
                  fmtMoney(detail.incident.cost_recovery_cents),
                ],
              ]}
            />

            <View>
              <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6, marginBottom: 4 }]}>
                WHAT HAPPENED
              </Text>
              <Text style={[S.text, { lineHeight: 21 }]}>{detail.incident.what_happened}</Text>
            </View>

            {!!detail.incident.resolution && (
              <View>
                <Text style={[S.tiny, { fontWeight: '800', letterSpacing: 0.6, marginBottom: 4 }]}>
                  HOW IT WAS RESOLVED
                </Text>
                <Text style={[S.text, { lineHeight: 21 }]}>{detail.incident.resolution}</Text>
              </View>
            )}

            {!!detail.incident.review_notes && (
              <View style={{ backgroundColor: C.infoBg, borderRadius: 10, padding: 12 }}>
                <Text style={[S.tiny, { fontWeight: '800', color: '#10456F' }]}>
                  SUPERVISOR REVIEW - {detail.incident.reviewed_by_name}
                </Text>
                <Text style={[S.small, { color: '#10456F', marginTop: 3 }]}>
                  {detail.incident.review_notes}
                </Text>
              </View>
            )}
          </>
        )}
      </Sheet>

      <Toast toast={toast} />
    </View>
  );
}
