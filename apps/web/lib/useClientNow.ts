// apps/web/app/lib/useClientNow.ts
//
// Returns null on the server (SSR). On the client, returns the
// current Date after the first mount via useEffect. Use this for
// any time-dependent render that previously used `new Date()`
// directly in a default export — it prevents React's hydration
// mismatches (#418 / #425) by guaranteeing the server and
// first-paint client render the same content, then updating only
// after hydration completes.

import { useEffect, useState } from 'react';

export function useClientNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);
  return now;
}
