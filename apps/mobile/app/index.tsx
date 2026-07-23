// app/index.tsx
//
// Splash screen. On mount:
//   1. Read the session cookie from expo-secure-store.
//   2. If absent, route to /sign-in.
//   3. If present, hit GET /app/today via verifySession() to confirm
//      the session is still valid. If 401, clear local state and
//      route to /sign-in. Otherwise, route to /(app)/today.
//
// This file is intentionally a no-UI splash. The actual login screen
// is in src/screens/SignIn.tsx and mounted at /sign-in.

import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getSession, verifySession } from '@/lib/auth';

export default function SplashIndex() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function route() {
      const session = await getSession();
      if (!session) {
        if (!cancelled) router.replace('/sign-in');
        return;
      }
      const ok = await verifySession();
      if (cancelled) return;
      router.replace(ok ? '/(app)/today' : '/sign-in');
    }

    route().catch(() => {
      if (!cancelled) router.replace('/sign-in');
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <View style={styles.splash}>
      <ActivityIndicator size="large" color="#2563eb" />
    </View>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#f7f8fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
