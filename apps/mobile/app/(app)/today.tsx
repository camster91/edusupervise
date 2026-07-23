// app/(app)/today.tsx
//
// Expo Router route file for the (app) group. The (app) group is
// where signed-in screens live (slice A's _layout re-checks the
// session and redirects to /sign-in if absent). This file is
// intentionally a thin wrapper around src/screens/Today.tsx —
// the screen logic lives there so it's easy to unit-test (a
// component test can import Today directly without pulling in
// expo-router).

import React from 'react';
import { Today } from '../../src/screens/Today';

export default function TodayRoute(): React.ReactElement {
  return <Today />;
}
