import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeAgentDataDirectory } from "@/lib/runtime-home";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isDesktopTokenEnabled,
  isValidDesktopToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_DESKTOP_TOKEN_HEADER,
} from "@/lib/web-auth";

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Remote control has its own capability-token boundary. Do not make a
  // remote client possess the local Desktop Token or Basic Auth secret as a
  // second credential; the route handlers still require Bearer capabilities.
  const isRemoteControlApi = request.nextUrl.pathname.startsWith("/api/remote/v1/");

  const desktopToken = process.env.PI_DESKTOP_TOKEN;
  if (
    !isRemoteControlApi
    &&
    isDesktopTokenEnabled(desktopToken)
    && !isValidDesktopToken(request.headers.get(PI_DESKTOP_TOKEN_HEADER), desktopToken)
  ) {
    if (isApiRequest) {
      return NextResponse.json({ error: "Desktop authentication required" }, { status: 403 });
    }
    return new NextResponse("Desktop authentication required", { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    !isRemoteControlApi
    &&
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  if (isApiRequest && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !request.nextUrl.pathname.startsWith("/api/settings/backup") && existsSync(join(`${getRuntimeAgentDataDirectory()}.piora-transfer`, "pending.json"))) {
    return NextResponse.json({ error: "Piora data import is ready. Restart the application to continue.", code: "backup_pending" }, { status: 503 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
