#ifndef PIORA_CAPTURE_SURFACE_BRIDGE_H
#define PIORA_CAPTURE_SURFACE_BRIDGE_H

#include <cstdint>
#include <memory>

#include <native_window/external_window.h>

namespace scrcpy {

// Keeps the ScreenCapture producer surface alive while video encoders are
// replaced. All NativeImage and EGL calls are confined to one render thread.
class CaptureSurfaceBridge {
public:
    using FailureCallback = void (*)(void *context);

    CaptureSurfaceBridge();
    ~CaptureSurfaceBridge();
    CaptureSurfaceBridge(const CaptureSurfaceBridge &) = delete;
    CaptureSurfaceBridge &operator=(const CaptureSurfaceBridge &) = delete;

    bool Start(OHNativeWindow *encoderWindow, int32_t width, int32_t height,
               FailureCallback onFailure, void *failureContext);
    bool SetEncoderWindow(OHNativeWindow *encoderWindow, int32_t width, int32_t height);
    OHNativeWindow *CaptureWindow() const;
    void Stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace scrcpy

#endif
