// app/sign-in.tsx
//
// Sign-in route. Mounts the SignIn screen from src/screens and wires
// the "Create demo account" CTA to /sign-up-demo.

import React from 'react';
import { useRouter } from 'expo-router';
import { SignInScreen } from '@/screens/SignIn';

export default function SignInRoute() {
  const router = useRouter();
  return (
    <SignInScreen onPressCreateDemo={() => router.push('/sign-up-demo')} />
  );
}
