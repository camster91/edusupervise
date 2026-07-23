// app/(app)/_layout.tsx
//
// Authenticated route group. Re-checks the session cookie on mount
// and redirects to /sign-in if absent. This is the second line of
// defense — the splash screen in app/index.tsx is the first.

import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { getSession, verifySession } from '@/lib/auth';

export default function AppLayout() {
  const [state, setState] = React.useState<
    { kind: 'loading' } | { kind: 'authed' } | { kind: 'unauthed' }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const session = await getSession();
      if (!session) {
        if (!cancelled) setState({ kind: 'unauthed' });
        return;
      }
      const ok = await verifySession();
      if (cancelled) return;
      setState({ kind: ok ? 'authed' : 'unauthed' });
    }

    check().catch(() => {
      if (!cancelled) setState({ kind: 'unauthed' });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }
  if (state.kind === 'unauthed') {
    return <Redirect href="/sign-in" />;
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#ffffff' },
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="today" options={{ title: 'Today' }} />
    </Stack>
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
