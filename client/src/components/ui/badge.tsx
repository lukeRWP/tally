import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Thermal badges: mono, uppercase, hard 1px border, no soft fill — the bordered
// stamp from the printed label. Semantic colour rides the border + text, not a
// tinted background. `info` maps to the orange accent (purple left the palette).
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[10px] leading-none font-semibold uppercase tracking-[0.08em] transition-colors duration-150',
  {
    variants: {
      variant: {
        default: 'border-[var(--color-text)] text-[var(--color-text)]',
        success: 'border-[var(--color-green)] text-[var(--color-green)]',
        warning: 'border-[var(--color-amber)] text-[var(--color-amber)]',
        danger: 'border-[var(--color-red)] text-[var(--color-red)]',
        info: 'border-[var(--color-primary)] text-[var(--color-primary)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
