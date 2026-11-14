import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { KeysTabs } from "@/components/keys/keys-tabs";

export const metadata = { title: "Keys & orders · ConDex" };

export default function KeysPage() {
  return (
    <div className="container-wide space-y-6 pb-10">
      <PageHeader title="Keys &amp; orders">Follow the orders you placed and close trades, or give an agent a key to publish, read and trade. Keys are shown once and never stored here.</PageHeader>
      <Suspense fallback={null}><KeysTabs /></Suspense>
    </div>
  );
}
