import { handleReplyRequest } from "@/lib/reply-suggestions-server";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleReplyRequest(request, (await params).id);
}
