# Undici 8.12.3 compatibility review

This dependency update keeps Piora's existing public Undici transport APIs and
the verified unbundled Pi 1.3.0 source profile. It does not change SDK source or
relax the integrity checks on the official SDK artifact.

## Reviewed upstream changes

The primary source is the [official 8.12.2…8.12.3 comparison](https://github.com/nodejs/undici/compare/v8.12.2...v8.12.3).
The runtime changes reviewed for Piora are:

- Pool requests waiting for a connection retain their caller's async context
  through an `AsyncResource` when drained. This affects diagnostics and tracing.
- HTTP/2 stream header/body timeouts initiate a bounded session liveness PING.
  Pending work waits for the result; a live peer resumes work and an unresponsive
  session is reset. The probe timeout has a one-second floor, and session close
  and GOAWAY clear it. This is connection recovery, not an increase to Piora's
  request deadline or a replay guarantee.

`lib/undici-runtime-compatibility.test.mjs` uses real loopback servers to verify
queued caller contexts, cancellation followed by successful dispatch, and an
HTTP/2 header timeout followed by successful queued work on the same healthy
session. The TLS test creates its own ephemeral certificate and disables
certificate verification only for that fixture. It does not change application
TLS behavior. These focused tests do not simulate every network failure.

## Dependency and packaging boundaries

The pre-existing root `overrides.undici = "$undici"` applies to the desktop build
dependencies as well as Pi. The updated lock removes the obsolete nested Undici
6/7 copies under node-gyp and @electron/get rather than adding a new override.
A fresh normal `npm ci`, `npm ls undici --all`, consumer-relative resolution and
public API probes verify that those consumers and Pi resolve the locked 8.12.3.
The existing proxy regression exercises HTTP_PROXY, HTTPS_PROXY and NO_PROXY;
native-image diagnostics and full CI retain their actual Electron/package gates.

Official registry metadata was checked for all four updated artifacts, including
their existing integrity values. Lockfile URLs use registry.npmjs.org. The license
inventory is regenerated from the final lock.

The legacy nested-copy patch accepts the previous reviewed 8.12.2 as an upgrade
source target, but still requires the replacement source to be exactly 8.12.3.
Tests retain rejection of unknown sources, unreviewed targets, symlinks, tampered
bytes, missing dependencies and embedded unverified code. Runtime audit, package
verification, license provenance and Pi's effective version certificate agree on
8.12.3. The SDK artifact integrity, manifest hash, unbundled source hash and
original bundle hash remain unchanged.

No release package, deployment or physical-device validation is performed by
these local checks. Exact-head CI remains the platform packaging gate.
