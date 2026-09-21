import { StyleSheet } from 'react-native';

/** Same palette as the web app - sampled from usasecuritygroup.com. */
export const C = {
  navy900: '#00152B',
  navy800: '#001F3F',
  navy700: '#062E58',
  navy100: '#E6ECF3',

  brand700: '#7F2313',
  brand600: '#AA2F19',
  brand400: '#E66952',
  brand100: '#FBE9E5',

  ink: '#171717',
  ink2: '#292929',
  ink3: '#4A4A4A',
  muted: '#7E7E7E',
  line: '#E5E5E5',
  line2: '#D4D4D4',
  surface: '#FFFFFF',
  surface2: '#F6F7F9',
  surface3: '#F0F2F5',

  ok: '#1E8E4E',
  okBg: '#E3F7EC',
  warn: '#B26A00',
  warnBg: '#FDF0DF',
  danger: '#C0392B',
  dangerBg: '#FDECEA',
  info: '#1B6FB8',
  infoBg: '#E4F0FA',
};

export const S = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.surface2 },
  content: { padding: 16, gap: 14, paddingBottom: 36 },

  h1: { fontSize: 24, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  h2: { fontSize: 18, fontWeight: '700', color: C.ink },
  h3: { fontSize: 15, fontWeight: '700', color: C.ink },
  eyebrow: {
    fontSize: 11, fontWeight: '800', color: C.brand600,
    letterSpacing: 1, textTransform: 'uppercase',
  },
  text: { fontSize: 15, color: C.ink },
  small: { fontSize: 13, color: C.ink3 },
  tiny: { fontSize: 11.5, color: C.muted },
  muted: { color: C.muted },
  strong: { fontWeight: '700' },
  mono: { fontVariant: ['tabular-nums'] },

  card: {
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    overflow: 'hidden',
  },
  cardPad: { padding: 16, gap: 12 },
  cardHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowBetween: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: 10,
  },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, paddingHorizontal: 18, borderRadius: 10,
    backgroundColor: C.surface3,
  },
  btnPrimary: { backgroundColor: C.brand600 },
  btnNavy: { backgroundColor: C.navy800 },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.line2 },
  btnDanger: { backgroundColor: C.danger },
  btnText: { fontSize: 15, fontWeight: '700', color: C.ink },
  btnTextOn: { fontSize: 15, fontWeight: '700', color: '#fff' },
  btnDisabled: { opacity: 0.5 },

  input: {
    borderWidth: 1, borderColor: C.line2, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 11,
    fontSize: 15, color: C.ink, backgroundColor: C.surface,
  },
  inputError: { borderColor: C.danger },
  label: { fontSize: 13, fontWeight: '600', color: C.ink2, marginBottom: 6 },
  hint: { fontSize: 12, color: C.muted, marginTop: 5 },
  errorText: { fontSize: 12.5, color: C.danger, marginTop: 5, fontWeight: '500' },

  chip: {
    paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999,
    backgroundColor: C.surface3, alignSelf: 'flex-start',
  },
  chipText: { fontSize: 11.5, fontWeight: '700', color: C.ink3 },

  listItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  leadIcon: {
    width: 38, height: 38, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.navy100,
  },

  banner: {
    flexDirection: 'row', gap: 10, padding: 13, borderRadius: 10,
    borderWidth: 1, alignItems: 'flex-start',
  },

  divider: { height: 1, backgroundColor: C.line },
});

export const chipTone = {
  ok: { bg: C.okBg, fg: C.ok },
  warn: { bg: C.warnBg, fg: C.warn },
  danger: { bg: C.dangerBg, fg: C.danger },
  info: { bg: C.infoBg, fg: C.info },
  brand: { bg: C.brand100, fg: C.brand600 },
  navy: { bg: C.navy100, fg: C.navy700 },
  plain: { bg: C.surface3, fg: C.ink3 },
};
