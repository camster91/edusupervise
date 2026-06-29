// app/lib/cn.ts — className composition helper.
//
// Tiny wrapper around `clsx` + `tailwind-merge` (already in our deps)
// so callers can write `cn('base', isActive && 'ring-2', className)`
// without remembering the order. `twMerge` de-duplicates conflicting
// Tailwind classes so the right-most wins (no "bg-blue-500 bg-red-500"
// both-fighting-in-the-cascade surprise).
//
// Spec section 9 puts `app/lib/` as the home for cross-cutting
// helpers. This one shows up in nearly every component below.

import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose class names. Anything `clsx` accepts (string, array, object,
 * boolean, falsy values) is fair game; the result is also passed
 * through `twMerge` so conflicting Tailwind utilities resolve
 * correctly.
 *
 * Example:
 *   cn('p-4 rounded-lg', isActive && 'bg-blue-500', className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
