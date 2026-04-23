#pragma once

#include <cstdint>

namespace morphly
{
    inline constexpr uint32_t kProtocolMagic = 0x4d43414d;
    inline constexpr uint32_t kProtocolVersion = 1;
    inline constexpr uint32_t kPixelFormatBgra32 = 1;

    struct SharedFrameHeader
    {
        uint32_t magic = kProtocolMagic;
        uint32_t version = kProtocolVersion;
        uint32_t width = 0;
        uint32_t height = 0;
        uint32_t stride = 0;
        uint32_t pixelFormat = kPixelFormatBgra32;
        uint32_t fpsNumerator = 0;
        uint32_t fpsDenominator = 1;
        uint32_t payloadBytes = 0;
        uint32_t reserved = 0;
        uint64_t frameCounter = 0;
        int64_t timestampHundredsOfNs = 0;
    };
}
