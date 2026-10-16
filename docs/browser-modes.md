# Browser modes

The **Settings > General > Use background browser** switch is **off by default**.
The selection is saved globally in `<agentDir>/piora/browser.json` and applies
to both the panel and subsequent agent `browser` tool calls. An open browser
panel updates after a successful save; reopening a panel loads the saved mode.

- **Off (`builtin`):** keep the current browser. On desktop this is Electron's
  embedded view with the existing `persist:piora-browser` partition. Web mode
  continues using the persistent Playwright browser and screenshot controls.
- **On (`background`):** use the original Playwright path, launching the installed
  Chrome/Edge with `headless: true`. No separate desktop window opens. The panel
  provides an interactive screenshot preview, and the agent uses the same
  background browser. No remote-debugging setup or connection prompt is needed.

## Sign-in persistence

Background mode keeps the original `<agentDir>/piora/browser-profile` directory,
including its `piora-storage-state.json` snapshot. Existing original-Piora
sign-ins are reused. New sign-ins persist locally across restarts through the
persistent browser profile, with missing session cookies recovered from the
snapshot. Refreshed cookies, local storage and IndexedDB are not overwritten
by an older snapshot.

Using the installed Chrome/Edge executable does not by itself share everyday
Chrome's profile. Background mode and the desktop embedded browser have separate
sign-ins. Users can sign in through the background browser's panel when needed;
site expiration and revocation still apply. Switching modes does not delete
either profile or its tabs.

`PIORA_BROWSER_EXECUTABLE` can select an executable; otherwise the original
platform-specific Chrome/Edge discovery order is retained. This mode does not
attach to the user's visible Chrome instance or copy Chrome's profile databases.
Unknown or obsolete mode values fall back to the current built-in browser.

## Agent linkage

In the desktop app, built-in mode lets the current session's agent operate that
session's real right-side browser, including while the panel stays closed.
Background mode and the web app keep using the Playwright browser. Sign-ins
stored in the previous Playwright profile are not copied into the desktop
built-in browser. Sign in once in the right-side browser when a site asks for
it. Login, captcha, two-factor, payment, and account-security pages ask the
user to take over with `wait_for_user` instead of the agent typing secrets.
