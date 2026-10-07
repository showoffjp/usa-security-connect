import { Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Shield } from '../../src/ui.jsx';
import { C } from '../../src/theme.js';

/** Simple glyph tab icons - no icon-font dependency to keep the bundle lean. */
function TabIcon({ glyph, color, focused }) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', height: 26 }}>
      <Text style={{ fontSize: focused ? 19 : 18, color }}>{glyph}</Text>
    </View>
  );
}

function Header() {
  return (
    <View
      style={{
        backgroundColor: C.navy800,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        paddingHorizontal: 16,
        paddingBottom: 12,
        paddingTop: 4,
      }}
    >
      <Shield size={28} />
      <View>
        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>USA Security Connect</Text>
        <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 9.5, letterSpacing: 1.6, fontWeight: '700' }}>
          PROTECTION GROUP
        </Text>
      </View>
    </View>
  );
}

export default function TabsLayout() {
  // The app draws under the system bars (always, on Android since SDK 54), so
  // the tab bar adds the bottom inset to its own size rather than sitting
  // under the gesture bar or the buttons.
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: C.navy800 },
        headerTintColor: '#fff',
        headerTitle: () => <Header />,
        headerTitleAlign: 'left',
        tabBarActiveTintColor: C.brand600,
        tabBarInactiveTintColor: C.muted,
        tabBarStyle: { borderTopColor: C.line, height: 62 + insets.bottom, paddingBottom: 8 + insets.bottom, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: C.surface2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: (p) => <TabIcon glyph="⌂" {...p} />,
        }}
      />
      <Tabs.Screen
        name="tours"
        options={{
          title: 'Tours',
          tabBarIcon: (p) => <TabIcon glyph="◎" {...p} />,
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          tabBarIcon: (p) => <TabIcon glyph="⚠" {...p} />,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          tabBarIcon: (p) => <TabIcon glyph="▤" {...p} />,
        }}
      />
      <Tabs.Screen
        name="updates"
        options={{
          title: 'Updates',
          tabBarIcon: (p) => <TabIcon glyph="◈" {...p} />,
        }}
      />
    </Tabs>
  );
}
