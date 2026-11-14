import { InsightDetailView } from "@/components/gallery/insight-detail";

export const metadata = { title: "Thesis · ConDex" };

export default async function InsightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InsightDetailView id={id} />;
}
