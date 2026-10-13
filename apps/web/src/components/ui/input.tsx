import { forwardRef, useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const field =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-focus aria-[invalid=true]:border-decline';

interface FieldProps {
  label: string;
  error?: string | undefined;
  hint?: string;
}

/** Labelled input; the error is announced and linked with aria-describedby. */
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldProps
>(function Input({ label, error, hint, className, id, ...props }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium text-fg">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(field, className)}
        {...props}
      />
      {hint && !error ? (
        <p id={`${inputId}-hint`} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-decline">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps
>(function Textarea({ label, error, className, id, ...props }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium text-fg">
        {label}
      </label>
      <textarea
        ref={ref}
        id={inputId}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className={cn(field, className)}
        {...props}
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-decline">
          {error}
        </p>
      ) : null}
    </div>
  );
});
