import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PublishFlow } from "@/components/publish/publish-flow";

export const metadata = { title: "Publish · ConDex" };

export default function PublishPage() {
  return (
    <div className="container-wide space-y-8 pb-10">
      <PageHeader title="Publish">Define the thesis here, then have your agent publish it. It is minted on NEAR testnet.</PageHeader>
      <Suspense fallback={null}><PublishFlow /></Suspense>
    </div>
  );
}
