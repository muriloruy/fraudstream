import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

/** Modal dialog: focus trap, Esc to close, focus returns to the trigger (Radix). */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-6 shadow-xl focus-visible:outline-none"
          aria-describedby={description ? undefined : undefined}
        >
          <RadixDialog.Title className="text-lg font-semibold text-fg">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="mt-1 text-sm text-fg-muted">
              {description}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
