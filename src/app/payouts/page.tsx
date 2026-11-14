import { PageHeader } from "@/components/layout/page-header";
import { PayoutsView } from "@/components/payouts/payouts-view";

export const metadata = { title: "Payouts · ConDex" };

export default function PayoutsPage() {
  return (
    <div className="container-wide space-y-8 pb-10">
      <PageHeader title="Payouts">A fee is earned when an order linked to your thesis first fills, whatever the trade later returns.</PageHeader>
      <PayoutsView />
    </div>
  );
}
