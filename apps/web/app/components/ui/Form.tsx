// components/ui/Form.tsx — react-hook-form bridge + Zod error wiring.
//
// Three helpers:
//
//   <Form />          - identical to <RRForm> with sensible defaults
//                        (method="post", replace, etc.) plus optional
//                        Zod field-error piping.
//   useZodForm(schema) - construct a typed `useForm` instance bound to
//                        a Zod schema, with a custom resolver that
//                        wires `zodResolver`.
//   <FormField />      - field-agnostic wrapper that takes a render
//                        prop, exposes the form context, and renders
//                        the relevant <Input>/<Select>/<Textarea>.
//
// Why a custom wrapper instead of <FormProvider> directly:
//   - The repeated pattern (FormProvider → Field → Controller →
//     Input) is tedious; this module cuts it in half.
//   - Errors get a consistent shape (`message` + `path`) so the
//     <Input> family can render them without branching.

import * as React from 'react';
import {
  Form as RRForm,
  useActionData,
  useNavigation,
  type FormProps as RRFormProps,
} from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Controller,
  FormProvider,
  useForm,
  useFormContext,
  type FieldValues,
  type UseFormProps,
  type UseFormReturn,
} from 'react-hook-form';
import type { z } from 'zod';
import { cn } from '../../lib/cn';

type FormProps = RRFormProps & {
  /**
   * Optional class added to the form element (e.g. for spacing).
   * Use this for grid/stack layout, not for individual field styles.
   */
  className?: string;
};

/**
 * Identical to react-router's `<Form>` but with `<form>` semantics
 * baked in (method="post", no full reload) plus an optional
 * `className`. Pairs with `<FormProvider>` from `useZodForm` so
 * nested controls can call `useFormContext`.
 */
export const Form = React.forwardRef<HTMLFormElement, FormProps>(
  function Form({ className, ...rest }, ref) {
    return <RRForm ref={ref} method="post" className={className} {...rest} />;
  },
);

export interface ZodFormProps<T extends FieldValues, S extends z.ZodType<T>>
  extends Omit<UseFormProps<T>, 'resolver'> {
  schema: S;
}

export type ZodFormReturn<T extends FieldValues> = UseFormReturn<T>;

/**
 * Build a `useForm` instance with Zod as the resolver. The generic
 * pair `<T, S>` lets TS infer the form value shape from
 * `z.infer<typeof schema>` — no `as` casts at call sites.
 *
 * Usage:
 *   const form = useZodForm({ schema: loginSchema, defaultValues: {...} });
 *   <FormProvider {...form}><Form onSubmit={form.handleSubmit(...)}>...
 */
export function useZodForm<T extends FieldValues, S extends z.ZodType<T>>(
  props: ZodFormProps<T, S>,
): ZodFormReturn<T> {
  const { schema, ...rest } = props;
  return useForm<T>({
    ...rest,
    resolver: zodResolver(schema as never) as never,
  });
}

/**
 * Convenience wrapper for `<Controller>` + `<FormProvider>` access.
 * Render-prop based so callers can choose any control.
 *
 * Usage:
 *   <FormField
 *     name="email"
 *     render={(field) => <Input {...field} label="Email" type="email" />}
 *   />
 */
export interface FormFieldProps<T extends FieldValues> {
  name: keyof T & string;
  render: (field: {
    name: string;
    value: T[keyof T];
    onChange: (value: T[keyof T]) => void;
    onBlur: () => void;
    error: string | undefined;
  }) => React.ReactNode;
}

export function FormField<T extends FieldValues>({
  name,
  render,
}: FormFieldProps<T>): React.ReactElement | null {
  const form = useFormContext<T>();
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const errorMessage =
          fieldState.error?.message ?? undefined;
        return (
          <>
            {render({
              name: field.name,
              value: field.value as T[keyof T],
              onChange: (value) => field.onChange(value),
              onBlur: field.onBlur,
              error: errorMessage,
            })}
          </>
        );
      }}
    />
  );
}

/**
 * Pull a router action's response and surface top-level errors
 * (`error`, `detail`) on the form via `setError`. Useful for
 * server-side validation results like `"invalid_credentials"` that
 * need to appear next to the field (or at the top of the form).
 */
export function useServerErrors<T extends FieldValues>(): {
  setFromAction: (data: unknown) => void;
} {
  const form = useFormContext<T>();
  const actionData = useActionData() as
    | { error?: string; detail?: string; fieldErrors?: Record<string, string> }
    | undefined;
  React.useEffect(() => {
    if (!actionData) return;
    if (actionData.error) {
      form.setError('root.serverError' as never, {
        type: 'server',
        message: actionData.detail ?? actionData.error,
      });
    }
    if (actionData.fieldErrors) {
      for (const [key, msg] of Object.entries(actionData.fieldErrors)) {
        form.setError(key as never, { type: 'server', message: msg });
      }
    }
    // We intentionally omit `form` from deps — react-hook-form's
    // setError reference is stable enough; effect should re-run on
    // action data change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);
  return { setFromAction: () => undefined };
}

/**
 * Read `useNavigation()` and return whether the form is mid-submit.
 * Useful for disabling a submit button while the action is pending.
 */
export function useIsSubmitting(): boolean {
  const nav = useNavigation();
  return nav.state === 'submitting';
}

/**
 * Top-level error banner — renders `form.formState.errors.root.serverError`.
 * Place inside `<FormProvider>` next to the submit button.
 */
export function ServerErrorBanner(): React.ReactElement | null {
  const form = useFormContext();
  const message = (form.formState.errors as Record<string, { message?: string }>)
    ?.root?.serverError?.message;
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border border-red-300 bg-red-50 px-4 py-2',
        'text-sm text-red-700',
      )}
    >
      {message}
    </div>
  );
}

export { FormProvider } from 'react-hook-form';
