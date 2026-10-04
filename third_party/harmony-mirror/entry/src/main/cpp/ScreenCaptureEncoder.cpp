#include "ScreenCaptureEncoder.h"
#include "CaptureSurfaceBridge.h"
#include "TcpServer.h"

#include <hilog/log.h>
#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avbuffer_info.h>
#include <multimedia/player_framework/native_avcapability.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcodec_videoencoder.h>
#include <multimedia/player_framework/native_averrors.h>
#include <multimedia/player_framework/native_avformat.h>
#include <multimedia/player_framework/native_avscreen_capture.h>
#include <multimedia/player_framework/native_avscreen_capture_base.h>
#include <multimedia/player_framework/native_avscreen_capture_errors.h>
#include <multimedia/image_framework/image/image_packer_native.h>
#include <multimedia/image_framework/image/pixelmap_native.h>
#include <multimedia/image_framework/image/image_common.h>
#include <native_buffer/native_buffer.h>
#include <native_window/external_window.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0xA000
#define LOG_TAG "ScrcpyCapture"

namespace scrcpy {

namespace {

constexpr int32_t kCodecH264 = 0;
constexpr int32_t kCodecRawRgba = 1;
constexpr int32_t kCodecJpeg = 2;
// JPEG 体积小，回到接近正常的帧率；RAW 兜底走 6fps 保护带宽。
constexpr int32_t kJpegFrameRate = 10;
constexpr int32_t kRawFrameRate = 6;

bool ConfigureCanvasFollowRotation(OH_AVScreenCapture *capture) {
    auto *strategy = OH_AVScreenCapture_CreateCaptureStrategy();
    if (strategy == nullptr) {
        OH_LOG_WARN(LOG_APP, "create capture rotation strategy failed");
        return false;
    }

    // API 20+ leaves the virtual-display dimensions fixed by default. The
    // native video transport follows the SPS geometry, so let ScreenCapture
    // swap its canvas with the physical display and emit a fresh format/IDR.
    const auto configure = OH_AVScreenCapture_StrategyForCanvasFollowRotation(strategy, true);
    const auto apply = configure == AV_SCREEN_CAPTURE_ERR_OK
        ? OH_AVScreenCapture_SetCaptureStrategy(capture, strategy)
        : configure;
    const auto release = OH_AVScreenCapture_ReleaseCaptureStrategy(strategy);
    OH_LOG_INFO(LOG_APP,
                "capture rotation strategy configure=%{public}d apply=%{public}d release=%{public}d",
                configure, apply, release);
    return configure == AV_SCREEN_CAPTURE_ERR_OK &&
        apply == AV_SCREEN_CAPTURE_ERR_OK && release == AV_SCREEN_CAPTURE_ERR_OK;
}

class CaptureSession {
public:
    static CaptureSession &Instance() {
        static CaptureSession s;
        return s;
    }

    bool IsStarted() const { return capture_started_.load(); }
    bool Start(const CaptureConfig &cfg);
    void Stop(uint64_t expectedEpoch = 0);
    void QueueStop(OH_AVScreenCapture *capture);
    bool Reconfigure(const CaptureConfig &cfg);
    bool RestartEncoder() {
        // Protocol 0x43 requests a fresh keyframe, without restarting capture
        // or opening another system consent dialog.
        std::lock_guard<std::mutex> lifecycle(lifecycle_mu_);
        OH_AVCodec *codec = nullptr;
        {
            std::lock_guard<std::mutex> guard(mu_);
            if (encoder_ == nullptr || capture_ == nullptr || stopping_.load()) return false;
            codec = encoder_;
        }
        OH_AVFormat *parameters = OH_AVFormat_Create();
        if (parameters == nullptr) return false;
        OH_AVFormat_SetIntValue(parameters, OH_MD_KEY_REQUEST_I_FRAME, 1);
        const auto result = OH_VideoEncoder_SetParameter(codec, parameters);
        OH_AVFormat_Destroy(parameters);
        OH_LOG_INFO(LOG_APP, "keyframe request result=%{public}d", result);
        return result == AV_ERR_OK;
    }
    void SetPaused(bool paused) {
        // Each desktop subscriber owns its connection. A client's congestion
        // must not pause other viewers or the recording subscriber.
        (void)paused;
    }

private:
    struct EncoderCallbackContext {
        CaptureSession *session;
        OH_AVCodec *codec;
        uint64_t epoch;
        uint64_t generation;
    };
    CaptureSession() = default;
    ~CaptureSession() { Stop(); }

    bool TryStartH264();
    bool StartH264EncoderLocked();
    bool StartSurfaceBridgeLocked();
    bool StartH264ScreenCaptureLocked();
    bool StartH264CaptureWithSurfaceLocked();
    void ApplyCaptureMaxFrameRateLocked();
    bool StartRaw();
    void StopResourcesWithLifecycleLock();
    bool IsCurrentEncoder(OH_AVCodec *codec, const EncoderCallbackContext *context);
    void QueueOwnedStop(OH_AVScreenCapture *capture, OH_AVCodec *encoder,
                       uint64_t expectedEpoch = 0, uint64_t expectedGeneration = 0);
    static void OnSurfaceBridgeError(void *context);

    static void OnEncOutput(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer, void *userData);
    static void OnEncInput(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer, void *userData);
    static void OnEncStreamChanged(OH_AVCodec *codec, OH_AVFormat *format, void *userData);
    static void OnEncError(OH_AVCodec *codec, int32_t errorCode, void *userData);
    static void OnScError(OH_AVScreenCapture *capture, int32_t errorCode, void *userData);
    static void OnScStateChange(OH_AVScreenCapture *capture, OH_AVScreenCaptureStateCode stateCode, void *userData);
    static void OnScVideoBuffer(OH_AVScreenCapture *capture, bool isReady);

    void HandleEncodedOutput(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer);
    void HandleRawBufferAvailable();
    // 把一帧 RGBA 像素编码成 JPEG 字节流；成功返回 true。失败则回落到 RAW。
    bool EncodeJpeg(const uint8_t *rgba, int32_t width, int32_t height,
                    std::vector<uint8_t> &out);

    void SendH264Config(const std::vector<uint8_t> &sps, const std::vector<uint8_t> &pps);
    void SendRawConfig(int32_t codec, int32_t width, int32_t height);
    void SendVideoFrame(bool keyframe, int64_t ptsUs, const uint8_t *nal, size_t size);
    int64_t NormalizeTimestampUs(int64_t sourcePts);

    bool ParseSpsPps(const uint8_t *data, int32_t size,
                     std::vector<uint8_t> &sps, std::vector<uint8_t> &pps, bool &malformed) const;
    bool HasMatchingIdr(const uint8_t *data, int32_t size, uint32_t ppsId) const;

    // mu_ 保护 capture_ / encoder_ / window_ 等指针；callback_mu_ 串行化回调进入临界区。
    std::mutex lifecycle_mu_;
    std::atomic<uint64_t> epoch_{0};
    std::atomic<uint64_t> encoder_generation_{0};
    std::atomic<uint64_t> pending_stop_epoch_{0};
    std::mutex mu_;
    std::mutex callback_mu_;
    // stopping_ 用作回调快速短路标志（无锁），保证 Stop 期间不会再触发新的下发。
    std::atomic<bool> capture_started_{false};
    std::atomic<bool> stopping_{false};
    std::atomic<bool> encoder_reconfiguring_{false};
    std::atomic<bool> encoder_paused_{false};  // 客户端背压：暂停向 TCP 发送编码帧
    OH_AVScreenCapture *capture_ = nullptr;
    OH_AVCodec *encoder_ = nullptr;
    std::unique_ptr<EncoderCallbackContext> encoder_context_;
    OHNativeWindow *window_ = nullptr;
    CaptureSurfaceBridge surface_bridge_;
    CaptureConfig cfg_{};
    CaptureConfig capture_cfg_{};
    int32_t described_width_ = 0;
    int32_t described_height_ = 0;
    int32_t raw_described_width_ = 0;
    int32_t raw_described_height_ = 0;
    bool configEmitted_ = false;
    H264StreamGate h264_gate_;
    int32_t mode_ = kCodecH264;
    std::vector<uint8_t> sps_;
    std::vector<uint8_t> pps_;
    // ImagePacker 在整个会话期间复用，避免每帧 Create/Release 的开销。
    OH_ImagePackerNative *imagePacker_ = nullptr;
    OH_PackingOptions *packingOptions_ = nullptr;
    // RAW 路径的缓冲：rawBuf_ 复用去 stride 后的像素，jpegBuf_ 复用 JPEG 输出。
    std::vector<uint8_t> rawBuf_;
    std::vector<uint8_t> jpegBuf_;

    std::atomic<int64_t> lastRawEmitMs_{0};
    std::mutex pts_mu_;
    TransportTimestampClock timestampClock_;
};

bool CaptureSession::Start(const CaptureConfig &cfg) {
    std::lock_guard<std::mutex> lifecycle(lifecycle_mu_);
    std::unique_lock<std::mutex> g(mu_);
    if (capture_ != nullptr || encoder_ != nullptr) {
        OH_LOG_WARN(LOG_APP, "Start: session already running (capture=%p encoder=%p)",
                    (void *)capture_, (void *)encoder_);
        return false;
    }
    epoch_.fetch_add(1);
    pending_stop_epoch_.store(0);
    capture_started_.store(false);
    stopping_.store(false);
    encoder_reconfiguring_.store(false);
    cfg_ = cfg;
    capture_cfg_ = cfg;
    described_width_ = 0;
    described_height_ = 0;
    raw_described_width_ = 0;
    raw_described_height_ = 0;
    {
        std::lock_guard<std::mutex> ptsGuard(pts_mu_);
        timestampClock_.Reset();
    }
    configEmitted_ = false;
    h264_gate_.Reset();
    sps_.clear();
    pps_.clear();
    lastRawEmitMs_ = 0;
    g.unlock();

    if (TryStartH264()) {
        mode_ = kCodecH264;
        OH_LOG_INFO(LOG_APP, "H264 request accepted; awaiting system STARTED and encoded frames (target %{public}d fps)", cfg_.frameRate);
        return true;
    }
    // This probe requires actual H.264; never substitute screenshot/JPEG output.
    stopping_.store(true);
    // Stop/Destroy wait for callbacks. Do not hold their data mutex while
    // calling device APIs, including cleanup of a partially started encoder.
    StopResourcesWithLifecycleLock();
    return false;
}

bool CaptureSession::TryStartH264() {
    // A normal application requests capture consent once, on its actual session.
    // A disposable preflight session would show a second system consent dialog.
    return StartH264EncoderLocked() && StartSurfaceBridgeLocked() && StartH264ScreenCaptureLocked();
}

bool CaptureSession::StartSurfaceBridgeLocked() {
    OHNativeWindow *encoderWindow = nullptr;
    CaptureConfig encoderConfig{};
    {
        std::lock_guard<std::mutex> guard(mu_);
        encoderWindow = window_;
        encoderConfig = capture_cfg_;
    }
    const bool started = surface_bridge_.Start(
        encoderWindow, encoderConfig.width, encoderConfig.height,
        &CaptureSession::OnSurfaceBridgeError, this);
    if (!started) OH_LOG_ERROR(LOG_APP, "capture surface bridge start failed");
    return started;
}

bool CaptureSession::StartH264EncoderLocked() {
    CaptureConfig encoderConfig{};
    {
        std::lock_guard<std::mutex> guard(mu_);
        encoderConfig = capture_cfg_;
    }
    OH_AVCapability *cap = OH_AVCodec_GetCapability(OH_AVCODEC_MIMETYPE_VIDEO_AVC, true);
    if (cap == nullptr) {
        OH_LOG_INFO(LOG_APP, "no AVC encoder capability on this device");
        return false;
    }
    const char *encName = OH_AVCapability_GetName(cap);
    OH_LOG_INFO(LOG_APP, "encoder cap: %{public}s", encName ? encName : "(null)");
    // This component fails if real H.264 surface conversion is unsupported.
    if (encName != nullptr && strstr(encName, ".rk.") != nullptr) {
        OH_LOG_WARN(LOG_APP, "RK encoder detected, skip H264 (no RGBA->NV12 support)");
        return false;
    }
    if (encName != nullptr) {
        encoder_ = OH_VideoEncoder_CreateByName(encName);
    }
    if (encoder_ == nullptr) {
        encoder_ = OH_VideoEncoder_CreateByMime(OH_AVCODEC_MIMETYPE_VIDEO_AVC);
    }
    if (encoder_ == nullptr) {
        return false;
    }

    const auto generation = encoder_generation_.fetch_add(1) + 1;
    encoder_context_ = std::make_unique<EncoderCallbackContext>(
        EncoderCallbackContext{this, encoder_, epoch_.load(), generation});

    OH_AVCodecCallback encCb{};
    encCb.onError = &CaptureSession::OnEncError;
    encCb.onStreamChanged = &CaptureSession::OnEncStreamChanged;
    encCb.onNeedInputBuffer = &CaptureSession::OnEncInput;
    encCb.onNewOutputBuffer = &CaptureSession::OnEncOutput;
    if (OH_VideoEncoder_RegisterCallback(encoder_, encCb, encoder_context_.get()) != AV_ERR_OK) {
        OH_LOG_WARN(LOG_APP, "encoder RegisterCallback failed");
        return false;
    }

    OH_AVFormat *fmt = OH_AVFormat_Create();
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_WIDTH, encoderConfig.width);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_HEIGHT, encoderConfig.height);
    // Public AVCodec contract: surface input uses SURFACE_FORMAT so the
    // encoder consumes the EGL producer without pretending it is NV12 bytes.
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_SURFACE_FORMAT);
    OH_AVFormat_SetDoubleValue(fmt, OH_MD_KEY_FRAME_RATE, static_cast<double>(encoderConfig.frameRate));
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_BITRATE, encoderConfig.bitrate);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_I_FRAME_INTERVAL, 2000);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_PROFILE, AVC_PROFILE_MAIN);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_VIDEO_ENCODE_BITRATE_MODE, VBR);
    if (__builtin_available(ohos 18.0.0, *)) {
        // Surface 无新画面时由编码器重复编码上一帧，生成 frame_num/POC 连续的
        // 合法 P 帧。避免客户端复制压缩数据，也不再周期性停启 ScreenCapture。
        OH_AVFormat_SetIntValue(
            fmt, OH_MD_KEY_VIDEO_ENCODER_REPEAT_PREVIOUS_FRAME_AFTER, 100);
        OH_AVFormat_SetIntValue(
            fmt, OH_MD_KEY_VIDEO_ENCODER_REPEAT_PREVIOUS_MAX_COUNT, -1);
    }
    auto ret = OH_VideoEncoder_Configure(encoder_, fmt);
    OH_AVFormat_Destroy(fmt);
    if (ret != AV_ERR_OK) {
        OH_LOG_WARN(LOG_APP, "encoder configure failed: %{public}d", ret);
        return false;
    }
    if (OH_VideoEncoder_GetSurface(encoder_, &window_) != AV_ERR_OK || window_ == nullptr) {
        OH_LOG_WARN(LOG_APP, "encoder get surface failed");
        return false;
    }
    if (OH_VideoEncoder_Prepare(encoder_) != AV_ERR_OK) {
        OH_LOG_WARN(LOG_APP, "encoder prepare failed");
        return false;
    }
    if (OH_VideoEncoder_Start(encoder_) != AV_ERR_OK) {
        OH_LOG_WARN(LOG_APP, "encoder start failed");
        return false;
    }
    return true;
}

bool CaptureSession::StartH264ScreenCaptureLocked() {
    capture_ = OH_AVScreenCapture_Create();
    if (capture_ == nullptr) {
        OH_LOG_WARN(LOG_APP, "OH_AVScreenCapture_Create failed");
        return false;
    }
    if (!ConfigureCanvasFollowRotation(capture_)) {
        OH_LOG_WARN(LOG_APP, "capture rotation strategy failed");
        return false;
    }

    // 显式构造 config，禁用音频（micCapInfo / innerCapInfo / audioEncInfo 全置 0）。
    OH_AVScreenCaptureConfig screenCfg{};
    screenCfg.captureMode = OH_CAPTURE_HOME_SCREEN;
    screenCfg.dataType = OH_ORIGINAL_STREAM;
    screenCfg.audioInfo.micCapInfo.audioSampleRate = 0;
    screenCfg.audioInfo.micCapInfo.audioChannels = 0;
    screenCfg.audioInfo.innerCapInfo.audioSampleRate = 0;
    screenCfg.audioInfo.innerCapInfo.audioChannels = 0;
    screenCfg.videoInfo.videoCapInfo.videoFrameWidth = capture_cfg_.width;
    screenCfg.videoInfo.videoCapInfo.videoFrameHeight = capture_cfg_.height;
    screenCfg.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;


    auto err = OH_AVScreenCapture_Init(capture_, screenCfg);
    if (err != AV_SCREEN_CAPTURE_ERR_OK) {
        OH_LOG_WARN(LOG_APP, "screen capture init failed: %{public}d", err);
        return false;
    }
    // Register all required callbacks before Start and verify every device reply.
    const auto mic = OH_AVScreenCapture_SetMicrophoneEnabled(capture_, false);
    const auto errorCallback = OH_AVScreenCapture_SetErrorCallback(capture_, &CaptureSession::OnScError, this);
    const auto stateCallback = OH_AVScreenCapture_SetStateCallback(capture_, &CaptureSession::OnScStateChange, this);
    OH_LOG_INFO(LOG_APP, "capture setup mic=%{public}d errorCallback=%{public}d stateCallback=%{public}d", mic, errorCallback, stateCallback);
    if (mic != AV_SCREEN_CAPTURE_ERR_OK || errorCallback != AV_SCREEN_CAPTURE_ERR_OK || stateCallback != AV_SCREEN_CAPTURE_ERR_OK) return false;
    return StartH264CaptureWithSurfaceLocked();
}

bool CaptureSession::StartH264CaptureWithSurfaceLocked() {
    auto *captureWindow = surface_bridge_.CaptureWindow();
    if (captureWindow == nullptr) {
        OH_LOG_WARN(LOG_APP, "start capture(surface) failed: bridge producer is unavailable");
        return false;
    }
    auto err = OH_AVScreenCapture_StartScreenCaptureWithSurface(capture_, captureWindow);
    if (err != AV_SCREEN_CAPTURE_ERR_OK) {
        OH_LOG_WARN(LOG_APP, "start capture(surface) failed: %{public}d", err);
        return false;
    }
    return true;
}

void CaptureSession::ApplyCaptureMaxFrameRateLocked() {
    if (capture_ == nullptr || cfg_.frameRate <= 0) {
        OH_LOG_WARN(LOG_APP,
                    "skip invalid capture max frame rate: capture=%p fps=%{public}d",
                    static_cast<void *>(capture_), cfg_.frameRate);
        return;
    }
    auto err = OH_AVScreenCapture_SetMaxVideoFrameRate(capture_, cfg_.frameRate);
    if (err == AV_SCREEN_CAPTURE_ERR_OK) {
        OH_LOG_INFO(LOG_APP, "capture max frame rate set to %{public}d", cfg_.frameRate);
    } else {
        // 部分设备当前可能尚未真正支持该接口；不让限帧失败影响已有视频链路。
        OH_LOG_WARN(LOG_APP,
                    "set capture max frame rate %{public}d failed: %{public}d",
                    cfg_.frameRate, err);
    }
}

bool CaptureSession::StartRaw() {
    capture_ = OH_AVScreenCapture_Create();
    if (capture_ == nullptr) {
        OH_LOG_ERROR(LOG_APP, "OH_AVScreenCapture_Create failed");
        return false;
    }
    if (!ConfigureCanvasFollowRotation(capture_)) {
        OH_LOG_ERROR(LOG_APP, "capture rotation strategy failed");
        return false;
    }

    OH_AVScreenCaptureConfig screenCfg{};
    screenCfg.captureMode = OH_CAPTURE_HOME_SCREEN;
    screenCfg.dataType = OH_ORIGINAL_STREAM;
    screenCfg.videoInfo.videoCapInfo.videoFrameWidth = cfg_.width;
    screenCfg.videoInfo.videoCapInfo.videoFrameHeight = cfg_.height;
    screenCfg.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;
    screenCfg.audioInfo.micCapInfo.audioSampleRate = 0;
    screenCfg.audioInfo.micCapInfo.audioChannels = 0;
    screenCfg.audioInfo.innerCapInfo.audioSampleRate = 0;
    screenCfg.audioInfo.innerCapInfo.audioChannels = 0;

    // 与 H264 路径对齐：先 SetMic / SetErrorCb / SetStateCb / SetCallback，再 Init，再 Start。
    // OH 的某些版本上回调注册必须早于 Init，否则首帧后回调链路被吞。
    OH_AVScreenCapture_SetMicrophoneEnabled(capture_, false);
    OH_AVScreenCapture_SetErrorCallback(capture_, &CaptureSession::OnScError, this);
    OH_AVScreenCapture_SetStateCallback(capture_, &CaptureSession::OnScStateChange, this);

    OH_AVScreenCaptureCallback cb{};
    cb.onError = nullptr;
    cb.onAudioBufferAvailable = nullptr;
    cb.onVideoBufferAvailable = &CaptureSession::OnScVideoBuffer;
    OH_AVScreenCapture_SetCallback(capture_, cb);

    auto err = OH_AVScreenCapture_Init(capture_, screenCfg);
    if (err != AV_SCREEN_CAPTURE_ERR_OK) {
        OH_LOG_ERROR(LOG_APP, "RAW capture init failed: %{public}d", err);
        return false;
    }

    err = OH_AVScreenCapture_StartScreenCapture(capture_);
    if (err != AV_SCREEN_CAPTURE_ERR_OK) {
        OH_LOG_ERROR(LOG_APP, "RAW capture start failed: %{public}d", err);
        return false;
    }
    ApplyCaptureMaxFrameRateLocked();
    return true;
}

void CaptureSession::Stop(uint64_t expectedEpoch) {
    std::lock_guard<std::mutex> lifecycle(lifecycle_mu_);
    if (expectedEpoch != 0 && expectedEpoch != epoch_.load()) return;
    StopResourcesWithLifecycleLock();
}

bool CaptureSession::Reconfigure(const CaptureConfig &cfg) {
    if (cfg.width <= 0 || cfg.height <= 0 || cfg.frameRate <= 0 || cfg.bitrate <= 0) return false;
    std::lock_guard<std::mutex> lifecycle(lifecycle_mu_);
    OH_AVCodec *oldEncoder = nullptr;
    OHNativeWindow *oldWindow = nullptr;
    std::unique_ptr<EncoderCallbackContext> oldContext;
    {
        std::lock_guard<std::mutex> guard(mu_);
        if (stopping_.load() || capture_ == nullptr || encoder_ == nullptr || mode_ != kCodecH264) return false;
        if (capture_cfg_.width == cfg.width && capture_cfg_.height == cfg.height &&
            capture_cfg_.frameRate == cfg.frameRate && capture_cfg_.bitrate == cfg.bitrate) return true;
    }

    encoder_reconfiguring_.store(true);
    TcpServer::Instance().InvalidateVideoConfig();
    // The GL thread must park on its pbuffer before the application destroys
    // the EGL window's encoder-owned NativeWindow.
    if (!surface_bridge_.SetEncoderWindow(nullptr, 0, 0)) {
        OH_LOG_ERROR(LOG_APP, "encoder reconfigure could not detach the output surface");
        encoder_reconfiguring_.store(false);
        stopping_.store(true);
        StopResourcesWithLifecycleLock();
        return false;
    }

    // Finish every callback holding an output buffer before Flush invalidates
    // it. Device calls below run without callback_mu_: codec implementations
    // are allowed to call registered callbacks synchronously while stopping.
    {
        std::lock_guard<std::mutex> callback(callback_mu_);
    }
    {
        std::lock_guard<std::mutex> guard(mu_);
        oldEncoder = encoder_;
        encoder_ = nullptr;
        oldWindow = window_;
        window_ = nullptr;
        oldContext = std::move(encoder_context_);
    }
    if (oldEncoder != nullptr) {
        OH_VideoEncoder_Flush(oldEncoder);
        OH_VideoEncoder_Stop(oldEncoder);
    }
    if (oldWindow != nullptr) OH_NativeWindow_DestroyNativeWindow(oldWindow);
    if (oldEncoder != nullptr) OH_VideoEncoder_Destroy(oldEncoder);
    oldContext.reset();

    {
        std::lock_guard<std::mutex> guard(mu_);
        capture_cfg_ = cfg;
        cfg_ = cfg;
        described_width_ = 0;
        described_height_ = 0;
        configEmitted_ = false;
        h264_gate_.Reset();
        sps_.clear();
        pps_.clear();
    }
    {
        // A replacement codec starts a new callback-time origin while the
        // transport clock remains strictly monotonic for existing viewers.
        std::lock_guard<std::mutex> ptsGuard(pts_mu_);
        timestampClock_.BeginGeneration();
    }
    // Generation identity now rejects every callback retained by the old
    // codec. The new codec may publish callbacks after Start returns.
    encoder_reconfiguring_.store(false);
    if (!StartH264EncoderLocked()) {
        OH_LOG_ERROR(LOG_APP, "encoder reconfigure failed while creating %{public}dx%{public}d", cfg.width, cfg.height);
        stopping_.store(true);
        StopResourcesWithLifecycleLock();
        return false;
    }
    OHNativeWindow *newWindow = nullptr;
    {
        std::lock_guard<std::mutex> guard(mu_);
        newWindow = window_;
    }
    if (!surface_bridge_.SetEncoderWindow(newWindow, cfg.width, cfg.height)) {
        OH_LOG_ERROR(LOG_APP, "encoder reconfigure failed while attaching %{public}dx%{public}d", cfg.width, cfg.height);
        stopping_.store(true);
        StopResourcesWithLifecycleLock();
        return false;
    }
    ApplyCaptureMaxFrameRateLocked();
    OH_LOG_INFO(LOG_APP,
                "encoder reconfigured without restarting ScreenCapture epoch=%{public}llu generation=%{public}llu %{public}dx%{public}d",
                static_cast<unsigned long long>(epoch_.load()),
                static_cast<unsigned long long>(encoder_generation_.load()), cfg.width, cfg.height);
    return true;
}

void CaptureSession::StopResourcesWithLifecycleLock() {
    // 1. 先打 stopping 标志，让回调拿到旗子后立即短路返回（即便 mu_ 被持有）。
    capture_started_.store(false);
    stopping_.store(true);

    // 2. 取出指针并清空，让任何还没排队的回调拿不到 capture_/encoder_。
    OH_AVScreenCapture *c = nullptr;
    OH_AVCodec *enc = nullptr;
    OHNativeWindow *window = nullptr;
    std::unique_ptr<EncoderCallbackContext> encoderContext;
    int32_t mode = kCodecH264;
    bool hadCapture = false;
    {
        std::lock_guard<std::mutex> g(mu_);
        c = capture_;
        hadCapture = c != nullptr;
        capture_ = nullptr;
        enc = encoder_;
        encoder_ = nullptr;
        encoderContext = std::move(encoder_context_);
        window = window_;
        window_ = nullptr;
        mode = mode_;
    }

    // 3. 先停掉源（截屏），让 surface/RGBA buffer 不再产生新帧。
    if (c != nullptr) {
        auto ret = OH_AVScreenCapture_StopScreenCapture(c);
        OH_LOG_INFO(LOG_APP, "Stop: StopScreenCapture ret=%{public}d", ret);
    }

    // Release ScreenCapture while its borrowed NativeImage producer window is
    // still alive, then stop/join the only thread allowed to touch that image.
    if (c != nullptr) {
        OH_AVScreenCapture_Release(c);
        c = nullptr;
    }
    surface_bridge_.Stop();

    // 4. Wait for an output callback already reading its OH_AVBuffer before
    // Flush invalidates that buffer. stopping_ fences all later callbacks.
    {
        std::lock_guard<std::mutex> cg(callback_mu_);
    }
    // SDK calls may wait for or invoke callbacks. Never retain callback_mu_
    // across them; callbacks that raced the barrier recheck stopping_/epoch.
    if (enc != nullptr) {
        OH_VideoEncoder_Flush(enc);
        OH_VideoEncoder_Stop(enc);
    }

    // 5. Release the producer before its destination window. GetSurface gives
    // the application an owned OHNativeWindow reference; dropping the pointer
    // alone leaks it. The callback context stays alive until Destroy completes.
    if (window != nullptr) {
        OH_NativeWindow_DestroyNativeWindow(window);
    }
    if (enc != nullptr) {
        OH_VideoEncoder_Destroy(enc);
    }
    encoderContext.reset();
    // ImagePacker / PackingOptions 在 Stop 时统一释放，下次 Start 重新创建。
    if (packingOptions_ != nullptr) {
        OH_PackingOptions_Release(packingOptions_);
        packingOptions_ = nullptr;
    }
    if (imagePacker_ != nullptr) {
        OH_ImagePackerNative_Release(imagePacker_);
        imagePacker_ = nullptr;
    }
    rawBuf_.clear();
    rawBuf_.shrink_to_fit();
    jpegBuf_.clear();
    jpegBuf_.shrink_to_fit();

    OH_LOG_INFO(LOG_APP, "capture stopped (mode=%{public}d)", mode);
    // An initial no-op Stop may run while the first viewer waits for consent.
    // Only close subscribers when this Stop actually owned a capture or codec;
    // otherwise the new viewer is disconnected before its first video frame.
    if (hadCapture || enc != nullptr || window != nullptr) TcpServer::Instance().ClearVideoConfig();
}

// ----- H264 callbacks -----

bool CaptureSession::IsCurrentEncoder(OH_AVCodec *codec, const EncoderCallbackContext *context) {
    if (context == nullptr || context->session != this || stopping_.load() || encoder_reconfiguring_.load()) return false;
    std::lock_guard<std::mutex> guard(mu_);
    return !stopping_.load() && !encoder_reconfiguring_.load() && encoder_ == codec && context->codec == codec &&
        encoder_context_.get() == context && epoch_.load() == context->epoch &&
        encoder_generation_.load() == context->generation;
}

void CaptureSession::OnEncOutput(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer, void *userData) {
    auto *context = static_cast<EncoderCallbackContext *>(userData);
    auto *self = context != nullptr ? context->session : nullptr;
    if (self == nullptr) return;
    // callback_mu_ 串行化所有 encoder 回调，与 Stop 同步。
    std::lock_guard<std::mutex> cg(self->callback_mu_);
    if (!self->IsCurrentEncoder(codec, context)) {
        // A callback already admitted by the old codec still owns its output
        // index even after the generation is fenced. Release it before the
        // lifecycle thread flushes/destroys that codec.
        if (codec != nullptr && context->codec == codec) OH_VideoEncoder_FreeOutputBuffer(codec, index);
        return;
    }
    self->HandleEncodedOutput(codec, index, buffer);
}
void CaptureSession::OnEncInput(OH_AVCodec *, uint32_t, OH_AVBuffer *, void *) {}
void CaptureSession::OnEncStreamChanged(OH_AVCodec *codec, OH_AVFormat *format, void *userData) {
    auto *context = static_cast<EncoderCallbackContext *>(userData);
    auto *self = context != nullptr ? context->session : nullptr;
    if (self == nullptr || format == nullptr || self->stopping_.load()) return;
    std::lock_guard<std::mutex> callback(self->callback_mu_);
    if (!self->IsCurrentEncoder(codec, context)) return;
    int32_t w = 0, h = 0;
    OH_AVFormat_GetIntValue(format, OH_MD_KEY_WIDTH, &w);
    OH_AVFormat_GetIntValue(format, OH_MD_KEY_HEIGHT, &h);
    OH_LOG_INFO(LOG_APP, "encoder stream changed %{public}dx%{public}d", w, h);
    if (w > 0 && h > 0) {
        std::lock_guard<std::mutex> g(self->mu_);
        const bool changed = self->described_width_ != 0 &&
            (self->described_width_ != w || self->described_height_ != h);
        self->described_width_ = w;
        self->described_height_ = h;
        if (changed) {
            // Descriptions can report macroblock-aligned sizes. They fence a
            // format transition; only the fresh SPS sets transport geometry.
            self->configEmitted_ = false;
            self->sps_.clear();
            self->pps_.clear();
            self->h264_gate_.Reset();
        }
    }
}
void CaptureSession::OnEncError(OH_AVCodec *codec, int32_t errorCode, void *userData) {
    auto *context = static_cast<EncoderCallbackContext *>(userData);
    auto *self = context != nullptr ? context->session : nullptr;
    if (self == nullptr || !self->IsCurrentEncoder(codec, context)) return;
    OH_LOG_ERROR(LOG_APP, "encoder error: %{public}d", errorCode);
    self->QueueOwnedStop(nullptr, codec, context->epoch, context->generation);
}
void CaptureSession::OnScError(OH_AVScreenCapture *capture, int32_t errorCode, void *userData) {
    OH_LOG_ERROR(LOG_APP, "screen capture error: %{public}d", errorCode);
    if (userData != nullptr) static_cast<CaptureSession *>(userData)->QueueStop(capture);
}
void CaptureSession::OnSurfaceBridgeError(void *context) {
    auto *self = static_cast<CaptureSession *>(context);
    if (self == nullptr || self->stopping_.load()) return;
    OH_AVScreenCapture *capture = nullptr;
    {
        std::lock_guard<std::mutex> guard(self->mu_);
        capture = self->capture_;
    }
    if (capture != nullptr) {
        OH_LOG_ERROR(LOG_APP, "surface bridge failed; stopping capture instead of serving stale frames");
        self->QueueStop(capture);
    }
}
void CaptureSession::QueueStop(OH_AVScreenCapture *capture) {
    QueueOwnedStop(capture, nullptr);
}
void CaptureSession::QueueOwnedStop(OH_AVScreenCapture *capture, OH_AVCodec *encoder,
                                   uint64_t expectedEpoch, uint64_t expectedGeneration) {
    if (capture == nullptr && encoder == nullptr) return;
    if (stopping_.load()) return;
    const auto epoch = epoch_.load();
    const auto generation = encoder_generation_.load();
    {
        std::lock_guard<std::mutex> guard(mu_);
        if (stopping_.load() || (expectedEpoch != 0 && expectedEpoch != epoch) ||
            (expectedGeneration != 0 && expectedGeneration != generation) ||
            !((capture != nullptr && capture_ == capture) || (encoder != nullptr && encoder_ == encoder))) return;
    }
    uint64_t empty = 0;
    if (!pending_stop_epoch_.compare_exchange_strong(empty, epoch)) return;
    // System callbacks must return before resources are released. Coalesce
    // repeated failures and fence both the source pointer and session epoch.
    std::thread([this, capture, encoder, epoch, generation] {
        bool owned = false;
        {
            std::lock_guard<std::mutex> guard(mu_);
            owned = !stopping_.load() && epoch_.load() == epoch && encoder_generation_.load() == generation &&
                ((capture != nullptr && capture_ == capture) || (encoder != nullptr && encoder_ == encoder));
        }
        if (owned) Stop(epoch);
        uint64_t pending = epoch;
        pending_stop_epoch_.compare_exchange_strong(pending, 0);
    }).detach();
}
void CaptureSession::OnScStateChange(OH_AVScreenCapture *capture, OH_AVScreenCaptureStateCode stateCode, void *userData) {
    OH_LOG_INFO(LOG_APP, "screen capture state=%{public}d", static_cast<int32_t>(stateCode));
    if (stateCode == OH_SCREEN_CAPTURE_STATE_STARTED && userData != nullptr) {
        auto *self = static_cast<CaptureSession *>(userData);
        const auto epoch = self->epoch_.load();
        std::thread([self, capture, epoch] {
            std::lock_guard<std::mutex> lifecycle(self->lifecycle_mu_);
            {
                std::lock_guard<std::mutex> guard(self->mu_);
                if (self->epoch_.load() != epoch || self->capture_ != capture || self->stopping_.load()) return;
                self->capture_started_.store(true);
            }
            // SetMaxVideoFrameRate can notify codec callbacks. The lifecycle
            // lock protects the capture, without holding their data mutex.
            self->ApplyCaptureMaxFrameRateLocked();
        }).detach();
    }
    const bool terminal = stateCode == OH_SCREEN_CAPTURE_STATE_CANCELED ||
        stateCode == OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER ||
        stateCode == OH_SCREEN_CAPTURE_STATE_INTERRUPTED_BY_OTHER ||
        stateCode == OH_SCREEN_CAPTURE_STATE_STOPPED_BY_CALL ||
        stateCode == OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER_SWITCHES;
    if (terminal && userData != nullptr) static_cast<CaptureSession *>(userData)->QueueStop(capture);
}

void CaptureSession::HandleEncodedOutput(OH_AVCodec *codec, uint32_t index, OH_AVBuffer *buffer) {
    // Stop/Destroy wait for this callback to return; never release a buffer
    // through encoder_, which can already be cleared by the lifecycle thread.
    struct OutputRelease {
        OH_AVCodec *codec;
        uint32_t index;
        ~OutputRelease() { OH_VideoEncoder_FreeOutputBuffer(codec, index); }
    } release{codec, index};
    OH_AVCodecBufferAttr attr{};
    if (OH_AVBuffer_GetBufferAttr(buffer, &attr) != AV_ERR_OK) {
        return;
    }
    uint8_t *addr = OH_AVBuffer_GetAddr(buffer);
    const int32_t capacity = OH_AVBuffer_GetCapacity(buffer);
    if (addr == nullptr || attr.offset < 0 || attr.size <= 0 || attr.size > 16 * 1024 * 1024 ||
        capacity < 0 || attr.offset > capacity || attr.size > capacity - attr.offset) {
        return;
    }
    const uint8_t *data = addr + attr.offset;
    int32_t size = attr.size;
    bool isCodecData = (attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA) != 0;
    bool isKey = (attr.flags & AVCODEC_BUFFER_FLAGS_SYNC_FRAME) != 0;

    if (isCodecData || isKey) {
        std::vector<uint8_t> sps, pps;
        bool malformed = false;
        const bool foundParameters = ParseSpsPps(data, size, sps, pps, malformed);
        if (malformed || (!foundParameters && isCodecData)) {
            // A malformed/oversized parameter packet cannot retain the old
            // decoder state and pass the next dependent GOP through it.
            std::lock_guard<std::mutex> g(mu_);
            configEmitted_ = false;
            h264_gate_.Reset();
            sps_.clear();
            pps_.clear();
            OH_LOG_WARN(LOG_APP, "discard invalid codec data; awaiting fresh parameter sets and IDR");
            return;
        }
        if (foundParameters) {
            int32_t actualWidth = 0, actualHeight = 0;
            if (!sps.empty() && !ReadH264SpsGeometry(sps.data(), sps.size(), actualWidth, actualHeight)) {
                std::lock_guard<std::mutex> g(mu_);
                configEmitted_ = false;
                h264_gate_.Reset();
                sps_.clear();
                pps_.clear();
                OH_LOG_WARN(LOG_APP, "discard invalid SPS; awaiting fresh parameter sets and IDR");
                return;
            }
            std::lock_guard<std::mutex> g(mu_);
            const bool changed = (!sps.empty() && sps != sps_) || (!pps.empty() && pps != pps_);
            if (configEmitted_ && changed) {
                // Even unchanged dimensions can come with a new AVC profile
                // or parameter set. No dependent old GOP crosses that boundary.
                configEmitted_ = false;
                h264_gate_.Reset();
                sps_.clear();
                pps_.clear();
            }
            if (!sps.empty()) {
                // Encoder/capture requested sizes are only configuration hints.
                // Transport geometry follows the actual visible SPS dimensions.
                cfg_.width = actualWidth;
                cfg_.height = actualHeight;
                sps_ = std::move(sps);
            }
            if (!pps.empty()) pps_ = std::move(pps);
        }
    }
    if (!isCodecData) {
        bool needConfig = false;
        std::vector<uint8_t> spsCopy, ppsCopy;
        {
            std::lock_guard<std::mutex> g(mu_);
            uint32_t ppsId = 0;
            const bool parameterSetsReady = ReadH264ParameterSetId(
                sps_.data(), sps_.size(), pps_.data(), pps_.size(), ppsId);
            if (stopping_.load() || !h264_gate_.CanEmitFrame(isKey, parameterSetsReady)) return;
            if (h264_gate_.NeedsConfiguration()) {
                if (!HasMatchingIdr(data, size, ppsId)) return;
                needConfig = true;
                spsCopy = sps_;
                ppsCopy = pps_;
            }
        }
        if (needConfig) {
            // TCP preserves packet order: the fresh config precedes its IDR.
            // Do not close subscribers or clear partially written packets here.
            SendH264Config(spsCopy, ppsCopy);
            std::lock_guard<std::mutex> g(mu_);
            configEmitted_ = true;
            h264_gate_.ConfigurationEmitted();
        }
        if (stopping_.load()) return;
        const int64_t normalized = NormalizeTimestampUs(attr.pts);
        SendVideoFrame(isKey, normalized, data,
                       static_cast<size_t>(size));
    }
}

bool CaptureSession::ParseSpsPps(const uint8_t *data, int32_t size,
                                 std::vector<uint8_t> &sps,
                                 std::vector<uint8_t> &pps, bool &malformed) const {
    malformed = false;
    if (data == nullptr || size <= 0 || size > 16 * 1024 * 1024) { malformed = true; return false; }
    int32_t i = 0;
    auto findStart = [&](int32_t pos, int32_t &headerLen) -> int32_t {
        for (int32_t p = pos; p + 3 < size; ++p) {
            if (data[p] == 0 && data[p + 1] == 0 && data[p + 2] == 0 && data[p + 3] == 1) {
                headerLen = 4;
                return p;
            }
            if (data[p] == 0 && data[p + 1] == 0 && data[p + 2] == 1) {
                headerLen = 3;
                return p;
            }
        }
        return -1;
    };
    while (i < size) {
        int32_t hdr = 0;
        int32_t start = findStart(i, hdr);
        if (start < 0) break;
        int32_t payloadStart = start + hdr;
        int32_t nextHdr = 0;
        int32_t next = findStart(payloadStart, nextHdr);
        int32_t payloadEnd = (next < 0) ? size : next;
        if (payloadStart >= payloadEnd) {
            i = payloadEnd;
            continue;
        }
        uint8_t nalType = data[payloadStart] & 0x1F;
        if (nalType == 7 || nalType == 8) {
            const auto length = static_cast<size_t>(payloadEnd - payloadStart);
            if (length > 65535) { malformed = true; return false; }
            auto &parameters = nalType == 7 ? sps : pps;
            if (!parameters.empty() && (parameters.size() != length ||
                !std::equal(parameters.begin(), parameters.end(), data + payloadStart))) {
                // This protocol carries one matching SPS/PPS pair. Do not
                // choose an arbitrary set from an ambiguous multi-set packet.
                malformed = true;
                return false;
            }
            if (parameters.empty()) parameters.assign(data + payloadStart, data + payloadEnd);
        }
        i = payloadEnd;
    }
    return !sps.empty() || !pps.empty();
}

bool CaptureSession::HasMatchingIdr(const uint8_t *data, int32_t size, uint32_t ppsId) const {
    if (data == nullptr || size <= 0 || size > 16 * 1024 * 1024) return false;
    int32_t payloadStart = -1;
    for (int32_t i = 0; i + 2 < size; ++i) {
        if (data[i] != 0 || data[i + 1] != 0) continue;
        const int32_t header = data[i + 2] == 1 ? 3 :
            (i + 3 < size && data[i + 2] == 0 && data[i + 3] == 1 ? 4 : 0);
        if (header == 0) continue;
        if (payloadStart >= 0 && H264IdrReferencesPps(data + payloadStart,
                static_cast<size_t>(i - payloadStart), ppsId)) return true;
        payloadStart = i + header;
        i += header - 1;
    }
    return payloadStart >= 0 && payloadStart < size && H264IdrReferencesPps(
        data + payloadStart, static_cast<size_t>(size - payloadStart), ppsId);
}

// ----- RAW path -----

void CaptureSession::OnScVideoBuffer(OH_AVScreenCapture * /*capture*/, bool isReady) {
    if (!isReady) return;
    auto &self = CaptureSession::Instance();
    if (self.stopping_.load()) return;
    self.HandleRawBufferAvailable();
}

void CaptureSession::HandleRawBufferAvailable() {
    int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now().time_since_epoch()).count();
    int32_t fps = cfg_.frameRate > 0 ? cfg_.frameRate : kRawFrameRate;
    int64_t minInterval = 1000 / fps;
    int64_t prev = lastRawEmitMs_.load();
    bool drop = (prev != 0) && (now - prev < minInterval);

    OH_AVScreenCapture *cap;
    {
        std::lock_guard<std::mutex> g(mu_);
        cap = capture_;
    }
    if (cap == nullptr) return;

    // OH 契约：isReady=true 后必须 Acquire+Release 各一次释放槽位，
    // 否则系统判定消费者未消费完，不再触发后续 OnScVideoBuffer 回调。
    // 因此即使要丢帧（限速 / 无客户端），也要先 Acquire 再 Release，绝不能 Release without Acquire。
    OH_Rect region{};
    int32_t fence = -1;
    int64_t timestamp = 0;
    OH_NativeBuffer *buf = OH_AVScreenCapture_AcquireVideoBuffer(cap, &fence, &timestamp, &region);
    if (buf == nullptr) return;

    bool skip = !TcpServer::Instance().HasClients() || drop ||
                encoder_paused_.load(std::memory_order_relaxed);
    if (skip) {
        OH_AVScreenCapture_ReleaseVideoBuffer(cap);
        return;
    }
    lastRawEmitMs_.store(now);

    OH_NativeBuffer_Config bcfg{};
    OH_NativeBuffer_GetConfig(buf, &bcfg);

    void *virAddr = nullptr;
    if (OH_NativeBuffer_Map(buf, &virAddr) != 0 || virAddr == nullptr) {
        OH_AVScreenCapture_ReleaseVideoBuffer(cap);
        return;
    }

    int32_t width = bcfg.width;
    int32_t height = bcfg.height;
    int32_t stride = bcfg.stride > 0 ? bcfg.stride : width * 4;

    // Emit config if dimensions changed or first time.
    bool needCfg = !configEmitted_ || width != raw_described_width_ || height != raw_described_height_;
    if (needCfg) {
        OH_LOG_INFO(LOG_APP, "RAW/JPEG sending config codec=%{public}d w=%{public}d h=%{public}d",
                    mode_, width, height);
        SendRawConfig(mode_, width, height);
        configEmitted_ = true;
        raw_described_width_ = width;
        raw_described_height_ = height;
    }

    // Strip row padding: buffer stride may exceed width*4.
    size_t packedSize = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    rawBuf_.resize(packedSize);
    uint8_t *src = static_cast<uint8_t *>(virAddr);
    int32_t rowBytes = width * 4;
    for (int32_t y = 0; y < height; ++y) {
        std::memcpy(rawBuf_.data() + y * rowBytes, src + y * stride, rowBytes);
    }

    if (mode_ == kCodecJpeg) {
        // 编码失败时退回发送原始 RGBA，避免画面冻结。
        if (EncodeJpeg(rawBuf_.data(), width, height, jpegBuf_)) {
            SendVideoFrame(true, NormalizeTimestampUs(timestamp),
                           jpegBuf_.data(), jpegBuf_.size());
        } else {
            OH_LOG_WARN(LOG_APP, "EncodeJpeg failed, falling back to RAW frame");
            SendVideoFrame(true, NormalizeTimestampUs(timestamp),
                           rawBuf_.data(), rawBuf_.size());
        }
    } else {
        SendVideoFrame(true, NormalizeTimestampUs(timestamp),
                       rawBuf_.data(), rawBuf_.size());
    }

    OH_NativeBuffer_Unmap(buf);
    OH_AVScreenCapture_ReleaseVideoBuffer(cap);
}

bool CaptureSession::EncodeJpeg(const uint8_t *rgba, int32_t width, int32_t height,
                                std::vector<uint8_t> &out) {
    if (imagePacker_ == nullptr || packingOptions_ == nullptr) return false;

    OH_Pixelmap_InitializationOptions *pmOpts = nullptr;
    if (OH_PixelmapInitializationOptions_Create(&pmOpts) != IMAGE_SUCCESS || pmOpts == nullptr) {
        return false;
    }
    OH_PixelmapInitializationOptions_SetWidth(pmOpts, static_cast<uint32_t>(width));
    OH_PixelmapInitializationOptions_SetHeight(pmOpts, static_cast<uint32_t>(height));
    // 截屏 source 是 SURFACE_RGBA，对应 PIXEL_FORMAT_RGBA_8888。
    OH_PixelmapInitializationOptions_SetPixelFormat(pmOpts, PIXEL_FORMAT_RGBA_8888);
    OH_PixelmapInitializationOptions_SetSrcPixelFormat(pmOpts, PIXEL_FORMAT_RGBA_8888);

    OH_PixelmapNative *pm = nullptr;
    size_t dataLen = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    auto err = OH_PixelmapNative_CreatePixelmap(const_cast<uint8_t *>(rgba), dataLen, pmOpts, &pm);
    OH_PixelmapInitializationOptions_Release(pmOpts);
    if (err != IMAGE_SUCCESS || pm == nullptr) {
        OH_LOG_WARN(LOG_APP, "CreatePixelmap failed: %{public}d", static_cast<int32_t>(err));
        return false;
    }

    // 预估 JPEG 体积上限：RGBA 总字节的 1/4 + 64KB 头/EOI 余量；超出会重试一次。
    size_t cap = dataLen / 4 + 65536;
    out.resize(cap);
    size_t outSize = out.size();
    err = OH_ImagePackerNative_PackToDataFromPixelmap(imagePacker_, packingOptions_, pm,
                                                     out.data(), &outSize);
    if (err != IMAGE_SUCCESS) {
        // 缓冲不足：再放大重试一次。
        out.resize(dataLen);
        outSize = out.size();
        err = OH_ImagePackerNative_PackToDataFromPixelmap(imagePacker_, packingOptions_, pm,
                                                         out.data(), &outSize);
    }
    OH_PixelmapNative_Release(pm);
    if (err != IMAGE_SUCCESS) {
        OH_LOG_WARN(LOG_APP, "PackToDataFromPixelmap failed: %{public}d", static_cast<int32_t>(err));
        out.clear();
        return false;
    }
    out.resize(outSize);
    return true;
}

// ----- Send helpers -----

void CaptureSession::SendH264Config(const std::vector<uint8_t> &sps, const std::vector<uint8_t> &pps) {
    size_t total = 1 + 12 + 2 + sps.size() + 2 + pps.size();
    std::vector<uint8_t> p(total);
    size_t off = 0;
    p[off++] = static_cast<uint8_t>(kCodecH264);
    auto putU32 = [&](uint32_t v) {
        p[off++] = (v >> 24) & 0xFF; p[off++] = (v >> 16) & 0xFF;
        p[off++] = (v >> 8) & 0xFF; p[off++] = v & 0xFF;
    };
    auto putU16 = [&](uint16_t v) {
        p[off++] = (v >> 8) & 0xFF; p[off++] = v & 0xFF;
    };
    putU32(static_cast<uint32_t>(cfg_.width));
    putU32(static_cast<uint32_t>(cfg_.height));
    putU32(static_cast<uint32_t>(cfg_.frameRate));
    putU16(static_cast<uint16_t>(sps.size()));
    if (!sps.empty()) { memcpy(p.data() + off, sps.data(), sps.size()); off += sps.size(); }
    putU16(static_cast<uint16_t>(pps.size()));
    if (!pps.empty()) { memcpy(p.data() + off, pps.data(), pps.size()); off += pps.size(); }
    TcpServer::Instance().SetVideoConfig(p.data(), p.size());
}

void CaptureSession::SendRawConfig(int32_t codec, int32_t width, int32_t height) {
    size_t total = 1 + 12;
    std::vector<uint8_t> p(total);
    size_t off = 0;
    p[off++] = static_cast<uint8_t>(codec);
    auto putU32 = [&](uint32_t v) {
        p[off++] = (v >> 24) & 0xFF; p[off++] = (v >> 16) & 0xFF;
        p[off++] = (v >> 8) & 0xFF; p[off++] = v & 0xFF;
    };
    putU32(static_cast<uint32_t>(width));
    putU32(static_cast<uint32_t>(height));
    putU32(static_cast<uint32_t>(cfg_.frameRate));
    TcpServer::Instance().SetVideoConfig(p.data(), p.size());
}

int64_t CaptureSession::NormalizeTimestampUs(int64_t sourcePts) {
    std::lock_guard<std::mutex> g(pts_mu_);
    // The Mate 60/API-26 encoder has returned one unchanged source PTS for
    // hundreds of frames, then switched units for repeated static frames.
    // Source PTS is therefore diagnostic only; callback time is a stable,
    // process-local monotonic clock and preserves real recording duration.
    (void)sourcePts;
    const auto observedUs = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    return timestampClock_.Normalize(observedUs, cfg_.frameRate);
}

void CaptureSession::SendVideoFrame(bool keyframe, int64_t ptsUs, const uint8_t *nal, size_t size) {
    // 直接构建完整的 videoFrame payload（flags+pts+data），作为一次 alloc 传给 TcpServer。
    // 相比原来先组 p 再让 EncodeFrame 再包一层，节省一次 vector 分配和 memcpy。
    std::vector<uint8_t> p(9 + size);
    p[0] = keyframe ? 1 : 0;
    uint64_t pts = static_cast<uint64_t>(ptsUs);
    for (int i = 0; i < 8; ++i) p[1 + i] = (pts >> (56 - i * 8)) & 0xFF;
    if (size > 0) memcpy(p.data() + 9, nal, size);
    static std::atomic<int64_t> frameCount{0};
    int64_t n = ++frameCount;
    if (n <= 3 || n % 30 == 0) {
        OH_LOG_INFO(LOG_APP, "frame #%{public}ld size=%zu key=%d", (long)n, size, keyframe ? 1 : 0);
    }
    TcpServer::Instance().BroadcastVideoFrame(p.data(), p.size());
}

} // namespace

bool IsCaptureStarted() { return CaptureSession::Instance().IsStarted(); }

bool StartCapture(const CaptureConfig &cfg) {
    return CaptureSession::Instance().Start(cfg);
}

void StopCapture() {
    CaptureSession::Instance().Stop();
}

void SetEncoderPaused(bool paused) {
    CaptureSession::Instance().SetPaused(paused);
}

bool RestartEncoder() {
    return CaptureSession::Instance().RestartEncoder();
}

bool ReconfigureEncoder(const CaptureConfig &cfg) {
    return CaptureSession::Instance().Reconfigure(cfg);
}

} // namespace scrcpy
