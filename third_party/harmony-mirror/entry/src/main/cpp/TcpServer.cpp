#include "TcpServer.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <hilog/log.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0xA000
#define LOG_TAG "ScrcpyTcp"

namespace scrcpy {

namespace {

void SetNonBlocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return;
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

struct ControlMsg {
    uint8_t sub;
    std::vector<uint8_t> body;
};

struct PresenceMsg {
    bool hasClient;
};

} // namespace

TcpServer &TcpServer::Instance() {
    static TcpServer s;
    return s;
}

TcpServer::FramePtr TcpServer::EncodeFrame(uint32_t type, const uint8_t *payload, size_t size) {
    auto out = std::make_shared<std::vector<uint8_t>>(8 + size);
    auto &v = *out;
    v[0] = static_cast<uint8_t>((type >> 24) & 0xFF);
    v[1] = static_cast<uint8_t>((type >> 16) & 0xFF);
    v[2] = static_cast<uint8_t>((type >> 8) & 0xFF);
    v[3] = static_cast<uint8_t>(type & 0xFF);
    v[4] = static_cast<uint8_t>((size >> 24) & 0xFF);
    v[5] = static_cast<uint8_t>((size >> 16) & 0xFF);
    v[6] = static_cast<uint8_t>((size >> 8) & 0xFF);
    v[7] = static_cast<uint8_t>(size & 0xFF);
    if (size > 0) memcpy(v.data() + 8, payload, size);
    return out;
}

bool TcpServer::Start(napi_env env, int port, napi_value onPresence, napi_value onControl) {
    if (running_.load()) return true;
    const auto startupFailure = [this]() {
        if (listenFd_ >= 0) { close(listenFd_); listenFd_ = -1; }
        if (epollFd_ >= 0) { close(epollFd_); epollFd_ = -1; }
        if (wakeRd_ >= 0) { close(wakeRd_); wakeRd_ = -1; wakeWr_ = -1; }
        if (tsPresence_) { napi_release_threadsafe_function(tsPresence_, napi_tsfn_abort); tsPresence_ = nullptr; }
        if (tsControl_) { napi_release_threadsafe_function(tsControl_, napi_tsfn_abort); tsControl_ = nullptr; }
        return false;
    };

    napi_value resName;
    napi_create_string_utf8(env, "scrcpy_tcp", NAPI_AUTO_LENGTH, &resName);
    if (onPresence != nullptr) {
        if (napi_create_threadsafe_function(env, onPresence, nullptr, resName, 64, 1, nullptr, nullptr,
                                        this, TsPresenceCb, &tsPresence_) != napi_ok) return startupFailure();
    }
    if (onControl != nullptr) {
        if (napi_create_threadsafe_function(env, onControl, nullptr, resName, 64, 1, nullptr, nullptr,
                                        this, TsControlCb, &tsControl_) != napi_ok) return startupFailure();
    }

    listenFd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listenFd_ < 0) {
        OH_LOG_ERROR(LOG_APP, "socket() failed: %{public}d", errno);
        return startupFailure();
    }
    int yes = 1;
    setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    SetNonBlocking(listenFd_);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    if (bind(listenFd_, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) < 0) {
        OH_LOG_ERROR(LOG_APP, "bind(%{public}d) failed: %{public}d", port, errno);
        close(listenFd_);
        listenFd_ = -1;
        return startupFailure();
    }
    if (listen(listenFd_, 8) < 0) {
        OH_LOG_ERROR(LOG_APP, "listen failed: %{public}d", errno);
        close(listenFd_);
        listenFd_ = -1;
        return startupFailure();
    }

    epollFd_ = epoll_create1(EPOLL_CLOEXEC);
    if (epollFd_ < 0) {
        OH_LOG_ERROR(LOG_APP, "epoll_create1 failed: %{public}d", errno);
        close(listenFd_);
        listenFd_ = -1;
        return startupFailure();
    }

    int evfd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    wakeRd_ = evfd;
    wakeWr_ = evfd;
    if (evfd < 0) return startupFailure();

    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = listenFd_;
    if (epoll_ctl(epollFd_, EPOLL_CTL_ADD, listenFd_, &ev) != 0) return startupFailure();

    ev.events = EPOLLIN;
    ev.data.fd = wakeRd_;
    if (epoll_ctl(epollFd_, EPOLL_CTL_ADD, wakeRd_, &ev) != 0) return startupFailure();

    running_.store(true);
    ioThread_ = std::thread([this] { this->IoLoop(); });
    OH_LOG_INFO(LOG_APP, "TcpServer listening on 127.0.0.1:%{public}d", port);
    return true;
}

void TcpServer::Stop() {
    if (!running_.exchange(false)) return;
    // wake io thread
    uint64_t one = 1;
    if (wakeWr_ >= 0) write(wakeWr_, &one, sizeof(one));
    if (ioThread_.joinable()) ioThread_.join();
    if (listenFd_ >= 0) { close(listenFd_); listenFd_ = -1; }
    if (epollFd_ >= 0) { close(epollFd_); epollFd_ = -1; }
    if (wakeRd_ >= 0) { close(wakeRd_); wakeRd_ = -1; wakeWr_ = -1; }
    {
        std::lock_guard<std::mutex> g(mu_);
        for (auto &kv : clients_) close(kv.first);
        clients_.clear();
        lastConfig_.reset();
    }
    if (tsPresence_) {
        napi_release_threadsafe_function(tsPresence_, napi_tsfn_release);
        tsPresence_ = nullptr;
    }
    if (tsControl_) {
        napi_release_threadsafe_function(tsControl_, napi_tsfn_release);
        tsControl_ = nullptr;
    }
    hadClients_.store(false);
}

bool TcpServer::HasClients() {
    std::lock_guard<std::mutex> g(mu_);
    return !clients_.empty();
}

void TcpServer::SetVideoConfig(const uint8_t *payload, size_t size) {
    auto frame = EncodeFrame(kPktVideoConfig, payload, size);
    size_t clients = 0;
    {
        std::lock_guard<std::mutex> g(mu_);
        lastConfig_ = frame;
        clients = clients_.size();
    }
    OH_LOG_INFO(LOG_APP, "SetVideoConfig size=%zu clients=%zu", size, clients);
    EnqueueAll(frame);
}

void TcpServer::InvalidateVideoConfig() {
    std::lock_guard<std::mutex> g(mu_);
    lastConfig_.reset();
    for (auto &[fd, client] : clients_) {
        (void)fd;
        std::deque<FramePtr> retained;
        bool front = true;
        for (const auto &packet : client.txQueue) {
            const auto packetType = QueuedPacketType(packet);
            if ((front && client.txOffset != 0) ||
                (packetType != kPktVideoConfig && packetType != kPktVideoFrame)) {
                retained.push_back(packet);
            }
            front = false;
        }
        client.txQueue.swap(retained);
        if (client.txQueue.empty() || client.txOffset == 0) client.txOffset = 0;
        client.latestConfig.reset();
        client.awaitingKeyframe = true;
    }
    OH_LOG_INFO(LOG_APP, "video config invalidated for live encoder reconfigure clients=%zu", clients_.size());
}

void TcpServer::ClearVideoConfig() {
    std::lock_guard<std::mutex> g(mu_);
    lastConfig_.reset();
    // Capture has ended. Close its subscribers instead of sending queued old
    // frames or leaving a healthy-looking connection to a stopped encoder.
    // The IO loop owns descriptor removal and the presence notification.
    for (const auto &client : clients_) shutdown(client.first, SHUT_RDWR);
}

void TcpServer::BroadcastVideoFrame(const uint8_t *payload, size_t size) {
    EnqueueAll(EncodeFrame(kPktVideoFrame, payload, size));
}

void TcpServer::BroadcastDeviceStatus(const uint8_t *payload, size_t size) {
    EnqueueAll(EncodeFrame(kPktDeviceStatus, payload, size));
}

void TcpServer::EnqueueAll(FramePtr frame) {
    bool wakeup = false;
    {
        std::lock_guard<std::mutex> g(mu_);
        if (clients_.empty()) return;
        for (auto &kv : clients_) {
            EnqueueFor(kv.second, frame);
        }
        wakeup = true;
    }
    if (wakeup && wakeWr_ >= 0) {
        uint64_t one = 1;
        write(wakeWr_, &one, sizeof(one));
    }
}

void TcpServer::EnqueueFor(ClientState &c, FramePtr frame) {
    if (c.closing) return;
    const auto result = EnqueueVideoPacket(c.txQueue, c.txOffset, c.awaitingKeyframe, c.latestConfig, frame);
    if (result == kVideoQueueClose) {
        c.closing = true;
        // Never silently discard status/heartbeat acknowledgements or splice
        // an already-started packet. IO owns final removal and notification.
        OH_LOG_WARN(LOG_APP, "client fd=%{public}d queue hard limit; closing stalled subscriber", c.fd);
        shutdown(c.fd, SHUT_RDWR);
        return;
    }
    if (result == kVideoQueueRecovered) {
        OH_LOG_WARN(LOG_APP, "client fd=%{public}d backpressure; preserving partial packet and restoring current config before IDR", c.fd);
    }
}

void TcpServer::UpdateInterest(int fd, bool wantWrite) {
    epoll_event ev{};
    ev.events = EPOLLIN | EPOLLRDHUP | (wantWrite ? EPOLLOUT : 0);
    ev.data.fd = fd;
    epoll_ctl(epollFd_, EPOLL_CTL_MOD, fd, &ev);
}

void TcpServer::IoLoop() {
    constexpr int kMax = 16;
    constexpr auto kHeartbeatTimeout = std::chrono::seconds(30);
    epoll_event events[kMax];
    auto lastScan = std::chrono::steady_clock::now();
    while (running_.load()) {
        int n = epoll_wait(epollFd_, events, kMax, 200);
        if (n < 0) {
            if (errno == EINTR) continue;
            OH_LOG_ERROR(LOG_APP, "epoll_wait: %{public}d", errno);
            break;
        }
        // 周期性扫描：30s 内未收到任何字节的客户端视为心跳超时，主动断开。
        // 客户端关闭后 CloseClient -> NotifyPresence(false) -> stopCapture() 链路停推流。
        auto now = std::chrono::steady_clock::now();
        if (now - lastScan >= std::chrono::seconds(1)) {
            lastScan = now;
            std::vector<int> stale;
            {
                std::lock_guard<std::mutex> g(mu_);
                for (auto &kv : clients_) {
                    if (now - kv.second.lastRxAt > kHeartbeatTimeout) {
                        stale.push_back(kv.first);
                    }
                }
            }
            for (int f : stale) {
                OH_LOG_WARN(LOG_APP, "heartbeat timeout fd=%{public}d, closing", f);
                CloseClient(f, "heartbeat-timeout");
            }
        }
        for (int i = 0; i < n; ++i) {
            int fd = events[i].data.fd;
            if (fd == listenFd_) {
                AcceptNew();
                continue;
            }
            if (fd == wakeRd_) {
                uint64_t v;
                while (read(wakeRd_, &v, sizeof(v)) > 0) {}
                // After wakeup, scan all clients and enable EPOLLOUT if they have queued data.
                std::vector<int> toEnable;
                {
                    std::lock_guard<std::mutex> g(mu_);
                    for (auto &kv : clients_) {
                        if (!kv.second.txQueue.empty()) toEnable.push_back(kv.first);
                    }
                }
                for (int f : toEnable) UpdateInterest(f, true);
                continue;
            }
            // Client fd
            if (events[i].events & (EPOLLERR | EPOLLHUP | EPOLLRDHUP)) {
                CloseClient(fd, "epoll-err");
                continue;
            }
            if (events[i].events & EPOLLIN) {
                bool shouldClose = false;
                {
                    std::lock_guard<std::mutex> g(mu_);
                    auto it = clients_.find(fd);
                    if (it != clients_.end()) HandleReadable(it->second, shouldClose);
                }
                if (shouldClose) {
                    CloseClient(fd, "read-error");
                    continue;
                }
            }
            // Recheck — HandleReadable may have closed the client.
            if (events[i].events & EPOLLOUT) {
                bool shouldClose = false;
                {
                    std::lock_guard<std::mutex> g(mu_);
                    auto it = clients_.find(fd);
                    if (it != clients_.end()) HandleWritable(it->second, shouldClose);
                }
                if (shouldClose) CloseClient(fd, "write-error");
            }
        }
    }
    OH_LOG_INFO(LOG_APP, "io loop exit");
}

void TcpServer::AcceptNew() {
    while (true) {
        sockaddr_in cli{};
        socklen_t len = sizeof(cli);
        int cfd = accept(listenFd_, reinterpret_cast<sockaddr *>(&cli), &len);
        if (cfd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            OH_LOG_WARN(LOG_APP, "accept: %{public}d", errno);
            break;
        }
        SetNonBlocking(cfd);
        int yes = 1;
        setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));

        ClientState st;
        st.fd = cfd;
        bool firstClient = false;
        bool hasCfg = false;
        {
            std::lock_guard<std::mutex> g(mu_);
            if (clients_.size() >= 8) { close(cfd); continue; }
            firstClient = clients_.empty();
            // 直接共享 lastConfig_ 的 shared_ptr，无需拷贝。
            if (lastConfig_) {
                st.latestConfig = lastConfig_;
                EnqueueFor(st, lastConfig_);
                if (st.closing) { close(cfd); continue; }
                hasCfg = true;
            }
            clients_.emplace(cfd, std::move(st));
        }
        epoll_event ev{};
        ev.events = EPOLLIN | EPOLLRDHUP | (hasCfg ? EPOLLOUT : 0);
        ev.data.fd = cfd;
        epoll_ctl(epollFd_, EPOLL_CTL_ADD, cfd, &ev);

        OH_LOG_INFO(LOG_APP, "client connected fd=%{public}d firstClient=%{public}d", cfd, firstClient ? 1 : 0);
        if (firstClient) {
            hadClients_.store(true);
            NotifyPresence(true);
        }
    }
}

void TcpServer::HandleReadable(ClientState &c, bool &shouldClose) {
    uint8_t buf[4096];
    while (true) {
        ssize_t r = recv(c.fd, buf, sizeof(buf), 0);
        if (r > 0) {
            c.lastRxAt = std::chrono::steady_clock::now();
            c.rxBuf.insert(c.rxBuf.end(), buf, buf + r);
            if (c.rxBuf.size() > 4096) { shouldClose = true; return; }
            // Try to parse packets.
            size_t off = 0;
            while (c.rxBuf.size() - off >= 8) {
                const uint8_t *p = c.rxBuf.data() + off;
                uint32_t type = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
                                (uint32_t(p[2]) << 8) | uint32_t(p[3]);
                uint32_t len = (uint32_t(p[4]) << 24) | (uint32_t(p[5]) << 16) |
                               (uint32_t(p[6]) << 8) | uint32_t(p[7]);
                if (len > 32) { shouldClose = true; return; }
                if (c.rxBuf.size() - off < 8 + len) break;
                OnPacket(c, type, p + 8, len);
                off += 8 + len;
            }
            if (off > 0) c.rxBuf.erase(c.rxBuf.begin(), c.rxBuf.begin() + off);
        } else if (r == 0) {
            shouldClose = true;
            return;
        } else {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;
            shouldClose = true;
            return;
        }
    }
}

void TcpServer::HandleWritable(ClientState &c, bool &shouldClose) {
    while (!c.txQueue.empty()) {
        const auto &front = c.txQueue.front();
        const uint8_t *p = front->data() + c.txOffset;
        size_t remain = front->size() - c.txOffset;
        ssize_t w = send(c.fd, p, remain, MSG_NOSIGNAL);
        if (w > 0) {
            c.txOffset += static_cast<size_t>(w);
            if (c.txOffset >= front->size()) {
                c.txQueue.pop_front();
                c.txOffset = 0;
            }
        } else if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return; // wait for next EPOLLOUT
        } else {
            shouldClose = true;
            return;
        }
    }
    // Queue empty -> stop polling for write
    UpdateInterest(c.fd, false);
}

void TcpServer::CloseClient(int fd, const char *reason) {
    bool nowEmpty = false;
    {
        std::lock_guard<std::mutex> g(mu_);
        auto it = clients_.find(fd);
        if (it == clients_.end()) return;
        clients_.erase(it);
        nowEmpty = clients_.empty();
    }
    epoll_ctl(epollFd_, EPOLL_CTL_DEL, fd, nullptr);
    close(fd);
    OH_LOG_INFO(LOG_APP, "client closed fd=%{public}d reason=%{public}s", fd, reason);
    if (nowEmpty) {
        hadClients_.store(false);
        NotifyPresence(false);
    }
}

void TcpServer::OnPacket(ClientState &c, uint32_t type, const uint8_t *payload, size_t size) {
    if (type == kPktHeartbeat) {
        // Echo back.
        EnqueueFor(c, EncodeFrame(kPktHeartbeat, payload, size));
        UpdateInterest(c.fd, true);
    } else if (type == kPktControl && size >= 1) {
        NotifyControl(payload[0], payload + 1, size - 1);
    }
}

void TcpServer::NotifyPresence(bool hasClient) {
    if (!tsPresence_) return;
    auto *m = new PresenceMsg{hasClient};
    if (napi_call_threadsafe_function(tsPresence_, m, napi_tsfn_nonblocking) != napi_ok) delete m;
}

void TcpServer::NotifyControl(uint8_t sub, const uint8_t *body, size_t size) {
    if (!tsControl_) return;
    auto *m = new ControlMsg();
    m->sub = sub;
    m->body.assign(body, body + size);
    if (napi_call_threadsafe_function(tsControl_, m, napi_tsfn_nonblocking) != napi_ok) delete m;
}

void TcpServer::TsPresenceCb(napi_env env, napi_value cb, void * /*ctx*/, void *data) {
    auto *m = static_cast<PresenceMsg *>(data);
    if (env != nullptr && cb != nullptr && m->hasClient == Instance().HasClients()) {
        napi_value undef, arg;
        napi_get_undefined(env, &undef);
        napi_get_boolean(env, m->hasClient, &arg);
        napi_value argv[] = {arg};
        napi_value result;
        napi_call_function(env, undef, cb, 1, argv, &result);
    }
    delete m;
}

void TcpServer::TsControlCb(napi_env env, napi_value cb, void * /*ctx*/, void *data) {
    auto *m = static_cast<ControlMsg *>(data);
    if (env != nullptr && cb != nullptr) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        napi_value subVal;
        napi_create_uint32(env, m->sub, &subVal);
        napi_value buf;
        void *bufData;
        napi_create_arraybuffer(env, m->body.size(), &bufData, &buf);
        if (!m->body.empty()) memcpy(bufData, m->body.data(), m->body.size());
        napi_value argv[] = {subVal, buf};
        napi_value result;
        napi_call_function(env, undef, cb, 2, argv, &result);
    }
    delete m;
}

} // namespace scrcpy
