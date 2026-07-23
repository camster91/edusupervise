// app/sign-up-demo.tsx
//
// Demo sign-up route. Mounts the SignUpDemo screen and wires the
// "Already have an account? Sign in" link to /sign-in.

import React from 'react';
import { useRouter } from 'expo-router';
import { SignUpDemoScreen } from '@/screens/SignUpDemo';

export default function SignUpDemoRoute() {
  const router = useRouter();
  return (
    <SignUpDemoScreen onPressSignIn={() => router.replace('/sign-in')} />
  );
}
