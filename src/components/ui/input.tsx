import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/70 disabled:opacity-50 aria-[invalid=true]:border-danger", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn("min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted/70 aria-[invalid=true]:border-danger", className)} {...props} />
));
Textarea.displayName = "Textarea";

export function Field({ label, htmlFor, help, error, children }: { label: string; htmlFor: string; help?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="label-caps block">{label}</label>
      {children}
      {error ? (
        <p id={`${htmlFor}-err`} role="alert" className="text-xs text-danger">{error}</p>
      ) : help ? (
        <p id={`${htmlFor}-help`} className="text-xs text-muted">{help}</p>
      ) : null}
    </div>
  );
}
