import { handlePrediction } from "@/lib/input-prediction-server";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return handlePrediction(request, (await params).id); }
