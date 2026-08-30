import { cn } from '@/lib/utils';

/**
 * The share URL as something you can actually open.
 *
 * Before #296 it was a `<span>` in the dialog and a readonly `<Input>` above
 * it, and `grep -rn "share/" client/src` found no anchor to the share view
 * anywhere in the app — so the only way to see what you had just published was
 * to copy it and paste it into a new tab.
 *
 * Lifted out of share-dialog.tsx for #297: settings.tsx lists the same links
 * and kept its own `<span>`, because that file was owned by another agent in
 * the same wave. Two surfaces showing the same URL should offer the same
 * affordance, and the only way to guarantee that is for there to be one of it.
 */
export function ShareUrl({ url, className }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      // Without noopener the opened tab can reach back through window.opener.
      rel="noopener noreferrer"
      title={`Open ${url} in a new tab`}
      className={cn(
        'block min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-primary)] underline underline-offset-2 hover:opacity-80',
        className,
      )}
    >
      {url}
    </a>
  );
}
