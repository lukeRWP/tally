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
      // Heights are `max(<desk height>, var(--tap-min))`, not bare `h-8`/`h-9`:
      // --tap-min is 0 under a fine pointer, so a desk gets the identical
      // 32/36/44/36 it always did, and 44px under a coarse one, so the same
      // button is a finger target on a tablet without a single call site
      // passing size="lg". `icon` takes it on BOTH axes — a 36px square is
      // still a miss at 44px tall. See globals.css → Touch targets.
      size: {
        sm: 'h-[max(2rem,var(--tap-min))] px-3 text-[11px]',
        md: 'h-[max(2.25rem,var(--tap-min))] px-4 text-xs',
        lg: 'h-[max(2.75rem,var(--tap-min))] px-6 text-sm',
        icon: 'h-[max(2.25rem,var(--tap-min))] w-[max(2.25rem,var(--tap-min))] p-0 text-sm',
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
