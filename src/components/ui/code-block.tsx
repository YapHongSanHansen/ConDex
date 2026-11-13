import { CopyButton } from "./copy-button";

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="label-caps">{title ?? "request"}</span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}
