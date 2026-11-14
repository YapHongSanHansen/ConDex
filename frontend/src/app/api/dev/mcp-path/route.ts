// Development only. The backend tells a program on its own machine where its MCP server file is, but never a request that
// came through the website's proxy. This route asks it directly from the machine running `next dev`, so the Connect page
// can show the real path instead of a placeholder. In production there is no such path to report.
export async function GET() {
  if (process.env.NODE_ENV === "production") return Response.json({ path: null });
  try {
    const res = await fetch(`${process.env.BACKEND_URL ?? "http://localhost:8787"}/health`, { cache: "no-store" });
    const health = (await res.json()) as { mcp_server?: string };
    return Response.json({ path: health.mcp_server ?? null });
  } catch {
    return Response.json({ path: null });
  }
}
