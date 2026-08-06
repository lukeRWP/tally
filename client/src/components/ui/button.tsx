import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Thermal buttons: uppercase, tight tracking, squared corners, hard borders —
// the label printer's own vocabulary. Ink is primary (like the mockup's
// .btn.pri); orange is a scarce accent reserved for the `accent` variant
// (Lend, commit) so it keeps its meaning. No lift/shadow flourish — thermal
// is flat.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-bold uppercase tracking-[0.03em] border transition-colors duration-150 disabled:opacity-45 disabled:pointer-events-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-text)] text-[var(--color-bg)] border-[var(--color-text)] hover:opacity-85',
        outline:
          'border-[var(--color-text)] bg-transparent text-[var(--color-text)] hover:bg-[var(--color-text)] hover:text-[var(--color-bg)]',
        ghost:
          'bg-transparent border-transparent text-[var(--color-text)] hover:bg-[var(--color-elevated)]',
        accent:
          'bg-transparent border-[var(--color-primary)] text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white',
        destructive:
          'bg-[var(--color-red)] text-white border-[var(--color-red)] hover:opacity-85',
      },
      size: {
        sm: 'h-8 px-3 text-[11px]',
        md: 'h-9 px-4 text-xs',
        lg: 'h-11 px-6 text-sm',
        icon: 'h-9 w-9 p-0 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';
