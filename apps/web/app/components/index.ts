// components/index.ts — barrel for cross-component re-exports.

export { ThemeStyle } from './ThemeStyle';
export type { ThemeStyleProps } from './ThemeStyle';

// Flat re-exports of UI primitives the root layer + layout need
// (ToastViewport, ToastProvider, ToastListener). Other UI primitives
// are imported from `~/components/ui` directly to keep tree-shaking
// cheap.
export {
  Toast,
  ToastProvider,
  ToastViewport,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
  ToastListener,
} from './ui';

// Namespaces — useful when a file wants many primitives from one module.
export * as Shell from './shell';
export * as UI from './ui';
