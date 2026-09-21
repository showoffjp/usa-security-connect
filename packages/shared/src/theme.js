/**
 * USA Security Connect - brand tokens.
 * Palette sampled from usasecuritygroup.com (navy + brand red on charcoal/white).
 * Consumed by the web app (as CSS custom properties) and the mobile app (as JS objects).
 */

export const palette = {
  // Core brand
  navy900: '#00152B',
  navy800: '#001F3F', // primary surface / header
  navy700: '#062E58',
  navy600: '#0C3F72',
  navy100: '#E6ECF3',

  red700: '#7F2313',
  red600: '#AA2F19', // primary action / brand red
  red500: '#C4553C',
  red400: '#E66952', // accent
  red100: '#FBE9E5',

  charcoal900: '#171717',
  charcoal800: '#292929',
  charcoal600: '#4A4A4A',
  gray500: '#7E7E7E',
  gray400: '#A3A3A3',
  gray300: '#D4D4D4',
  gray200: '#E5E5E5',
  gray100: '#F5F5F5',
  white: '#FFFFFF',

  // Status
  green600: '#1E8E4E',
  green500: '#2ECC71',
  green100: '#E3F7EC',
  amber600: '#B26A00',
  amber500: '#E67E22',
  amber100: '#FDF0DF',
  red: '#C0392B',
  redSoft: '#FDECEA',
  blue600: '#1B6FB8',
  blue100: '#E4F0FA',
};

export const theme = {
  color: {
    brand: palette.red600,
    brandHover: palette.red700,
    accent: palette.red400,
    surface: palette.white,
    surfaceMuted: palette.gray100,
    header: palette.navy800,
    headerDeep: palette.navy900,
    text: palette.charcoal900,
    textMuted: palette.gray500,
    border: palette.gray200,
    onBrand: palette.white,
    success: palette.green600,
    warning: palette.amber600,
    danger: palette.red,
    info: palette.blue600,
  },
  radius: { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 },
  space: (n) => n * 4,
  font: {
    family: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', monospace",
  },
};

/** Status chip colors shared by web + mobile. */
export const statusColors = {
  ok: { bg: palette.green100, fg: palette.green600 },
  pending: { bg: palette.gray100, fg: palette.gray500 },
  warn: { bg: palette.amber100, fg: palette.amber600 },
  danger: { bg: palette.redSoft, fg: palette.red },
  info: { bg: palette.blue100, fg: palette.blue600 },
  brand: { bg: palette.red100, fg: palette.red600 },
};
