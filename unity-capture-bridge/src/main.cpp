// This is UnityCapture's public sender/receiver protocol. Keeping it as the
// single source of truth prevents Morphly from implementing another camera.
#include "shared.inl"

#include <fcntl.h>
#include <io.h>

#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>

namespace
{
    constexpr uint32_t kPipeProtocolMagic = 0x5041434d;
    constexpr uint32_t kPipeProtocolVersion = 1;
    constexpr int kCaptureDeviceNumber = 0;
    constexpr int kFrameTimeoutMilliseconds = 1000;
    constexpr int kSkippedFramesBeforeReceiverIsInactive = 12;

    struct PipeFrameHeader
    {
        uint32_t magic = kPipeProtocolMagic;
        uint32_t version = kPipeProtocolVersion;
        uint32_t width = 0;
        uint32_t height = 0;
        uint32_t strideBytes = 0;
        uint32_t fpsNumerator = 0;
        uint32_t fpsDenominator = 1;
        uint32_t payloadBytes = 0;
        int64_t timestampHundredsOfNs = 0;
    };

    static_assert(sizeof(PipeFrameHeader) == 40, "The Electron pipe header must remain stable.");

    bool ReadExact(std::istream& input, void* destination, size_t byteCount)
    {
        input.read(static_cast<char*>(destination), static_cast<std::streamsize>(byteCount));
        return static_cast<size_t>(input.gcount()) == byteCount;
    }

    bool ValidateHeader(const PipeFrameHeader& header)
    {
        if (header.magic != kPipeProtocolMagic || header.version != kPipeProtocolVersion)
        {
            return false;
        }

        if (header.width == 0 || header.height == 0 || header.width > 3840 || header.height > 2160)
        {
            return false;
        }

        if ((header.width % 4) != 0 || header.strideBytes < header.width * 4 || (header.strideBytes % 4) != 0)
        {
            return false;
        }

        if (header.fpsNumerator == 0 || header.fpsDenominator == 0)
        {
            return false;
        }

        const uint64_t expectedPayloadBytes =
            static_cast<uint64_t>(header.strideBytes) * static_cast<uint64_t>(header.height);
        return expectedPayloadBytes == header.payloadBytes
            && expectedPayloadBytes <= static_cast<uint64_t>(MAX_SHARED_IMAGE_SIZE)
            && expectedPayloadBytes <= std::numeric_limits<DWORD>::max();
    }
}

int wmain()
{
    if (_setmode(_fileno(stdin), _O_BINARY) == -1)
    {
        std::cerr << "Unable to read binary frames from stdin.\n";
        return 1;
    }

    SharedImageMemory unityCaptureSender(kCaptureDeviceNumber);
    std::vector<uint8_t> rgbaFrame;
    bool wasWaitingForReceiver = false;
    int skippedFramesWithoutReceiver = 0;

    for (;;)
    {
        PipeFrameHeader header{};
        std::cin.read(reinterpret_cast<char*>(&header), static_cast<std::streamsize>(sizeof(header)));

        const size_t headerBytesRead = static_cast<size_t>(std::cin.gcount());
        if (headerBytesRead == 0 && std::cin.eof())
        {
            return 0;
        }

        if (headerBytesRead != sizeof(header) || !ValidateHeader(header))
        {
            std::cerr << "Invalid or incomplete frame header received.\n";
            return 1;
        }

        rgbaFrame.resize(header.payloadBytes);
        if (!ReadExact(std::cin, rgbaFrame.data(), rgbaFrame.size()))
        {
            std::cerr << "Unexpected end of stream while reading an RGBA frame.\n";
            return 1;
        }

        // UnityCapture creates its named objects when a receiving application
        // opens the camera. Frames can be safely discarded until that happens.
        if (!unityCaptureSender.SendIsReady())
        {
            skippedFramesWithoutReceiver = 0;
            if (!wasWaitingForReceiver)
            {
                std::cerr << "Waiting for an application to open Morphly Virtual Camera.\n";
                wasWaitingForReceiver = true;
            }
            continue;
        }

        const auto result = unityCaptureSender.Send(
            static_cast<int>(header.width),
            static_cast<int>(header.height),
            static_cast<int>(header.strideBytes / 4),
            static_cast<DWORD>(header.payloadBytes),
            SharedImageMemory::FORMAT_UINT8,
            SharedImageMemory::RESIZEMODE_LINEAR,
            SharedImageMemory::MIRRORMODE_DISABLED,
            kFrameTimeoutMilliseconds,
            rgbaFrame.data());

        if (result == SharedImageMemory::SENDRES_TOOLARGE)
        {
            std::cerr << "UnityCapture rejected a frame that exceeds its shared buffer.\n";
            return 1;
        }

        if (result == SharedImageMemory::SENDRES_OK)
        {
            skippedFramesWithoutReceiver = 0;
            if (wasWaitingForReceiver)
            {
                std::cerr << "Connected to the UnityCapture virtual camera.\n";
                wasWaitingForReceiver = false;
            }
        }
        else if (
            result == SharedImageMemory::SENDRES_WARN_FRAMESKIP
            && ++skippedFramesWithoutReceiver >= kSkippedFramesBeforeReceiverIsInactive)
        {
            skippedFramesWithoutReceiver = kSkippedFramesBeforeReceiverIsInactive;
            if (!wasWaitingForReceiver)
            {
                std::cerr << "Waiting for an application to open Morphly Virtual Camera.\n";
                wasWaitingForReceiver = true;
            }
        }
    }
}
