import { CodeBlock } from "@/components/ui/code-block";

export const RETRIEVAL_SNIPPET = `GET  /v1/tokens/{token_id}          # read: needs a subscription
POST /v1/quotes                      # the fee for linking an order
POST /v1/orders                      # place it, authorising the fee
POST /v1/orders/{order_id}/close     # close the trade, no fee
Authorization: Bearer <cdx_… key>`;

export function KeyCapabilities() {
  return (
    <section aria-labelledby="key" className="grid gap-6 lg:grid-cols-2 lg:items-center">
      <div className="space-y-2">
        <p className="label-caps">The key</p>
        <h2 id="key" className="text-2xl font-semibold tracking-tight">What a key lets an agent do</h2>
        <p className="text-sm leading-relaxed text-muted">A key carries the access you choose: publish, read or trade. Reading needs a subscription. A filled linked order pays the creator once.</p>
      </div>
      <CodeBlock code={RETRIEVAL_SNIPPET} title="read and trade" />
    </section>
  );
}
