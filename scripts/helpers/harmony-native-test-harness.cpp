// Appended to the exact production helpers and the test fixtures. The host
// executable only dispatches a bounded binary test protocol; it does not
// reimplement SPS parsing, decoder gating or the transport queue policy.
#if !defined(_WIN32)
extern "C" int getchar();
extern "C" int putchar(int value);

static bool ReadHarnessWord(uint32_t &value) {
    value = 0;
    for (uint32_t i = 0; i < 4; ++i) {
        const int byte = getchar();
        if (byte < 0) return false;
        value |= static_cast<uint32_t>(byte) << (i * 8);
    }
    return true;
}

int main() {
    uint32_t count = 0;
    if (!ReadHarnessWord(count) || count > 4096) return 2;
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t fields[12]{};
        for (auto &field : fields) if (!ReadHarnessWord(field)) return 2;
        const auto bytesSize = fields[10], ppsSize = fields[11];
        if (bytesSize > 65536 || ppsSize > 65535) return 2;
        for (uint32_t j = 0; j < bytesSize + ppsSize; ++j) {
            const int byte = getchar();
            if (byte < 0) return 2;
            const auto offset = j < bytesSize ? j : 65536 + j - bytesSize;
            fixture[offset] = static_cast<uint8_t>(byte);
        }
        int result = 0;
        switch (fields[0]) {
            case 0: result = geometry(fields[1]); break;
            case 1: result = parameter_sets(fields[1], ppsSize); break;
            case 2: result = idr_matches(fields[1], fields[2]); break;
            case 3: reset_gate(); break;
            case 4: result = gate_accepts(fields[6], fields[7]); break;
            case 5: result = gate_needs_config(); break;
            case 6: emitted_config(); break;
            case 7: result = queue_reset(fields[3]); break;
            case 8: result = queue_enqueue(fields[3], fields[2], fields[4], fields[5], fields[6]); break;
            case 9: result = queue_partial(fields[3], fields[8]); break;
            case 10: result = queue_drain_front(fields[3]); break;
            case 11: result = queue_count(fields[3]); break;
            case 12: result = queue_id(fields[3], fields[9]); break;
            case 13: result = queue_offset(fields[3]); break;
            case 14: result = queue_awaiting(fields[3]); break;
            case 15: timestamp_reset(); break;
            case 16: timestamp_generation(); break;
            case 17: result = timestamp_normalize(fields[1], fields[2]); break;
            default: return 2;
        }
        const auto value = static_cast<uint32_t>(result);
        for (uint32_t j = 0; j < 4; ++j) {
            if (putchar(static_cast<int>((value >> (j * 8)) & 255)) < 0) return 3;
        }
    }
    return 0;
}
#endif
