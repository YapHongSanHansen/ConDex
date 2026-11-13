export function PageHeader({ title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-2 pb-6 pt-10 md:pt-12">
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
      {children && <p className="max-w-2xl text-sm text-muted">{children}</p>}
    </div>
  );
}

export const DISCLAIMER = "Reasoning shared by creators, not financial advice.";
