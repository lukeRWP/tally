import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/**
 * A native <select> styled to match Input.
 *
 * Deliberately not @radix-ui/react-select (which is already a dependency). This
 * app is used one-handed on a phone, and a native select is what opens the iOS
 * wheel picker — a custom listbox renders a cramped popover instead. Being a
 * real form control it also works with react-hook-form's register() directly,
 * where Radix would need a Controller.
 *
 * appearance-none strips the platform arrow so the chevron matches the rest of
 * the UI; the right padding reserves room for it.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            'w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] pl-3 pr-9 py-2 text-sm text-[var(--color-text)]',
            'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-muted)]"
        />
      </div>
    );
  }
);

Select.displayName = 'Select';
