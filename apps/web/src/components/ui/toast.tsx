import * as RadixToast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone: 'info' | 'error' | 'success';
}

type Notify = (toast: Omit<ToastMessage, 'id'>) => void;
const ToastContext = createContext<Notify>(() => undefined);

/** Radix toasts: announced by screen readers (live region), dismissible with the keyboard. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const notify = useCallback<Notify>((t) => {
    setToasts((prev) => [...prev, { ...t, id: Date.now() + Math.random() }]);
  }, []);
  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="right" duration={6000}>
        {children}
        {toasts.map((t) => (
          <RadixToast.Root
            key={t.id}
            type={t.tone === 'error' ? 'foreground' : 'background'}
            onOpenChange={(open) => {
              if (!open) setToasts((prev) => prev.filter((x) => x.id !== t.id));
            }}
            className={cn(
              'rounded-md border bg-surface p-4 shadow-lg',
              t.tone === 'error'
                ? 'border-decline'
                : t.tone === 'success'
                  ? 'border-approve'
                  : 'border-border',
            )}
          >
            <RadixToast.Title className="text-sm font-semibold text-fg">{t.title}</RadixToast.Title>
            {t.description ? (
              <RadixToast.Description className="mt-1 text-sm text-fg-muted">
                {t.description}
              </RadixToast.Description>
            ) : null}
            <RadixToast.Close
              aria-label="Dismiss"
              className="absolute right-2 top-2 rounded-sm px-1 text-fg-muted"
            >
              ×
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
