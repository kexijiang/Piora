import { readOrganizationAnalyticsStatus } from "@/lib/analytics-status";
export const dynamic = "force-dynamic";
export function GET() {
  try {
    return Response.json(readOrganizationAnalyticsStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Analytics status unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
