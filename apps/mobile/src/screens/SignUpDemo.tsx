// src/screens/SignUpDemo.tsx
//
// Same UI as SignIn with one extra "Name" field + a "Create demo
// account" CTA that calls signUpDemo(). Easiest test path during
// slice A: no real school is required, the server seeds a 30-day
// demo school + pre-populated duties on success.

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
import { signUpDemo } from '@/lib/auth';

export interface SignUpDemoProps {
  /** Optional link to the email+password sign-in screen. */
  onPressSignIn?: () => void;
}

export function SignUpDemoScreen({ onPressSignIn }: SignUpDemoProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (!name.trim() || !email.trim() || !password) {
      setError('All fields are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await signUpDemo({
        name: name.trim(),
        email: email.trim(),
        password,
      });
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
  }, [name, email, password, router]);

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
            <Text style={styles.title}>Create demo account</Text>
            <Text style={styles.subtitle}>
              Get a 30-day pre-seeded school to try EduSupervise.
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                autoCorrect={false}
                autoComplete="name"
                textContentType="name"
                placeholder="Ms. Smith"
                editable={!submitting}
              />
            </View>

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
                autoComplete="password-new"
                textContentType="newPassword"
                placeholder="At least 8 characters"
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
                <Text style={styles.primaryButtonText}>Create demo account</Text>
              )}
            </Pressable>

            {onPressSignIn ? (
              <Pressable
                onPress={onPressSignIn}
                disabled={submitting}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.secondaryButtonPressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>
                  Already have an account? Sign in
                </Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default SignUpDemoScreen;

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
