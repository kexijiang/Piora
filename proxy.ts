import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
  isLoopbackRequestHost,
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
    && !isLoopbackRequestHost(request)
    && !isDesktopTokenEnabled(desktopToken)
    && !isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)
  ) {
    const message = "Remote access requires PI_WEB_PASSWORD or PI_DESKTOP_TOKEN.";
    return isApiRequest
      ? NextResponse.json({ error: message }, { status: 403, headers: { "Cache-Control": "no-store" } })
      : new NextResponse(message, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

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

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
