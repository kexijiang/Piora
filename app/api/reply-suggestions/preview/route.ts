import { handleReplyRequest } from "@/lib/reply-suggestions-server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleReplyRequest(request);
