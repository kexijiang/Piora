import { readProviderOrder, validateProviderOrder, writeProviderOrder } from "@/lib/provider-order-store";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return Response.json({ providers: readProviderOrder() }); }
  catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
}

export async function PUT(req: Request) {
  let providers: string[];
  try { providers = validateProviderOrder((await req.json()).providers); }
  catch { return Response.json({ error: "Invalid provider order" }, { status: 400 }); }
  try {
    const saved = writeProviderOrder(providers);
    invalidateModelsCache();
    return Response.json({ providers: saved });
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
}
