#ifndef SCRCPY_TCP_SERVER_H
#define SCRCPY_TCP_SERVER_H

#include "napi/native_api.h"
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace scrcpy {

// Packet header: 4B type | 4B BE length | payload
constexpr uint32_t kPktHeartbeat = 0x01;
constexpr uint32_t kPktVideoConfig = 0x02;
constexpr uint32_t kPktVideoFrame = 0x03;
constexpr uint32_t kPktControl = 0x10;
constexpr uint32_t kPktDeviceStatus = 0x20;

// BEGIN_OFFLINE_VIDEO_QUEUE_HELPERS
constexpr size_t kVideoQueueHardBytes = 24 * 1024 * 1024;
constexpr size_t kVideoQueueHardPackets = 128;
constexpr int kVideoQueueQueued = 0;
constexpr int kVideoQueueRecovered = 1;
constexpr int kVideoQueueClose = 2;

// Count the complete allocation of a partial front packet, not only its
// unsent suffix. A null extra frame checks the existing queue on its own.
template <typename Queue, typename Frame>
inline bool VideoQueueFits(const Queue &queue, const Frame &extra) {
    size_t bytes = extra ? extra->size() : 0;
    size_t packets = extra ? 1 : 0;
    if (bytes > kVideoQueueHardBytes) return false;
    for (const auto &packet : queue) {
        if (!packet || ++packets > kVideoQueueHardPackets ||
            packet->size() > kVideoQueueHardBytes - bytes) return false;
        bytes += packet->size();
    }
    return packets <= kVideoQueueHardPackets;
}

template <typename Frame>
inline uint32_t QueuedPacketType(const Frame &frame) {
    if (!frame || frame->size() < 8) return 0;
    return (uint32_t((*frame)[0]) << 24) | (uint32_t((*frame)[1]) << 16) |
        (uint32_t((*frame)[2]) << 8) | uint32_t((*frame)[3]);
}

// The exact production queue policy is independent of sockets and napi. It
// preserves every byte of an in-progress front packet, drops only unstarted
// video/config packets, and restores the latest config before the next IDR.
template <typename Queue, typename Frame>
inline int EnqueueVideoPacket(Queue &queue, size_t &offset, bool &awaitingKeyframe,
                               Frame &latestConfig, const Frame &frame) {
    if (!frame || frame->size() < 8 || frame->size() > kVideoQueueHardBytes ||
        !VideoQueueFits(queue, Frame{})) return kVideoQueueClose;
    const auto type = QueuedPacketType(frame);
    const bool config = type == 0x02;
    const bool video = type == 0x03 && frame->size() > 17;
    const bool keyframe = video && ((*frame)[8] & 1) != 0;
    if (config) { latestConfig = frame; awaitingKeyframe = true; }
    if (video && awaitingKeyframe && !keyframe) return kVideoQueueQueued;

    constexpr size_t limit = 4 * 1024 * 1024;
    size_t queued = 0;
    for (const auto &packet : queue) {
        if (packet->size() > limit - queued) { queued = limit + 1; break; }
        queued += packet->size();
    }
    const bool congested = !queue.empty() &&
        (queued > limit || frame->size() > limit - queued);
    Queue retained;
    Queue *target = &queue;
    bool nextAwaitingKeyframe = awaitingKeyframe;
    if (congested) {
        bool front = true;
        for (const auto &packet : queue) {
            const auto packetType = QueuedPacketType(packet);
            if ((front && offset != 0) || (packetType != 0x02 && packetType != 0x03)) {
                retained.push_back(packet);
            }
            front = false;
        }
        // offset belongs to the preserved partial front; when offset is zero
        // every unstarted old video packet can safely be replaced.
        if (latestConfig && (retained.empty() || retained.back() != latestConfig)) {
            if (!VideoQueueFits(retained, latestConfig)) return kVideoQueueClose;
            retained.push_back(latestConfig);
        }
        target = &retained;
        nextAwaitingKeyframe = true;
    }
    const bool dropVideo = video && ((nextAwaitingKeyframe && !keyframe) || (keyframe && !latestConfig));
    // A new config can itself trigger compaction and has already been restored.
    const bool restoredConfig = config && congested && !target->empty() && target->back() == frame;
    if (!dropVideo && !restoredConfig) {
        if (!VideoQueueFits(*target, frame)) return kVideoQueueClose;
        target->push_back(frame);
    }
    // Commit compaction only after the restored configuration and incoming
    // packet both fit. On rejection the partial front and its offset remain
    // untouched; the caller explicitly closes this subscriber.
    if (congested) queue.swap(retained);
    awaitingKeyframe = keyframe && !dropVideo ? false : nextAwaitingKeyframe;
    return congested ? kVideoQueueRecovered : kVideoQueueQueued;
}
// END_OFFLINE_VIDEO_QUEUE_HELPERS

// Callback fired when first client arrives or last client leaves.
using PresenceCallback = void (*)(bool hasClient);

class TcpServer {
public:
    static TcpServer &Instance();

    // Start listening on 127.0.0.1:port. Spawns the IO thread.
    bool Start(napi_env env, int port, napi_value onPresence, napi_value onControl);
    void Stop();

    // Save lastConfig and broadcast to all clients.
    void SetVideoConfig(const uint8_t *payload, size_t size);
    // Begin an in-place encoder format change. Existing connections remain
    // open, but no late subscriber or dependent frame may reuse old decoder
    // configuration while the fresh SPS/PPS and IDR are pending.
    void InvalidateVideoConfig();
    // Clear capture configuration and terminate its existing subscribers.
    void ClearVideoConfig();
    void BroadcastVideoFrame(const uint8_t *payload, size_t size);
    void BroadcastDeviceStatus(const uint8_t *payload, size_t size);

    bool HasClients();

private:
    TcpServer() = default;
    ~TcpServer() { Stop(); }

    // 发送队列元素改为 shared_ptr：多客户端共享同一份只读帧缓冲，消除 per-client 拷贝。
    using FramePtr = std::shared_ptr<const std::vector<uint8_t>>;

    struct ClientState {
        int fd;
        bool closing = false;
        bool awaitingKeyframe = true;
        FramePtr latestConfig;
        std::deque<FramePtr> txQueue;
        size_t txOffset = 0; // bytes already sent of txQueue.front()
        // inbound parsing state
        std::vector<uint8_t> rxBuf;
        // 任意 inbound 字节都更新此时间，用于心跳超时检测
        std::chrono::steady_clock::time_point lastRxAt = std::chrono::steady_clock::now();
    };

    void IoLoop();
    void AcceptNew();
    void HandleReadable(ClientState &c, bool &shouldClose);
    void HandleWritable(ClientState &c, bool &shouldClose);
    void CloseClient(int fd, const char *reason);
    void EnqueueAll(FramePtr frame);
    void EnqueueFor(ClientState &c, FramePtr frame);
    void UpdateInterest(int fd, bool wantWrite);
    void OnPacket(ClientState &c, uint32_t type, const uint8_t *payload, size_t size);
    void NotifyPresence(bool hasClient);
    void NotifyControl(uint8_t sub, const uint8_t *body, size_t size);

    static void TsPresenceCb(napi_env env, napi_value cb, void *ctx, void *data);
    static void TsControlCb(napi_env env, napi_value cb, void *ctx, void *data);

    static FramePtr EncodeFrame(uint32_t type, const uint8_t *payload, size_t size);

    std::mutex mu_; // guards clients_, lastConfig_
    std::map<int, ClientState> clients_;
    FramePtr lastConfig_; // shared_ptr，新客户端接入时直接共享，无需拷贝

    int listenFd_ = -1;
    int epollFd_ = -1;
    int wakeRd_ = -1;
    int wakeWr_ = -1;
    std::atomic<bool> running_{false};
    std::thread ioThread_;

    napi_threadsafe_function tsPresence_ = nullptr;
    napi_threadsafe_function tsControl_ = nullptr;

    // Throttle: notify presence transitions only on edges.
    std::atomic<bool> hadClients_{false};
};

} // namespace scrcpy

#endif
