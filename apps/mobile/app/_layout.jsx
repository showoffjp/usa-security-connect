import { useEffect } from 'react';
import { View } from 'react-native';
import { Slot, Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth.jsx';
import { Notifications, pathForNotification } from '../src/push.js';
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

  // Tapping a notification opens the screen it refers to, but only once the
  // officer is actually signed in - otherwise the auth gate would bounce them.
  useEffect(() => {
    if (!user) return;

    const open = (response) => {
      const path = pathForNotification(response?.notification?.request?.content?.data);
      if (path) router.push(path);
    };

    // Covers the app being launched cold by a notification tap.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response);
    });

    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [user, router]);

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
      <Stack.Screen name="post-log" options={{ headerShown: true, title: 'Post log' }} />
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
