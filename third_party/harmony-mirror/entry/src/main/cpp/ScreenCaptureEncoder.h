#ifndef SCRCPY_SCREEN_CAPTURE_ENCODER_H
#define SCRCPY_SCREEN_CAPTURE_ENCODER_H

#include <cstdint>
#include <cstddef>

namespace scrcpy {

// BEGIN_OFFLINE_H264_HELPERS
// A new encoder/format must publish fresh parameter sets with an IDR before
// dependent frames can be sent to any viewer. This gate is independent of
// device APIs so the exact native state transitions can be tested offline.
struct H264StreamGate {
    bool awaitingKeyframe = true;
    void Reset() { awaitingKeyframe = true; }
    bool CanEmitFrame(bool keyframe, bool parameterSetsReady) const {
        return !awaitingKeyframe || (keyframe && parameterSetsReady);
    }
    bool NeedsConfiguration() const { return awaitingKeyframe; }
    void ConfigurationEmitted() { awaitingKeyframe = false; }
};

// Some surface encoders return one unchanged or mixed-unit source PTS for
// hundreds of otherwise valid output buffers. WebCodecs requires a strictly
// increasing transport timestamp, so drive it from the callback's monotonic
// observation clock instead. A replacement encoder starts a new observation
// origin while preserving the stream-wide timestamp order.
struct TransportTimestampClock {
    int64_t normalizedUs = 0;
    int64_t lastObservedUs = -1;
    int64_t generationBaseUs = 0;
    bool started = false;

    void Reset() {
        normalizedUs = 0;
        lastObservedUs = -1;
        generationBaseUs = 0;
        started = false;
    }

    void BeginGeneration() {
        generationBaseUs = started ? normalizedUs + 1 : 0;
        lastObservedUs = -1;
    }

    int64_t Normalize(int64_t observedUs, int32_t frameRate) {
        const int64_t nominalUs = frameRate > 0 ? 1'000'000 / frameRate : 33'333;
        if (!started) {
            started = true;
            normalizedUs = generationBaseUs;
            lastObservedUs = observedUs;
            return normalizedUs;
        }
        if (lastObservedUs < 0) {
            normalizedUs = normalizedUs + 1 > generationBaseUs ? normalizedUs + 1 : generationBaseUs;
            lastObservedUs = observedUs;
            return normalizedUs;
        }
        const int64_t elapsedUs = observedUs > lastObservedUs ? observedUs - lastObservedUs : nominalUs;
        normalizedUs += elapsedUs > 0 ? elapsedUs : 1;
        lastObservedUs = observedUs;
        return normalizedUs;
    }
};

// Parse only the bounded SPS prefix needed for visible dimensions. The input
// is one SPS NAL (without a start code); no allocation or unchecked bit reads.
class H264SpsBits {
public:
    H264SpsBits(const uint8_t *bytes, size_t size) : bytes_(bytes), size_(size) {}
    bool Valid() const { return valid_; }
    uint32_t Bits(uint32_t count) {
        if (count > 32) { valid_ = false; return 0; }
        uint32_t value = 0;
        for (uint32_t i = 0; i < count && valid_; ++i) {
            if (remaining_ == 0) {
                bool found = false;
                while (offset_ < size_) {
                    byte_ = bytes_[offset_++];
                    if (zeros_ >= 2 && byte_ == 3) {
                        if (offset_ >= size_ || bytes_[offset_] > 3) { valid_ = false; return 0; }
                        zeros_ = 0;
                        continue;
                    }
                    zeros_ = byte_ == 0 ? zeros_ + 1 : 0;
                    found = true;
                    break;
                }
                if (!found) { valid_ = false; return 0; }
                remaining_ = 8;
            }
            value = (value << 1) | ((byte_ >> --remaining_) & 1);
        }
        return value;
    }
    uint32_t UnsignedExpGolomb() {
        uint32_t zeros = 0;
        while (valid_ && Bits(1) == 0) {
            if (++zeros > 30) { valid_ = false; return 0; }
        }
        if (!valid_) return 0;
        const auto suffix = Bits(zeros);
        return valid_ ? ((uint32_t{1} << zeros) - 1) + suffix : 0;
    }
    int32_t SignedExpGolomb() {
        const auto value = UnsignedExpGolomb();
        return value & 1 ? static_cast<int32_t>((value + 1) / 2) : -static_cast<int32_t>(value / 2);
    }
private:
    const uint8_t *bytes_;
    size_t size_;
    size_t offset_ = 1;
    uint32_t remaining_ = 0;
    uint32_t zeros_ = 0;
    uint8_t byte_ = 0;
    bool valid_ = true;
};

inline bool ReadH264SpsGeometry(const uint8_t *nal, size_t size, int32_t &width, int32_t &height) {
    if (nal == nullptr || size < 4 || size > 65535 || (nal[0] & 31) != 7 || (nal[0] & 128)) return false;
    H264SpsBits bits(nal, size);
    const auto profile = bits.Bits(8);
    bits.Bits(8); // constraint flags
    bits.Bits(8); // level
    if (bits.UnsignedExpGolomb() > 31) return false;
    uint32_t chroma = 1;
    bool separateColourPlane = false;
    const bool highProfile = profile == 100 || profile == 110 || profile == 122 || profile == 244 ||
        profile == 44 || profile == 83 || profile == 86 || profile == 118 || profile == 128 ||
        profile == 138 || profile == 139 || profile == 134 || profile == 135;
    if (highProfile) {
        chroma = bits.UnsignedExpGolomb();
        if (chroma > 3) return false;
        if (chroma == 3) separateColourPlane = bits.Bits(1) != 0;
        if (bits.UnsignedExpGolomb() > 6 || bits.UnsignedExpGolomb() > 6) return false;
        bits.Bits(1);
        if (bits.Bits(1)) {
            const uint32_t lists = chroma == 3 ? 12 : 8;
            for (uint32_t i = 0; i < lists && bits.Valid(); ++i) {
                if (!bits.Bits(1)) continue;
                int32_t lastScale = 8, nextScale = 8;
                const uint32_t entries = i < 6 ? 16 : 64;
                for (uint32_t j = 0; j < entries && bits.Valid(); ++j) {
                    if (nextScale != 0) {
                        const int32_t delta = bits.SignedExpGolomb();
                        nextScale = ((lastScale + delta) % 256 + 256) % 256;
                    }
                    lastScale = nextScale == 0 ? lastScale : nextScale;
                }
            }
        }
    } else if (profile != 66 && profile != 77 && profile != 88) {
        return false;
    }
    if (bits.UnsignedExpGolomb() > 12) return false;
    const auto orderType = bits.UnsignedExpGolomb();
    if (orderType == 0) {
        if (bits.UnsignedExpGolomb() > 12) return false;
    } else if (orderType == 1) {
        bits.Bits(1);
        bits.SignedExpGolomb();
        bits.SignedExpGolomb();
        const auto cycle = bits.UnsignedExpGolomb();
        if (cycle > 255) return false;
        for (uint32_t i = 0; i < cycle && bits.Valid(); ++i) bits.SignedExpGolomb();
    } else if (orderType != 2) {
        return false;
    }
    if (bits.UnsignedExpGolomb() > 64) return false;
    bits.Bits(1);
    const auto widthMbs = bits.UnsignedExpGolomb();
    const auto heightMapUnits = bits.UnsignedExpGolomb();
    if (widthMbs >= 512 || heightMapUnits >= 512) return false;
    const uint32_t frameOnly = bits.Bits(1);
    if (!frameOnly) bits.Bits(1);
    bits.Bits(1);
    uint32_t left = 0, right = 0, top = 0, bottom = 0;
    if (bits.Bits(1)) {
        left = bits.UnsignedExpGolomb();
        right = bits.UnsignedExpGolomb();
        top = bits.UnsignedExpGolomb();
        bottom = bits.UnsignedExpGolomb();
    }
    if (!bits.Valid()) return false;
    const uint32_t arrayType = separateColourPlane ? 0 : chroma;
    const uint32_t cropX = arrayType == 1 || arrayType == 2 ? 2 : 1;
    const uint32_t cropY = (arrayType == 1 ? 2 : 1) * (2 - frameOnly);
    const uint64_t codedWidth = uint64_t{widthMbs + 1} * 16;
    const uint64_t codedHeight = uint64_t{heightMapUnits + 1} * 16 * (2 - frameOnly);
    const uint64_t croppedWidth = (uint64_t{left} + right) * cropX;
    const uint64_t croppedHeight = (uint64_t{top} + bottom) * cropY;
    if (croppedWidth >= codedWidth || croppedHeight >= codedHeight) return false;
    const auto visibleWidth = codedWidth - croppedWidth;
    const auto visibleHeight = codedHeight - croppedHeight;
    if (visibleWidth < 2 || visibleHeight < 2 || visibleWidth > 8192 || visibleHeight > 8192) return false;
    width = static_cast<int32_t>(visibleWidth);
    height = static_cast<int32_t>(visibleHeight);
    return true;
}

inline bool ReadH264ParameterSetId(const uint8_t *sps, size_t spsSize,
                                   const uint8_t *pps, size_t ppsSize, uint32_t &ppsId) {
    if (sps == nullptr || pps == nullptr || spsSize < 4 || spsSize > 65535 || ppsSize < 2 ||
        ppsSize > 65535 || (sps[0] & 31) != 7 || (pps[0] & 31) != 8 || (sps[0] & 128) || (pps[0] & 128)) return false;
    H264SpsBits spsBits(sps, spsSize), ppsBits(pps, ppsSize);
    spsBits.Bits(24);
    const auto spsId = spsBits.UnsignedExpGolomb();
    const auto candidate = ppsBits.UnsignedExpGolomb();
    const auto referencedSpsId = ppsBits.UnsignedExpGolomb();
    if (!spsBits.Valid() || !ppsBits.Valid() || spsId > 31 || candidate > 255 || referencedSpsId != spsId) return false;
    ppsId = candidate;
    return true;
}

inline bool H264IdrReferencesPps(const uint8_t *nal, size_t size, uint32_t ppsId) {
    if (nal == nullptr || size < 2 || size > 16 * 1024 * 1024 || (nal[0] & 31) != 5 || (nal[0] & 128)) return false;
    H264SpsBits bits(nal, size);
    bits.UnsignedExpGolomb(); // first_mb_in_slice
    const auto sliceType = bits.UnsignedExpGolomb();
    const auto referencedPpsId = bits.UnsignedExpGolomb();
    return bits.Valid() && sliceType <= 9 && referencedPpsId <= 255 && referencedPpsId == ppsId;
}
// END_OFFLINE_H264_HELPERS

struct CaptureConfig {
    int32_t width;
    int32_t height;
    int32_t frameRate;
    int32_t bitrate;
    int32_t jpegQuality; // RAW JPEG quality 1-100
};

bool StartCapture(const CaptureConfig &cfg);
void StopCapture();
bool IsCaptureStarted();
void SetEncoderPaused(bool paused);
bool RestartEncoder();
bool ReconfigureEncoder(const CaptureConfig &cfg);

} // namespace scrcpy

#endif
