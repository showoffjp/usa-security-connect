import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Image, PanResponder, Pressable, Text, View, Modal as RNModal,
  ScrollView, TextInput,
} from 'react-native';
import { C, S, chipTone } from './theme.js';

/* ------------------------------------------------------------------ mark -- */

/**
 * The Chrome Guardian mark, rendered from the same drawing as the web app's
 * (web/tools/make-icons.mjs writes assets/shield.png). Sized by height.
 */
const SHIELD = require('../assets/shield.png');
export function Shield({ size = 34 }) {
  const h = Math.round(size * 1.15);
  return <Image source={SHIELD} style={{ width: Math.round((h * 420) / 480), height: h }} resizeMode="contain" accessibilityLabel="USA Security Connect" />;
}

/* ----------------------------------------------------------- primitives -- */

export function Chip({ tone = 'plain', children }) {
  const t = chipTone[tone] || chipTone.plain;
  return (
    <View style={[S.chip, { backgroundColor: t.bg }]}>
      <Text style={[S.chipText, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

const STATUS_TONES = {
  inside: ['ok', 'In geofence'],
  outside: ['danger', 'Outside geofence'],
  unverified: ['warn', 'GPS unverified'],
  no_fix: ['warn', 'No GPS fix'],
  not_configured: ['plain', 'No geofence'],
  ok: ['ok', 'On time'],
  late: ['warn', 'Late'],
  missed: ['danger', 'Missed'],
  pending: ['plain', 'Pending'],
  scheduled: ['info', 'Scheduled'],
  in_progress: ['brand', 'In progress'],
  completed: ['ok', 'Completed'],
  completed_with_skips: ['warn', 'Completed, skips'],
  abandoned: ['danger', 'Abandoned'],
  submitted: ['info', 'Submitted'],
  under_review: ['warn', 'Under review'],
  closed: ['ok', 'Closed'],
  low: ['plain', 'Low'],
  medium: ['info', 'Medium'],
  high: ['warn', 'High'],
  critical: ['danger', 'Critical'],
  urgent: ['danger', 'Urgent'],
  important: ['warn', 'Important'],
  normal: ['plain', 'Normal'],
  done: ['ok', 'Done'],
  skipped: ['warn', 'Skipped'],
  active: ['ok', 'Active'],
};

export function StatusChip({ value }) {
  const [tone, label] = STATUS_TONES[value] || ['plain', value || '--'];
  return <Chip tone={tone}>{label}</Chip>;
}

export function Button({ title, onPress, variant = 'default', disabled, busy, style }) {
  const variantStyle = {
    primary: S.btnPrimary,
    navy: S.btnNavy,
    ghost: S.btnGhost,
    danger: S.btnDanger,
  }[variant];
  const onBrand = ['primary', 'navy', 'danger'].includes(variant);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        S.btn,
        variantStyle,
        (disabled || busy) && S.btnDisabled,
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      {busy && <ActivityIndicator size="small" color={onBrand ? '#fff' : C.brand600} />}
      <Text style={onBrand ? S.btnTextOn : S.btnText}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, error, hint, required, children }) {
  return (
    <View>
      {!!label && (
        <Text style={S.label}>
          {label}
          {required && <Text style={{ color: C.brand600 }}> *</Text>}
        </Text>
      )}
      {children}
      {!!hint && !error && <Text style={S.hint}>{hint}</Text>}
      {!!error && <Text style={S.errorText}>{error}</Text>}
    </View>
  );
}

export function Input({ error, style, ...props }) {
  return (
    <TextInput
      placeholderTextColor={C.muted}
      style={[S.input, error && S.inputError, style]}
      {...props}
    />
  );
}

export function Banner({ tone = 'info', title, children }) {
  const map = {
    info: [C.infoBg, '#C2DCF0', '#10456F'],
    warn: [C.warnBg, '#F0D7AE', '#7A4A00'],
    danger: [C.dangerBg, '#F3C9C3', '#8F2A20'],
    ok: [C.okBg, '#B9E8CE', '#10633A'],
  };
  const [bg, border, fg] = map[tone] || map.info;
  return (
    <View style={[S.banner, { backgroundColor: bg, borderColor: border }]}>
      <View style={S.grow}>
        {!!title && <Text style={{ fontWeight: '700', color: fg, marginBottom: 2 }}>{title}</Text>}
        {typeof children === 'string' ? (
          <Text style={{ color: fg, fontSize: 13.5, lineHeight: 19 }}>{children}</Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

export function Card({ title, right, children, style }) {
  return (
    <View style={[S.card, style]}>
      {(title || right) && (
        <View style={S.cardHead}>
          <Text style={S.h3}>{title}</Text>
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function KeyValue({ rows }) {
  return (
    <View style={{ gap: 8 }}>
      {rows
        .filter(Boolean)
        .map(([k, v], i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
            <Text style={[S.small, S.muted, { width: 116 }]}>{k}</Text>
            <View style={S.grow}>
              {typeof v === 'string' || typeof v === 'number' ? (
                <Text style={[S.small, { fontWeight: '500' }]}>{v}</Text>
              ) : (
                v
              )}
            </View>
          </View>
        ))}
    </View>
  );
}

export function Empty({ title, children }) {
  return (
    <View style={{ padding: 36, alignItems: 'center', gap: 6 }}>
      <Text style={[S.h3, { color: C.ink3 }]}>{title}</Text>
      {!!children && <Text style={[S.small, S.muted, { textAlign: 'center' }]}>{children}</Text>}
    </View>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 40 }}>
      <ActivityIndicator color={C.brand600} />
      <Text style={[S.small, S.muted]}>{label}...</Text>
    </View>
  );
}

export function Progress({ value, max = 100, ok = false }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <View style={{ height: 7, borderRadius: 999, backgroundColor: C.line, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: ok ? C.ok : C.brand600 }} />
    </View>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: C.surface3, borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[
              { flex: 1, paddingVertical: 8, borderRadius: 7, alignItems: 'center' },
              active && { backgroundColor: C.surface },
            ]}
          >
            <Text style={{ fontSize: 13, fontWeight: '700', color: active ? C.ink : C.muted }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Sheet({ visible, title, onClose, children, footer }) {
  return (
    <RNModal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,21,43,0.5)', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: C.surface,
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: '90%',
          }}
        >
          <View style={S.cardHead}>
            <Text style={S.h2}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted }}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>{children}</ScrollView>
          {!!footer && (
            <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: C.line, gap: 10 }}>
              {footer}
            </View>
          )}
        </View>
      </View>
    </RNModal>
  );
}

/* --------------------------------------------------- slide to clock in -- */

/**
 * Drag-to-confirm. A clock event is a payroll record, so it should never fire
 * from a pocket tap. The knob springs back unless it is dragged most of the way.
 */
export function SlideToAction({ label, onConfirm, variant = 'in', disabled = false, busy = false }) {
  const [width, setWidth] = useState(0);
  const [working, setWorking] = useState(false);
  const x = useRef(new Animated.Value(0)).current;
  const KNOB = 52;
  const travel = Math.max(0, width - KNOB - 8);

  const locked = disabled || busy || working;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const travelRef = useRef(travel);
  travelRef.current = travel;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => !lockedRef.current && Math.abs(g.dx) > 4,
      onPanResponderMove: (_e, g) => {
        if (lockedRef.current) return;
        x.setValue(Math.max(0, Math.min(travelRef.current, g.dx)));
      },
      onPanResponderRelease: async (_e, g) => {
        if (lockedRef.current) return;
        const reached = g.dx >= travelRef.current * 0.85;
        if (!reached) {
          Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
          return;
        }
        Animated.timing(x, { toValue: travelRef.current, duration: 90, useNativeDriver: true }).start();
        setWorking(true);
        try {
          await onConfirm();
        } finally {
          setWorking(false);
          Animated.timing(x, { toValue: 0, duration: 160, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        height: 60,
        borderRadius: 999,
        backgroundColor: disabled ? C.line2 : variant === 'out' ? C.brand700 : C.navy800,
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Text
        style={{
          textAlign: 'center', color: 'rgba(255,255,255,0.95)',
          fontWeight: '700', fontSize: 15.5, paddingLeft: 34,
        }}
      >
        {busy || working ? 'Working...' : label}
      </Text>
      <Animated.View
        {...responder.panHandlers}
        style={{
          position: 'absolute', left: 4, width: KNOB, height: KNOB, borderRadius: KNOB / 2,
          backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
          transform: [{ translateX: x }],
          shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
          elevation: 4,
        }}
      >
        {busy || working ? (
          <ActivityIndicator size="small" color={C.brand600} />
        ) : (
          <Text style={{ fontSize: 21, color: C.navy800, fontWeight: '700', marginTop: -2 }}>›</Text>
        )}
      </Animated.View>
    </View>
  );
}

/* --------------------------------------------------------------- toast -- */

export function useToastState() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'err' ? 5200 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, setToast];
}

export function Toast({ toast }) {
  if (!toast) return null;
  const bg = toast.tone === 'err' ? C.danger : toast.tone === 'ok' ? C.ok : C.ink2;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute', left: 16, right: 16, bottom: 22,
        backgroundColor: bg, borderRadius: 10, padding: 13,
        shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, elevation: 6,
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{toast.message}</Text>
    </View>
  );
}
