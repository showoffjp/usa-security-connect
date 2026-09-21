import { useEffect } from 'react';
import { View } from 'react-native';
import { Slot, Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth.jsx';
import { Loading } from '../src/ui.jsx';
import { C } from '../src/theme.js';

/**
 * Auth gate. Officers who are not signed in only ever see /login, and a
 * supervisor-issued PIN has to be replaced before the app opens.
 */
function Gate() {
  const { user, loading, mustChangePin } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const onAuthScreen = segments[0] === 'login' || segments[0] === 'change-pin';

    if (!user && !onAuthScreen) router.replace('/login');
    else if (user && mustChangePin && segments[0] !== 'change-pin') {
      router.replace('/change-pin?forced=1');
    } else if (user && !mustChangePin && onAuthScreen) {
      router.replace('/');
    }
  }, [user, loading, mustChangePin, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: C.surface2 }}>
        <Loading label="Starting USA Security Connect" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.surface2 } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" />
      <Stack.Screen name="change-pin" />
      <Stack.Screen name="tour/[runId]" options={{ headerShown: true, title: 'Tour' }} />
      <Stack.Screen name="incident-new" options={{ headerShown: true, title: 'Report an incident' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={C.navy800} />
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
