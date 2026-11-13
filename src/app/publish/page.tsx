import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PublishFlow } from "@/components/publish/publish-flow";

export const metadata = { title: "Publish · ConDex" };

export default function PublishPage() {
  return (
    <div className="container-wide space-y-8 pb-10">
      <PageHeader title="Publish">Export from Claude Code, then register on NEAR testnet. Your chat is never uploaded.</PageHeader>
      <Suspense fallback={null}><PublishFlow /></Suspense>
    </div>
  );
}
