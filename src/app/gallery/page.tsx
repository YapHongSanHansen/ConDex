import { GalleryView } from "@/components/gallery/gallery-view";
import { PageHeader } from "@/components/layout/page-header";

export const metadata = { title: "Gallery · ConDex" };

export default function GalleryPage() {
  return (
    <div className="container-wide pb-10">
      <PageHeader title="Gallery">Public previews only. The entry, invalidation and conversation unlock with a subscription.</PageHeader>
      <div className="pt-2"><GalleryView /></div>
    </div>
  );
}
