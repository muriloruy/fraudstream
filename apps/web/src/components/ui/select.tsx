import * as RadixSelect from '@radix-ui/react-select';
import { useId } from 'react';
import { cn } from '../../lib/cn';

export interface SelectOption {
  value: string;
  label: string;
}

/** Radix Select: full keyboard support (arrows, type-ahead, Esc) and ARIA listbox semantics. */
export function Select({
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <RadixSelect.Root value={value} onValueChange={onValueChange}>
        <RadixSelect.Trigger
          id={id}
          aria-labelledby={`${id}-label`}
          className="inline-flex h-10 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          <RadixSelect.Value />
          <RadixSelect.Icon aria-hidden>▾</RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-[var(--radix-select-trigger-width)] rounded-md border border-border bg-surface p-1 shadow-lg"
          >
            <RadixSelect.Viewport>
              {options.map((o) => (
                <RadixSelect.Item
                  key={o.value}
                  value={o.value}
                  className="cursor-pointer rounded-sm px-2 py-2 text-sm text-fg outline-none data-[highlighted]:bg-surface-muted data-[state=checked]:font-semibold"
                >
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
