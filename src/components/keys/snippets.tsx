"use client";

import { CodeBlock } from "@/components/ui/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_BASE_URL } from "@/lib/config";

const BASE = API_BASE_URL;
const SNIPPETS = {
  curl: `# 1. fetch the context (free)
curl "${BASE}/v1/borrows/BORROW_ID/insight" \\
  -H "Authorization: Bearer YOUR_BORROW_KEY"

# 2. only if you executed the trade: report it (charges the fee once)
curl -X POST "${BASE}/v1/borrows/BORROW_ID/trade-executed" \\
  -H "Authorization: Bearer YOUR_BORROW_KEY"`,
  ts: `const res = await fetch("${BASE}/v1/borrows/BORROW_ID/insight", {
  headers: { Authorization: "Bearer " + process.env.CONDEX_BORROW_KEY },
});
if (!res.ok) throw new Error("retrieval failed: " + res.status);
const insight = await res.json();`,
  py: `import os, requests

res = requests.get(
    "${BASE}/v1/borrows/BORROW_ID/insight",
    headers={"Authorization": f"Bearer {os.environ['CONDEX_BORROW_KEY']}"},
)
res.raise_for_status()
insight = res.json()`,
};

export function AgentSteps() {
  return (
    <section aria-labelledby="steps" className="grid min-w-0 gap-8 lg:grid-cols-[1fr_minmax(0,1.4fr)]">
      <div className="space-y-4">
        <h2 id="steps" className="text-lg font-semibold">Borrowers: use a key in your agent</h2>
        <ol className="space-y-3 text-sm leading-relaxed text-muted">
          <li><span className="font-mono text-accent">1.</span> Borrow an insight and copy the key. It is shown once.</li>
          <li><span className="font-mono text-accent">2.</span> Give your agent the borrow id and key. Never commit them.</li>
          <li><span className="font-mono text-accent">3.</span> Fetch the context for free. If the agent trades, it reports it and the fee is charged once.</li>
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
