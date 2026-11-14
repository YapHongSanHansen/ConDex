import { PageHeader } from "@/components/layout/page-header";
import { CreatorSetup } from "@/components/keys/creator-setup";
import { OrdersTable } from "@/components/keys/orders-table";
import { AgentSteps } from "@/components/keys/snippets";

export const metadata = { title: "Connect your API · ConDex" };

export default function KeysPage() {
  return (
    <div className="container-wide space-y-12 pb-10">
      <PageHeader title="Connect your API">Keys are shown once and never stored here.</PageHeader>
      <CreatorSetup />
      <AgentSteps />
      <OrdersTable />
    </div>
  );
}
