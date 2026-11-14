"use client";

import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MCP_API_URL } from "@/lib/config";

// An agent calls the backend directly, so these use its real address, never this site's /backend path.
const BASE = MCP_API_URL;
const SNIPPETS = {
  curl: `# 1. read the full thesis (free)
curl "${BASE}/v1/tokens/TOKEN_ID" \\
  -H "Authorization: Bearer YOUR_KEY"

# 2. get the fee quote, then place an order linked to the thesis
#    (a long opens with a buy, a short with a sell)
curl -X POST "${BASE}/v1/quotes" \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"token_id":"TOKEN_ID"}'
curl -X POST "${BASE}/v1/orders" \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"quote_id":"QUOTE_ID","side":"sell","quantity":"1","authorise_fee":true}'

# 3. later, close the trade (no fee) to record its result
curl -X POST "${BASE}/v1/orders/ORDER_ID/close" \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{}'`,
  ts: `const call = (path: string, body?: unknown) =>
  fetch("${BASE}" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + process.env.CONDEX_API_KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());

const thesis = await call("/v1/tokens/TOKEN_ID");              // free
const quote = await call("/v1/quotes", { token_id: "TOKEN_ID" });
const order = await call("/v1/orders", {
  quote_id: quote.quote_id, side: "sell", quantity: "1", authorise_fee: true,
});`,
  py: `import os, requests

H = {"Authorization": f"Bearer {os.environ['CONDEX_API_KEY']}"}
BASE = "${BASE}"

thesis = requests.get(f"{BASE}/v1/tokens/TOKEN_ID", headers=H).json()  # free
quote = requests.post(f"{BASE}/v1/quotes", headers=H, json={"token_id": "TOKEN_ID"}).json()
order = requests.post(f"{BASE}/v1/orders", headers=H, json={
    "quote_id": quote["quote_id"], "side": "sell", "quantity": "1", "authorise_fee": True,
}).json()`,
};

export function AgentSteps() {
  return (
    <section aria-labelledby="steps" className="grid min-w-0 gap-8 lg:grid-cols-[1fr_minmax(0,1.4fr)]">
      <div className="space-y-4">
        <h2 id="steps" className="text-lg font-semibold">Borrowers: use a key in your agent</h2>
        <ol className="space-y-3 text-sm leading-relaxed text-muted">
          <li><span className="font-mono text-accent">1.</span> Create a key with Read and Trade access above. It is shown once. Never commit it.</li>
          <li><span className="font-mono text-accent">2.</span> Read a thesis for free. To trade on it, get a fee quote and place an order in its market and direction.</li>
          <li><span className="font-mono text-accent">3.</span> The fee is charged once, when the order first fills. Close the trade later, at no fee, to record its result.</li>
        </ol>
      </div>
      <Tabs defaultValue="curl" className="min-w-0">
        <TabsList aria-label="Language"><TabsTrigger value="curl">cURL</TabsTrigger><TabsTrigger value="ts">TypeScript</TabsTrigger><TabsTrigger value="py">Python</TabsTrigger></TabsList>
        <div className="pt-3">
          <TabsContent value="curl"><CodeBlock title="curl" code={SNIPPETS.curl} /></TabsContent>
          <TabsContent value="ts"><CodeBlock title="typescript · fetch" code={SNIPPETS.ts} /></TabsContent>
          <TabsContent value="py"><CodeBlock title="python · requests" code={SNIPPETS.py} /></TabsContent>
        </div>
      </Tabs>
    </section>
  );
}
