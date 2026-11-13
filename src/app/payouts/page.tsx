import { PageHeader } from "@/components/layout/page-header";
import { PayoutsView } from "@/components/payouts/payouts-view";

export const metadata = { title: "Payouts · ConDex" };

export default function PayoutsPage() {
  return (
    <div className="container-wide space-y-8 pb-10">
      <PageHeader title="Payouts">Fees are earned only when a borrower reports a trade. Reports are self-reported.</PageHeader>
      <PayoutsView />
    </div>
  );
}
