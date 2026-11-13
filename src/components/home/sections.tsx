import { CodeBlock } from "@/components/ui/code-block";

export const RETRIEVAL_SNIPPET = `GET /v1/borrows/{borrow_id}/insight
Authorization: Bearer <borrow-api-key>

POST /v1/borrows/{borrow_id}/trade-executed   # proposed
Authorization: Bearer <borrow-api-key>`;

export function KeyCapabilities() {
  return (
    <section aria-labelledby="key" className="grid gap-6 lg:grid-cols-2 lg:items-center">
      <div className="space-y-2">
        <p className="label-caps">The key</p>
        <h2 id="key" className="text-2xl font-semibold tracking-tight">What a key lets an agent do</h2>
        <p className="text-sm leading-relaxed text-muted">One key, one insight version, one expiry. Fetching is free. Reporting an executed trade charges the fee once.</p>
      </div>
      <CodeBlock code={RETRIEVAL_SNIPPET} title="retrieval" />
    </section>
  );
}
