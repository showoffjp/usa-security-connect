import { useEffect, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { api } from './api.js';
import { fmtTime } from './format.js';
import { Card, Chip, Button } from './ui.jsx';
import { C, S } from './theme.js';
import { locationOffset, formatDistance, RULES } from './shared.js';

/**
 * Where you are against where you should be.
 *
 * The phone's position is watched while the home screen is open. On duty it
 * is sent to dispatch at the ping cadence, which feeds the supervisor's live
 * board and the shift's GPS trail. Off duty nothing is sent - the comparison
 * with the next post happens on the phone.
 *
 * Foreground only: tracking with the app closed needs background location,
 * which both stores review closely and which a guard force should decide on
 * deliberately. See apps/mobile/BUILDING.md.
 */
export function LocationCard({ status }) {
  const [fix, setFix] = useState(null);
  const [problem, setProblem] = useState('');
  const [lastSent, setLastSent] = useState(null);
  const fixRef = useRef(null);

  const onDuty = Boolean(status?.onDuty);
  const source = onDuty ? status?.entry : status?.shift || status?.nextShift;
  const target = source && source.post_lat != null
    ? {
        name: source.post_name,
        site: source.site_name,
        latitude: source.post_lat,
        longitude: source.post_lng,
        radius: source.geofence_radius_m,
      }
    : null;

  useEffect(() => {
    let sub = null;
    let cancelled = false;
    (async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setProblem('Location permission is off. Turn it on so dispatch can see you are on post.');
        return;
      }
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 15000, distanceInterval: 10 },
        (pos) => {
          if (cancelled) return;
          const next = {
            latitude: Number(pos.coords.latitude.toFixed(6)),
            longitude: Number(pos.coords.longitude.toFixed(6)),
            accuracy: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
            speed: pos.coords.speed ?? null,
            heading: pos.coords.heading ?? null,
            at: new Date(pos.timestamp),
          };
          fixRef.current = next;
          setFix(next);
          setProblem('');
        }
      );
    })().catch((err) => setProblem(err.message || 'Location is unavailable.'));
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  useEffect(() => {
    if (!onDuty) return undefined;
    let alive = true;
    const send = async () => {
      const f = fixRef.current;
      if (!f) return;
      try {
        const res = await api.post('/timeclock/location', {
          latitude: f.latitude,
          longitude: f.longitude,
          accuracy: f.accuracy,
          speed: f.speed,
          heading: f.heading,
        });
        if (alive && res.recorded) setLastSent(new Date());
      } catch {
        /* the next report follows */
      }
    };
    const first = setTimeout(send, 2000);
    const t = setInterval(send, (status?.rules?.locationPingSeconds || RULES.locationPingSeconds) * 1000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [onDuty, status?.rules?.locationPingSeconds]);

  if (!target && !problem) return null;

  const offset =
    fix && target
      ? locationOffset({
          lat: fix.latitude,
          lng: fix.longitude,
          accuracy: fix.accuracy,
          post: { latitude: target.latitude, longitude: target.longitude, geofence_radius_m: target.radius },
        })
      : null;
  const inside = offset?.status === 'inside';
  const outside = offset?.status === 'outside';
  const tone = inside ? { bg: C.okBg, fg: C.ok } : outside && onDuty ? { bg: C.dangerBg, fg: C.danger } : { bg: C.infoBg, fg: C.info };

  return (
    <Card
      title={onDuty ? 'You vs your post' : 'You vs your next post'}
      right={onDuty ? <Chip tone={lastSent ? 'ok' : 'plain'}>{lastSent ? `Shared ${fmtTime(lastSent)}` : 'Sharing on'}</Chip> : null}
    >
      <View style={[S.cardPad, { gap: 10 }]}>
        {problem ? <Text style={[S.small, { color: C.warn }]}>{problem}</Text> : null}
        {target && (
          <View>
            <Text style={[S.small, { fontWeight: '600' }]}>{target.name}</Text>
            <Text style={[S.small, S.muted]}>{target.site}</Text>
          </View>
        )}
        {fix ? (
          <Text style={[S.small, S.muted]}>
            You: {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
            {fix.accuracy != null ? ` (±${fix.accuracy} m)` : ''} at {fmtTime(fix.at)}
          </Text>
        ) : (
          !problem && <Text style={[S.small, S.muted]}>Finding you...</Text>
        )}
        {offset && offset.distance != null && (
          <View style={{ backgroundColor: tone.bg, borderRadius: 10, padding: 10 }}>
            <Text style={[S.small, { color: tone.fg, fontWeight: '600' }]}>
              {inside
                ? `Inside the geofence - ${formatDistance(offset.distance)} from the post.`
                : offset.status === 'unverified'
                  ? `GPS too weak to verify (±${offset.accuracy} m).`
                  : `${formatDistance(offset.distance)} from your post${offset.heading ? `, head ${offset.heading}` : ''}.`}
            </Text>
            {outside && onDuty && (
              <Text style={[S.small, { color: tone.fg }]}>Dispatch can see you are outside. Return to post or radio in.</Text>
            )}
          </View>
        )}
        {target && (
          <Button
            title="Directions to post"
            onPress={() =>
              Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target.latitude},${target.longitude}`)
            }
          />
        )}
        <Text style={[S.small, S.muted, { fontSize: 11.5 }]}>
          {onDuty
            ? 'Your position is shared with dispatch about once a minute while you are clocked in.'
            : 'Off the clock, your position stays on this phone.'}
        </Text>
      </View>
    </Card>
  );
}
