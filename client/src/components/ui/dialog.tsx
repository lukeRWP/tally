import * as React from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogPortal = RadixDialog.Portal;
export const DialogTitle = RadixDialog.Title;
export const DialogDescription = RadixDialog.Description;
export const DialogClose = RadixDialog.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof RadixDialog.Overlay>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(({ className, ...props }, ref) => (
  <RadixDialog.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 bg-black/50 backdrop-blur-sm z-50',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = 'DialogOverlay';

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof RadixDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <RadixDialog.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 -translate-x-1/2 z-50',
        'top-[5vh] max-h-[90dvh] overflow-y-auto',
        'md:top-1/2 md:-translate-y-1/2 md:max-h-[85vh]',
        'bg-[var(--color-card)] border border-[var(--color-border)]',
        'rounded-[var(--radius-lg)] max-w-lg w-[calc(100%-2rem)] md:w-full p-6',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className
      )}
      {...props}
    >
      {children}
      <RadixDialog.Close
        className={cn(
          'absolute top-4 right-4',
          'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          'transition-colors cursor-pointer'
        )}
      >
        <X size={16} />
        <span className="sr-only">Close</span>
      </RadixDialog.Close>
    </RadixDialog.Content>
  </DialogPortal>
));
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1 mb-4', className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex justify-end gap-2 mt-6', className)}
      {...props}
    />
  );
}
