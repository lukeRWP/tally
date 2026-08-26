import * as React from 'react';
import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Tally-voiced wrapper over Radix DropdownMenu. Radix owns focus, keyboard
 * and dismissal (Escape closes the menu and ONLY the menu); this file owns
 * nothing but paint — no custom focus management, ever.
 */
export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;

export function DropdownMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadixDropdown.Content>) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        sideOffset={6}
        className={cn(
          'z-50 min-w-[200px] rounded-[var(--radius-sm)] border-[1.5px] border-[var(--color-text)]',
          'bg-[var(--color-card)] p-1 shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
      </RadixDropdown.Content>
    </RadixDropdown.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof RadixDropdown.Item>) {
  return (
    <RadixDropdown.Item
      className={cn(
        'flex min-h-[44px] cursor-pointer items-center gap-2 rounded-[2px] px-3',
        'font-mono text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-text)]',
        'outline-none data-[highlighted]:bg-[var(--color-elevated)]',
        className,
      )}
      {...props}
    />
  );
}
