import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          // A 38px field at a desk; a 44px one under a coarse pointer.
          // The floor is `var(--tap-min)` bare (0 at a desk) rather than
          // `max(2.375rem,…)` on purpose: several call sites shrink the field
          // with an `h-*` override, and a positive min-height would silently
          // grow THOSE at a desk too. See globals.css → Touch targets.
          'w-full bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)]',
          'min-h-[var(--tap-min)]',
          'placeholder:text-[var(--color-text-muted)]',
          'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          className
        )}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';
