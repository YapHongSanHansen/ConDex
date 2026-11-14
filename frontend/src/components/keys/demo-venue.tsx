import { ExternalLink } from "lucide-react";
import { DEV_WALLET, MCP_API_URL } from "@/lib/config";

/**
 * A real fill comes from the execution route. While developing on this machine, the backend's test console can play that
 * route: fill, cancel or reject an order. The backend refuses those calls from the website itself, so this opens it directly.
 */
export function DemoVenueLink({ orderId }: { orderId: string }) {
  if (!DEV_WALLET) return null;
  return (
    <p className="text-xs text-muted">
      Demo only: fill this order from the backend&apos;s test console.{" "}
      <a className="inline-flex items-center gap-1 text-accent hover:underline" href={`${MCP_API_URL}/test`} target="_blank" rel="noreferrer">
        Open the test console <ExternalLink className="h-3 w-3" aria-hidden />
      </a>{" "}
      <span className="font-mono">{orderId}</span>
    </p>
  );
}
