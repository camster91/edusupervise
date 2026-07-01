// components/ui/index.ts — single barrel for the UI primitive set.
//
// Consumers import from `~/components/ui` (per the `~` alias) and
// reach every Radix-wrapped primitive without remembering the path.
// Add new primitives here as they're introduced.

export { Button, buttonClassName } from './Button';
export type { ButtonProps, ButtonVariantProps } from './Button';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Banner, BannerStack } from './Banner';
export type { BannerProps, BannerVariant } from './Banner';

export { HeroCard } from './HeroCard';
export type { HeroCardProps, DutyRef } from './HeroCard';

export { WeekStrip } from './WeekStrip';
export type { WeekStripProps, WeekStripDay } from './WeekStrip';

export { StatsRow } from './StatsRow';
export type { StatsRowProps, StatCardData } from './StatsRow';

export { CycleLegend, cycleDayClasses } from './CycleLegend';
export type { CycleLegendProps } from './CycleLegend';

export { AddDutyEmptyState } from './AddDutyEmptyState';
export type { AddDutyEmptyStateProps } from './AddDutyEmptyState';

export { EquipmentChips } from './EquipmentChips';
export type { EquipmentChipsProps } from './EquipmentChips';

export { Sheet } from './Sheet';
export type { SheetProps, SheetDetent } from './Sheet';

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './Dialog';

export { Input, Textarea } from './Input';
export type { InputProps, TextareaProps } from './Input';

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from './Select';
export type { SelectTriggerProps, SelectContentProps, SelectItemProps } from './Select';

export {
  Form,
  FormField,
  FormProvider,
  useZodForm,
  useServerErrors,
  useIsSubmitting,
  ServerErrorBanner,
} from './Form';

export {
  Toast,
  ToastProvider,
  ToastViewport,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
  ToastListener,
  toast,
} from './Toast';
export type { ToastInput, ToastVariantProps } from './Toast';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
} from './Table';

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from './Tabs';

export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
} from './Popover';
