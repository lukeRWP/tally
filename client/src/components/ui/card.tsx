import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Animation delay for staggered entrance, e.g. "50ms" */
  animationDelay?: string;
}

export function Card({ className, animationDelay, style, onClick, onKeyDown, role, tabIndex, ...props }: CardProps) {
  // When a Card is clickable, make it a real keyboard-operable control:
  // focusable, announced as a button, and activated by Enter/Space — otherwise
  // the whole inventory hierarchy (cards that navigate on click) is unreachable
  // by keyboard and screen readers.
  const interactive = typeof onClick === 'function';
  return (
    <div
      className={cn(
        'bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4',
        'shadow-[0_1px_3px_rgba(0,0,0,0.04)]',
        'transition-all duration-200',
        'animate-fade-up',
        interactive && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
        className
      )}
      style={{
        ...style,
        ...(animationDelay ? { animationDelay } : {}),
      }}
      onClick={onClick}
      role={role ?? (interactive ? 'button' : undefined)}
      tabIndex={tabIndex ?? (interactive ? 0 : undefined)}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          e.currentTarget.click();
        }
        onKeyDown?.(e);
      }}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1 pb-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('text-base font-semibold text-[var(--color-text)]', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('text-sm text-[var(--color-text-muted)]', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('pt-0', className)}
      {...props}
    />
  );
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center pt-3 border-t border-[var(--color-border)]', className)}
      {...props}
    />
  );
}
