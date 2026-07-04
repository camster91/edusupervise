// components/ui/Toast.tsx — Radix Toast wrapper + a small
// imperative `toast()` helper that lives in this module's namespace.
//
// Spec section 9 lists `Toast` as a Radix-wrapped primitive. Radix
// Toast handles ARIA live-region semantics automatically: every
// toast goes into a polite-live region so screen-readers announce
// them without hijacking focus.
//
// Usage pattern in the app:
//   import { toast, ToastProvider } from '~/components/ui/Toast';
//
//   <ToastProvider />
//   ...
//   toast({ title: 'Saved', description: 'Settings updated.', variant: 'success' });
//
// `ToastProvider` is placed once near the root (see `root.tsx`) so
// every route — including auth pages — gets access to the same
// imperative helper.

import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export const ToastProvider = ToastPrimitive.Provider;

/**
 * Visual viewport (the area where toasts stack). Set `hotkey` for
 * a dev-mode shortcut that focuses the next toast.
 */
export const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(function ToastViewport({ className, ...props }, ref) {
  return (
    <ToastPrimitive.Viewport
      ref={ref}
      className={cn(
        'fixed bottom-0 right-0 z-50 flex max-h-screen w-full md:max-w-[420px] flex-col gap-2',
        'p-4 sm:p-6 m-0 outline-none',
        className,
      )}
      {...props}
    />
  );
});

const toastVariants = cva(
  [
    'group pointer-events-auto relative flex w-full items-center justify-between space-x-3',
    'overflow-hidden rounded-lg border p-4 pr-8 shadow-lg',
    'data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none',
    'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-full',
    'data-[state=closed]:animate-out data-[state=closed]:fade-out-80',
    'data-[state=closed]:slide-out-to-right-full',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'border-slate-200 bg-white text-slate-900',
        success: 'border-green-300 bg-green-50 text-green-900',
        error: 'border-red-300 bg-red-50 text-red-900',
        warning: 'border-amber-300 bg-amber-50 text-amber-900',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type ToastVariantProps = VariantProps<typeof toastVariants>;

export interface ToastProps
  extends React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>,
    ToastVariantProps {
  title?: string;
  description?: string;
  closeLabel?: string;
}

export const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  ToastProps
>(function Toast(
  { className, variant, title, description, closeLabel = 'Dismiss notification', ...props },
  ref,
) {
  return (
    <ToastPrimitive.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    >
      <div className="grid gap-1">
        {title && (
          <ToastPrimitive.Title className="text-sm font-semibold">
            {title}
          </ToastPrimitive.Title>
        )}
        {description && (
          <ToastPrimitive.Description className="text-sm opacity-90">
            {description}
          </ToastPrimitive.Description>
        )}
      </div>
      <ToastPrimitive.Close
        aria-label={closeLabel}
        className="absolute right-2 top-2 rounded-md p-1 text-slate-500 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" aria-hidden />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
});

export const ToastTitle = ToastPrimitive.Title;
export const ToastDescription = ToastPrimitive.Description;
export const ToastAction = ToastPrimitive.Action;
export const ToastClose = ToastPrimitive.Close;

// ---------------------------------------------------------------------------
// Imperative toast() helper. Each call appends a Toast to the provider that
// lives at the document root. The store is keyed by a module-level counter
// so concurrent calls don't overwrite each other.
// ---------------------------------------------------------------------------

export type ToastInput = {
  title?: string;
  description?: string;
  variant?: ToastVariantProps['variant'];
  durationMs?: number;
};

interface ToastEntry extends ToastInput {
  id: number;
}

interface ToastStore {
  entries: ToastEntry[];
  add: (entry: ToastInput) => void;
  remove: (id: number) => void;
}

// Toast store lives in module state and is wired to a `<ToastListener>`
// placed inside `<ToastProvider>` once at app boot (see root.tsx).
// This indirection lets any component call `toast()` without prop
// drilling — the listener picks up new entries via the store
// subscription and renders them as Radix Toast elements.
let nextToastId = 1;
let toastStore: ToastStore | null = null;

function ensureToastStore(): ToastStore {
  if (!toastStore) {
    toastStore = {
      entries: [],
      add(entry) {
        this.entries.push({ id: nextToastId++, ...entry });
      },
      remove(id) {
        this.entries = this.entries.filter((e) => e.id !== id);
      },
    };
  }
  return toastStore;
}

/** Imperative API to surface a toast. No-op in SSR. */
export function toast(input: ToastInput): void {
  if (typeof window === 'undefined') return;
  ensureToastStore().add(input);
}

/**
 * Internal listener component — must be rendered once inside
 * `<ToastProvider />` for the imperative `toast()` helper to surface.
 * Watches the global toast store and renders each pending entry as a
 * Radix `Toast`.
 */
export function ToastListener(): React.ReactElement | null {
  const [tick, setTick] = React.useState(0);
  // Ensure the store exists; mutations happen at module level.
  ensureToastStore();
  React.useEffect(() => {
    // Poll every 250ms — the toast() helper is rarely on a hot path,
    // and the cost of React state updates > 4x/sec is more than the
    // cost of a setInterval. (We could use a microtask queue here but
    // that's premature.)
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, []);
  // `tick` is intentional — it forces a re-render after each interval
  // so the entries below reflect the latest module-level mutations.
  void tick;

  const store = ensureToastStore();
  return (
    <>
      {store.entries.map((entry) => (
        <Toast
          key={entry.id}
          variant={entry.variant ?? 'default'}
          title={entry.title}
          description={entry.description}
          duration={entry.durationMs ?? 5000}
          onOpenChange={(open) => {
            if (!open) store.remove(entry.id);
          }}
        />
      ))}
    </>
  );
}
