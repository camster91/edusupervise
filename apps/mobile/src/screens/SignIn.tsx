// src/screens/SignIn.tsx
//
// Email + password sign-in. Reuses the web's HMAC session cookie
// (see apps/web/server/auth.server.ts:29) by calling signIn() in
// src/lib/auth.ts. On success, navigates to /(app)/today.
//
// Error handling:
//   - 401: "Invalid email or password."
//   - 429: "Too many sign-in attempts. Try again in a few minutes."
//   - network: the raw error message
//   - anything else: the raw code + status

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { signIn } from '@/lib/auth';

export interface SignInProps {
  /** Optional link to the demo sign-up screen. Slice A only — slice B
   *  may move the link into a separate "Sign up" landing page. */
  onPressCreateDemo?: () => void;
}

export function SignInScreen({ onPressCreateDemo }: SignInProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await signIn({ email: email.trim(), password });
      if (result.ok) {
        router.replace('/(app)/today');
        return;
      }
      setError(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setSubmitting(false);
    }
  }, [email, password, router]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in to EduSupervise.</Text>

            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                placeholder="you@school.ca"
                editable={!submitting}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                placeholder="••••••••"
                editable={!submitting}
              />
            </View>

            {error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}

            <Pressable
              onPress={onSubmit}
              disabled={submitting}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || submitting) && styles.primaryButtonPressed,
                submitting && styles.primaryButtonDisabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryButtonText}>Sign in</Text>
              )}
            </Pressable>

            {onPressCreateDemo ? (
              <Pressable
                onPress={onPressCreateDemo}
                disabled={submitting}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.secondaryButtonPressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>
                  New here? Create a demo account
                </Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default SignInScreen;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f8fa' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 16 },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  title: { fontSize: 24, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6b7280', marginBottom: 20 },
  field: { marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '500', color: '#374151', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  error: { color: '#dc2626', fontSize: 13, marginTop: 4, marginBottom: 8 },
  primaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonPressed: { backgroundColor: '#1d4ed8' },
  primaryButtonDisabled: { opacity: 0.7 },
  primaryButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  secondaryButton: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonPressed: { opacity: 0.7 },
  secondaryButtonText: { color: '#2563eb', fontSize: 14, fontWeight: '500' },
});
