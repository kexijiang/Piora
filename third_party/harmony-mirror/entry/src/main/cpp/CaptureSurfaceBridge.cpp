#include "CaptureSurfaceBridge.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <hilog/log.h>
#include <native_buffer/buffer_common.h>
#include <native_image/native_image.h>

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0xA000
#define LOG_TAG "ScrcpySurfaceBridge"

namespace scrcpy {

namespace {

constexpr std::array<GLfloat, 16> kVertices = {
    -1.0f, -1.0f, 0.0f, 0.0f,
     1.0f, -1.0f, 1.0f, 0.0f,
    -1.0f,  1.0f, 0.0f, 1.0f,
     1.0f,  1.0f, 1.0f, 1.0f,
};

constexpr const char *kVertexShader = R"(
attribute vec2 aPosition;
attribute vec2 aTextureCoordinate;
uniform mat4 uTextureTransform;
varying vec2 vTextureCoordinate;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vec4 transformed = uTextureTransform * vec4(aTextureCoordinate, 0.0, 1.0);
    vTextureCoordinate = transformed.xy;
}
)";

constexpr const char *kFragmentShader = R"(
#extension GL_OES_EGL_image_external : require
precision mediump float;
uniform samplerExternalOES uTexture;
varying vec2 vTextureCoordinate;
void main() {
    gl_FragColor = texture2D(uTexture, vTextureCoordinate);
}
)";

GLuint CompileShader(GLenum type, const char *source) {
    const auto shader = glCreateShader(type);
    if (shader == 0) {
        OH_LOG_ERROR(LOG_APP, "glCreateShader failed type=%{public}u error=0x%{public}x", type, glGetError());
        return 0;
    }
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint compiled = GL_FALSE;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if (compiled == GL_TRUE) return shader;
    GLint length = 0;
    glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &length);
    std::string log(length > 1 ? static_cast<size_t>(length) : 1, '\0');
    if (length > 1) glGetShaderInfoLog(shader, length, nullptr, log.data());
    OH_LOG_ERROR(LOG_APP, "shader compile failed: %{public}s", log.c_str());
    glDeleteShader(shader);
    return 0;
}

GLuint CreateProgram() {
    const auto vertex = CompileShader(GL_VERTEX_SHADER, kVertexShader);
    const auto fragment = CompileShader(GL_FRAGMENT_SHADER, kFragmentShader);
    if (vertex == 0 || fragment == 0) {
        if (vertex != 0) glDeleteShader(vertex);
        if (fragment != 0) glDeleteShader(fragment);
        return 0;
    }
    const auto program = glCreateProgram();
    glAttachShader(program, vertex);
    glAttachShader(program, fragment);
    glLinkProgram(program);
    glDeleteShader(vertex);
    glDeleteShader(fragment);
    GLint linked = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &linked);
    if (linked == GL_TRUE) return program;
    GLint length = 0;
    glGetProgramiv(program, GL_INFO_LOG_LENGTH, &length);
    std::string log(length > 1 ? static_cast<size_t>(length) : 1, '\0');
    if (length > 1) glGetProgramInfoLog(program, length, nullptr, log.data());
    OH_LOG_ERROR(LOG_APP, "program link failed: %{public}s", log.c_str());
    glDeleteProgram(program);
    return 0;
}

bool HasExtension(const char *extensions, const char *wanted) {
    if (extensions == nullptr || wanted == nullptr || *wanted == '\0' || std::strchr(wanted, ' ') != nullptr) {
        return false;
    }
    const auto wantedLength = std::strlen(wanted);
    const char *cursor = extensions;
    while ((cursor = std::strstr(cursor, wanted)) != nullptr) {
        const bool left = cursor == extensions || cursor[-1] == ' ';
        const bool right = cursor[wantedLength] == '\0' || cursor[wantedLength] == ' ';
        if (left && right) return true;
        cursor += wantedLength;
    }
    return false;
}

void DrainGlErrors(const char *stage) {
    for (int index = 0; index < 8; ++index) {
        const auto error = glGetError();
        if (error == GL_NO_ERROR) return;
        OH_LOG_WARN(LOG_APP, "discarding stale GL error after %{public}s: 0x%{public}x", stage, error);
    }
}

bool RequireNoGlError(const char *stage) {
    const auto error = glGetError();
    if (error == GL_NO_ERROR) return true;
    OH_LOG_ERROR(LOG_APP, "bridge GL stage failed after %{public}s: 0x%{public}x", stage, error);
    DrainGlErrors(stage);
    return false;
}

} // namespace

struct CaptureSurfaceBridge::Impl {
    struct FrameCallbackAnchor {
        Impl *owner = nullptr;
        uint64_t generation = 0;
    };

    struct WindowRequest {
        uint64_t sequence = 0;
        OHNativeWindow *window = nullptr;
        int32_t width = 0;
        int32_t height = 0;
    };

    mutable std::mutex mutex;
    std::condition_variable condition;
    std::thread renderThread;
    bool ready = false;
    bool readyResult = false;
    bool running = false;
    bool stopRequested = false;
    bool framePending = false;
    bool requestPending = false;
    bool requestResult = false;
    uint64_t nextRequestSequence = 0;
    uint64_t completedRequestSequence = 0;
    WindowRequest request;
    FailureCallback failureCallback = nullptr;
    void *failureContext = nullptr;
    OHNativeWindow *captureWindow = nullptr;
    std::vector<std::unique_ptr<FrameCallbackAnchor>> callbackAnchors;
    FrameCallbackAnchor *activeCallbackAnchor = nullptr;
    uint64_t callbackGeneration = 0;

    EGLDisplay display = EGL_NO_DISPLAY;
    EGLConfig config = nullptr;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface pbufferSurface = EGL_NO_SURFACE;
    EGLSurface encoderSurface = EGL_NO_SURFACE;
    int32_t outputWidth = 0;
    int32_t outputHeight = 0;
    GLuint texture = 0;
    GLuint program = 0;
    GLint positionLocation = -1;
    GLint textureLocation = -1;
    GLint transformLocation = -1;
    GLint samplerLocation = -1;
    OH_NativeImage *nativeImage = nullptr;
    PFNEGLPRESENTATIONTIMEANDROIDPROC presentationTime = nullptr;
    int64_t lastPresentationTimeNs = 0;
    std::array<float, 16> currentTransform{};
    bool hasCurrentImage = false;
    uint64_t updatedFrameCount = 0;
    uint64_t presentedFrameCount = 0;

    static void OnFrameAvailable(void *contextValue) {
        auto *anchor = static_cast<FrameCallbackAnchor *>(contextValue);
        auto *self = anchor != nullptr ? anchor->owner : nullptr;
        if (self == nullptr) return;
        // NativeImage forbids its APIs from this callback. Only wake the GL
        // thread, which consumes the newest queued image in drop-buffer mode.
        std::lock_guard<std::mutex> guard(self->mutex);
        if (!self->running || self->stopRequested || self->activeCallbackAnchor != anchor ||
            anchor->generation != self->callbackGeneration) return;
        self->framePending = true;
        self->condition.notify_one();
    }

    bool Initialize(OHNativeWindow *initialWindow, int32_t width, int32_t height) {
        display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (display == EGL_NO_DISPLAY || eglInitialize(display, nullptr, nullptr) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "eglInitialize failed error=0x%{public}x", eglGetError());
            return false;
        }
        const EGLint attributes[] = {
            EGL_SURFACE_TYPE, EGL_WINDOW_BIT | EGL_PBUFFER_BIT,
            EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 8,
            EGL_GREEN_SIZE, 8,
            EGL_BLUE_SIZE, 8,
            EGL_ALPHA_SIZE, 8,
            EGL_NONE,
        };
        const EGLint recordableAttributes[] = {
            EGL_SURFACE_TYPE, EGL_WINDOW_BIT | EGL_PBUFFER_BIT,
            EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
            EGL_RED_SIZE, 8,
            EGL_GREEN_SIZE, 8,
            EGL_BLUE_SIZE, 8,
            EGL_ALPHA_SIZE, 8,
            EGL_RECORDABLE_ANDROID, EGL_TRUE,
            EGL_NONE,
        };
        const bool recordableExtension = HasExtension(
            eglQueryString(display, EGL_EXTENSIONS), "EGL_ANDROID_recordable");
        EGLint configCount = 0;
        const auto *selectedAttributes = recordableExtension ? recordableAttributes : attributes;
        if (eglChooseConfig(display, selectedAttributes, &config, 1, &configCount) != EGL_TRUE || configCount != 1) {
            OH_LOG_ERROR(LOG_APP, "eglChooseConfig failed error=0x%{public}x", eglGetError());
            return false;
        }
        OH_LOG_INFO(LOG_APP, "EGL config selected recordableExtension=%{public}d", recordableExtension ? 1 : 0);
        if (eglBindAPI(EGL_OPENGL_ES_API) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "eglBindAPI failed error=0x%{public}x", eglGetError());
            return false;
        }
        const EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
        context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
        const EGLint pbufferAttributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
        pbufferSurface = eglCreatePbufferSurface(display, config, pbufferAttributes);
        if (context == EGL_NO_CONTEXT || pbufferSurface == EGL_NO_SURFACE ||
            eglMakeCurrent(display, pbufferSurface, pbufferSurface, context) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "EGL context/pbuffer creation failed error=0x%{public}x", eglGetError());
            return false;
        }
        if (eglQueryAPI() != EGL_OPENGL_ES_API || eglGetCurrentDisplay() != display ||
            eglGetCurrentContext() != context || eglGetCurrentSurface(EGL_DRAW) != pbufferSurface ||
            eglGetCurrentSurface(EGL_READ) != pbufferSurface) {
            OH_LOG_ERROR(LOG_APP, "EGL context did not become current on the render thread");
            return false;
        }
        const auto *glVersion = reinterpret_cast<const char *>(glGetString(GL_VERSION));
        if (glVersion == nullptr) {
            OH_LOG_ERROR(LOG_APP, "OpenGL ES dispatch unavailable after a successful eglMakeCurrent");
            return false;
        }
        OH_LOG_INFO(LOG_APP, "EGL context ready GL=%{public}s", glVersion);

        program = CreateProgram();
        if (program == 0) {
            OH_LOG_ERROR(LOG_APP, "bridge shader program creation failed");
            return false;
        }
        positionLocation = glGetAttribLocation(program, "aPosition");
        textureLocation = glGetAttribLocation(program, "aTextureCoordinate");
        transformLocation = glGetUniformLocation(program, "uTextureTransform");
        samplerLocation = glGetUniformLocation(program, "uTexture");
        if (positionLocation < 0 || textureLocation < 0 || transformLocation < 0 || samplerLocation < 0) {
            OH_LOG_ERROR(LOG_APP, "required bridge shader locations are unavailable");
            return false;
        }

        glGenTextures(1, &texture);
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, texture);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        nativeImage = OH_NativeImage_Create(texture, GL_TEXTURE_EXTERNAL_OES);
        if (texture == 0 || nativeImage == nullptr) {
            OH_LOG_ERROR(LOG_APP, "NativeImage creation failed");
            return false;
        }
        // NativeImage may use internal GL calls during construction. Do not
        // let a stale implementation error be attributed to the first frame;
        // every frame stage below is checked independently.
        DrainGlErrors("NativeImage initialization");
        if (__builtin_available(ohos 17.0.0, *)) {
            const auto dropResult = OH_NativeImage_SetDropBufferMode(nativeImage, true);
            if (dropResult != 0) {
                OH_LOG_ERROR(LOG_APP, "NativeImage drop-buffer mode failed: %{public}d", dropResult);
                return false;
            }
        }
        OH_OnFrameAvailableListener listener{};
        auto anchor = std::make_unique<FrameCallbackAnchor>();
        anchor->owner = this;
        {
            std::lock_guard<std::mutex> guard(mutex);
            anchor->generation = ++callbackGeneration;
            activeCallbackAnchor = anchor.get();
            callbackAnchors.push_back(std::move(anchor));
            listener.context = activeCallbackAnchor;
        }
        listener.onFrameAvailable = &Impl::OnFrameAvailable;
        if (OH_NativeImage_SetOnFrameAvailableListener(nativeImage, listener) != 0) {
            OH_LOG_ERROR(LOG_APP, "NativeImage frame listener registration failed");
            return false;
        }
        captureWindow = OH_NativeImage_AcquireNativeWindow(nativeImage);
        if (captureWindow == nullptr) {
            OH_LOG_ERROR(LOG_APP, "NativeImage capture window acquisition failed");
            return false;
        }
        if (HasExtension(eglQueryString(display, EGL_EXTENSIONS), "EGL_ANDROID_presentation_time")) {
            presentationTime = reinterpret_cast<PFNEGLPRESENTATIONTIMEANDROIDPROC>(
                eglGetProcAddress("eglPresentationTimeANDROID"));
        }
        return ReplaceEncoderSurface(initialWindow, width, height);
    }

    bool ReplaceEncoderSurface(OHNativeWindow *window, int32_t width, int32_t height) {
        if (display == EGL_NO_DISPLAY || context == EGL_NO_CONTEXT || pbufferSurface == EGL_NO_SURFACE) return false;
        if (eglMakeCurrent(display, pbufferSurface, pbufferSurface, context) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "park encoder surface failed error=0x%{public}x", eglGetError());
            return false;
        }
        if (encoderSurface != EGL_NO_SURFACE) {
            eglDestroySurface(display, encoderSurface);
            encoderSurface = EGL_NO_SURFACE;
        }
        outputWidth = 0;
        outputHeight = 0;
        if (window == nullptr) return true;
        if (width <= 0 || height <= 0) return false;
        int32_t previousFormat = -1;
        int32_t previousHeight = 0;
        int32_t previousWidth = 0;
        uint64_t previousUsage = 0;
        OH_NativeWindow_NativeWindowHandleOpt(window, GET_FORMAT, &previousFormat);
        OH_NativeWindow_NativeWindowHandleOpt(window, GET_BUFFER_GEOMETRY, &previousHeight, &previousWidth);
        OH_NativeWindow_NativeWindowHandleOpt(window, GET_USAGE, &previousUsage);
        const auto geometryResult = OH_NativeWindow_NativeWindowHandleOpt(
            window, SET_BUFFER_GEOMETRY, width, height);
        const auto formatResult = OH_NativeWindow_NativeWindowHandleOpt(
            window, SET_FORMAT, NATIVEBUFFER_PIXEL_FMT_RGBA_8888);
        if (geometryResult != 0 || formatResult != 0) {
            OH_LOG_ERROR(LOG_APP,
                         "configure encoder window failed geometry=%{public}d format=%{public}d",
                         geometryResult, formatResult);
            return false;
        }
        OH_LOG_INFO(LOG_APP,
                    "encoder window configured previous=%{public}dx%{public}d format=%{public}d "
                    "usage=%{public}llu target=%{public}dx%{public}d RGBA8888=%{public}d",
                    previousWidth, previousHeight, previousFormat,
                    static_cast<unsigned long long>(previousUsage), width, height,
                    static_cast<int32_t>(NATIVEBUFFER_PIXEL_FMT_RGBA_8888));
        encoderSurface = eglCreateWindowSurface(
            display, config, reinterpret_cast<EGLNativeWindowType>(window), nullptr);
        if (encoderSurface == EGL_NO_SURFACE ||
            eglMakeCurrent(display, encoderSurface, encoderSurface, context) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "attach encoder surface failed error=0x%{public}x", eglGetError());
            if (encoderSurface != EGL_NO_SURFACE) {
                eglDestroySurface(display, encoderSurface);
                encoderSurface = EGL_NO_SURFACE;
            }
            eglMakeCurrent(display, pbufferSurface, pbufferSurface, context);
            return false;
        }
        eglSwapInterval(display, 0);
        outputWidth = width;
        outputHeight = height;
        OH_LOG_INFO(LOG_APP, "encoder surface attached %{public}dx%{public}d", width, height);
        // A NativeImage callback may have been consumed while the encoder was
        // detached. Re-submit its current texture immediately: drop-buffer
        // mode does not promise another edge notification for an already
        // queued image, and a fresh surface encoder cannot emit SPS/PPS/IDR
        // until at least one buffer is swapped into it.
        if (!PresentCurrentImage(true)) {
            OH_LOG_ERROR(LOG_APP, "replacement encoder surface rejected the current NativeImage frame");
            return false;
        }
        return true;
    }

    bool UpdateCurrentImage() {
        if (nativeImage == nullptr || display == EGL_NO_DISPLAY || context == EGL_NO_CONTEXT) return false;
        const auto updateSurface = encoderSurface != EGL_NO_SURFACE ? encoderSurface : pbufferSurface;
        if (updateSurface == EGL_NO_SURFACE ||
            eglMakeCurrent(display, updateSurface, updateSurface, context) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "make NativeImage update surface current failed error=0x%{public}x", eglGetError());
            return false;
        }
        DrainGlErrors("NativeImage update surface activation");
        const auto updateResult = OH_NativeImage_UpdateSurfaceImage(nativeImage);
        if (updateResult != 0) {
            OH_LOG_ERROR(LOG_APP, "NativeImage update failed: %{public}d", updateResult);
            return false;
        }
        if (!RequireNoGlError("NativeImage update")) return false;
        std::array<float, 16> transform{};
        int32_t transformResult = 0;
        if (__builtin_available(ohos 12.0.0, *)) {
            transformResult = OH_NativeImage_GetTransformMatrixV2(nativeImage, transform.data());
        } else {
            transformResult = OH_NativeImage_GetTransformMatrix(nativeImage, transform.data());
        }
        if (transformResult != 0) {
            OH_LOG_ERROR(LOG_APP, "NativeImage transform failed: %{public}d", transformResult);
            return false;
        }
        currentTransform = transform;
        hasCurrentImage = true;
        ++updatedFrameCount;
        return true;
    }

    bool PresentCurrentImage(bool replayAfterAttach = false) {
        if (!hasCurrentImage || encoderSurface == EGL_NO_SURFACE || outputWidth <= 0 || outputHeight <= 0) {
            return true;
        }
        if (eglMakeCurrent(display, encoderSurface, encoderSurface, context) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "make encoder surface current failed error=0x%{public}x", eglGetError());
            return false;
        }
        DrainGlErrors("encoder surface activation");
        glViewport(0, 0, outputWidth, outputHeight);
        glUseProgram(program);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, texture);
        glUniform1i(samplerLocation, 0);
        glUniformMatrix4fv(transformLocation, 1, GL_FALSE, currentTransform.data());
        glEnableVertexAttribArray(static_cast<GLuint>(positionLocation));
        glEnableVertexAttribArray(static_cast<GLuint>(textureLocation));
        glVertexAttribPointer(static_cast<GLuint>(positionLocation), 2, GL_FLOAT, GL_FALSE,
                              4 * sizeof(GLfloat), kVertices.data());
        glVertexAttribPointer(static_cast<GLuint>(textureLocation), 2, GL_FLOAT, GL_FALSE,
                              4 * sizeof(GLfloat), kVertices.data() + 2);
        if (!RequireNoGlError("draw setup")) return false;
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
        glDisableVertexAttribArray(static_cast<GLuint>(positionLocation));
        glDisableVertexAttribArray(static_cast<GLuint>(textureLocation));
        if (!RequireNoGlError("draw")) return false;
        if (presentationTime != nullptr) {
            auto timestamp = std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
            if (timestamp <= lastPresentationTimeNs) timestamp = lastPresentationTimeNs + 1;
            lastPresentationTimeNs = timestamp;
            if (presentationTime(display, encoderSurface, static_cast<EGLnsecsANDROID>(timestamp)) != EGL_TRUE) {
                OH_LOG_WARN(LOG_APP, "eglPresentationTimeANDROID failed; continuing without explicit PTS error=0x%{public}x", eglGetError());
                presentationTime = nullptr;
            }
        }
        if (eglSwapBuffers(display, encoderSurface) != EGL_TRUE) {
            OH_LOG_ERROR(LOG_APP, "eglSwapBuffers failed error=0x%{public}x", eglGetError());
            return false;
        }
        ++presentedFrameCount;
        if (replayAfterAttach) {
            OH_LOG_INFO(LOG_APP,
                        "replayed current NativeImage frame after encoder attach updated=%{public}llu presented=%{public}llu",
                        static_cast<unsigned long long>(updatedFrameCount),
                        static_cast<unsigned long long>(presentedFrameCount));
        }
        return true;
    }

    bool RenderNewestFrame() {
        // Always consume the NativeImage callback, even while encoder
        // replacement has parked EGL on the pbuffer. Otherwise one callback
        // can be cleared without releasing the queued buffer and no later
        // edge is guaranteed. Attachment replays this cached texture.
        return UpdateCurrentImage() && PresentCurrentImage();
    }

    void Cleanup() {
        {
            std::lock_guard<std::mutex> guard(mutex);
            activeCallbackAnchor = nullptr;
            ++callbackGeneration;
        }
        if (display != EGL_NO_DISPLAY && context != EGL_NO_CONTEXT && pbufferSurface != EGL_NO_SURFACE) {
            eglMakeCurrent(display, pbufferSurface, pbufferSurface, context);
        }
        if (nativeImage != nullptr) {
            OH_NativeImage_UnsetOnFrameAvailableListener(nativeImage);
            // Destroy also releases the NativeWindow returned by
            // OH_NativeImage_AcquireNativeWindow; releasing it separately is
            // a double-release on the public NativeImage contract.
            OH_NativeImage_Destroy(&nativeImage);
            captureWindow = nullptr;
        }
        if (program != 0) { glDeleteProgram(program); program = 0; }
        if (texture != 0) { glDeleteTextures(1, &texture); texture = 0; }
        if (display != EGL_NO_DISPLAY && encoderSurface != EGL_NO_SURFACE) {
            eglDestroySurface(display, encoderSurface);
            encoderSurface = EGL_NO_SURFACE;
        }
        if (display != EGL_NO_DISPLAY && pbufferSurface != EGL_NO_SURFACE) {
            eglDestroySurface(display, pbufferSurface);
            pbufferSurface = EGL_NO_SURFACE;
        }
        if (display != EGL_NO_DISPLAY && context != EGL_NO_CONTEXT) {
            eglDestroyContext(display, context);
            context = EGL_NO_CONTEXT;
        }
        if (display != EGL_NO_DISPLAY) {
            eglTerminate(display);
            display = EGL_NO_DISPLAY;
        }
        config = nullptr;
        outputWidth = 0;
        outputHeight = 0;
        presentationTime = nullptr;
        lastPresentationTimeNs = 0;
        currentTransform.fill(0.0f);
        hasCurrentImage = false;
        updatedFrameCount = 0;
        presentedFrameCount = 0;
    }

    void Run(OHNativeWindow *initialWindow, int32_t width, int32_t height) {
        const bool initialized = Initialize(initialWindow, width, height);
        {
            std::lock_guard<std::mutex> guard(mutex);
            ready = true;
            readyResult = initialized;
            running = initialized;
            condition.notify_all();
        }
        bool runtimeFailure = false;
        if (initialized) {
            while (true) {
                WindowRequest next;
                bool handleRequest = false;
                bool handleFrame = false;
                {
                    std::unique_lock<std::mutex> lock(mutex);
                    condition.wait(lock, [this] {
                        return stopRequested || requestPending || framePending;
                    });
                    if (stopRequested) break;
                    if (requestPending) {
                        next = request;
                        requestPending = false;
                        handleRequest = true;
                    } else if (framePending) {
                        framePending = false;
                        handleFrame = true;
                    }
                }
                if (handleRequest) {
                    const bool result = ReplaceEncoderSurface(next.window, next.width, next.height);
                    {
                        std::lock_guard<std::mutex> guard(mutex);
                        requestResult = result;
                        completedRequestSequence = next.sequence;
                        condition.notify_all();
                    }
                    if (!result) break;
                    continue;
                }
                if (handleFrame && !RenderNewestFrame()) {
                    runtimeFailure = true;
                    break;
                }
            }
        }
        Cleanup();
        FailureCallback callback = nullptr;
        void *callbackContext = nullptr;
        {
            std::lock_guard<std::mutex> guard(mutex);
            running = false;
            captureWindow = nullptr;
            if (requestPending) {
                requestResult = false;
                completedRequestSequence = request.sequence;
                requestPending = false;
            }
            callback = runtimeFailure ? failureCallback : nullptr;
            callbackContext = failureContext;
            condition.notify_all();
        }
        if (callback != nullptr) callback(callbackContext);
    }
};

CaptureSurfaceBridge::CaptureSurfaceBridge() : impl_(std::make_unique<Impl>()) {}

CaptureSurfaceBridge::~CaptureSurfaceBridge() { Stop(); }

bool CaptureSurfaceBridge::Start(OHNativeWindow *encoderWindow, int32_t width, int32_t height,
                                 FailureCallback onFailure, void *failureContext) {
    if (encoderWindow == nullptr || width <= 0 || height <= 0) return false;
    Stop();
    auto &state = *impl_;
    {
        std::lock_guard<std::mutex> guard(state.mutex);
        state.ready = false;
        state.readyResult = false;
        state.running = false;
        state.stopRequested = false;
        state.framePending = false;
        state.requestPending = false;
        state.requestResult = false;
        state.nextRequestSequence = 0;
        state.completedRequestSequence = 0;
        state.failureCallback = onFailure;
        state.failureContext = failureContext;
    }
    state.renderThread = std::thread([&state, encoderWindow, width, height] {
        state.Run(encoderWindow, width, height);
    });
    bool readyResult = false;
    {
        std::unique_lock<std::mutex> lock(state.mutex);
        state.condition.wait(lock, [&state] { return state.ready; });
        readyResult = state.readyResult;
    }
    if (!readyResult && state.renderThread.joinable()) state.renderThread.join();
    return readyResult;
}

bool CaptureSurfaceBridge::SetEncoderWindow(OHNativeWindow *encoderWindow, int32_t width, int32_t height) {
    if (encoderWindow != nullptr && (width <= 0 || height <= 0)) return false;
    auto &state = *impl_;
    std::unique_lock<std::mutex> lock(state.mutex);
    if (!state.running || state.stopRequested || state.requestPending) return false;
    const auto sequence = ++state.nextRequestSequence;
    state.request = Impl::WindowRequest{sequence, encoderWindow, width, height};
    state.requestPending = true;
    state.condition.notify_one();
    state.condition.wait(lock, [&state, sequence] {
        return state.completedRequestSequence >= sequence || !state.running;
    });
    return state.completedRequestSequence >= sequence && state.requestResult;
}

OHNativeWindow *CaptureSurfaceBridge::CaptureWindow() const {
    std::lock_guard<std::mutex> guard(impl_->mutex);
    return impl_->running ? impl_->captureWindow : nullptr;
}

void CaptureSurfaceBridge::Stop() {
    auto &state = *impl_;
    {
        std::lock_guard<std::mutex> guard(state.mutex);
        if (state.renderThread.joinable()) {
            state.stopRequested = true;
            state.condition.notify_all();
        }
    }
    if (state.renderThread.joinable()) state.renderThread.join();
}

} // namespace scrcpy
