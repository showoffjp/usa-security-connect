# Building the mobile apps

The app runs in Expo Go for everyday development, but **NFC scanning and push
notifications need a real build** — those native modules do not exist in Expo Go.

The app is on **Expo SDK 57** (React Native 0.86, React 19), which runs only on
React Native's New Architecture. `npx expo-doctor` passes all of its checks, with one
exception set in `package.json`: `react-native-nfc-manager` is not yet listed as tested
on the New Architecture. It loads through React Native's interop layer for older
native modules, so **scan a real tag on the first development build** before relying
on it; if it fails, the tour screen still falls back to typing the tag ID.

## 1. Development build (once per device)

```bash
npx eas login
npx eas build:configure          # writes the EAS project id into app.json
npx eas build --profile development --platform android
```

Install the resulting APK on the handset, then `npm run mobile` and open it in
that build instead of Expo Go. NFC and push now work.

## 2. Store builds

```bash
npx eas build --profile production --platform android   # AAB for Google Play
npx eas build --profile production --platform ios       # needs an Apple Developer account
```

`eas.json` points each profile at a different API. Change the URLs in
`build.*.env.EXPO_PUBLIC_API_URL` before the first real build.

## 3. Push notifications

`eas build:configure` adds `extra.eas.projectId` to `app.json`, and the app reads
it when asking for a push token. Without it, `registerForPush()` logs a warning
and the app carries on without notifications.

- **Android**: upload your FCM service-account key with `npx eas credentials`.
- **iOS**: EAS generates the APNs key for you during the first build.

Verify delivery once installed: sign in as an admin and `POST /api/devices/test`,
which sends a notification to your own registered devices.

## Local builds without EAS

```bash
npx expo prebuild        # generates native android/ and ios/ projects
npx expo run:android     # needs Android Studio
npx expo run:ios         # needs Xcode, so macOS only
```

`android/` and `ios/` are gitignored — they are generated output, and regenerating
them is safer than hand-editing.
