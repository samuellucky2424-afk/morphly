// This is UnityCapture's public sender/receiver protocol. Keeping it as the
// single source of truth prevents Morphly from implementing another camera.
#include "shared.inl"
#include "morphly/morphly_publisher.h"

#include <fcntl.h>
#include <io.h>

#include <cstdint>
#include <cstring>
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
    constexpr uint64_t kMediaFoundationProbeIntervalMilliseconds = 1000;

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

    void ConvertBottomUpRgbaToTopDownBgra(
        const PipeFrameHeader& header,
        const std::vector<uint8_t>& rgbaFrame,
        std::vector<uint8_t>* bgraFrame)
    {
        bgraFrame->resize(header.payloadBytes);

        for (uint32_t destinationY = 0; destinationY < header.height; ++destinationY)
        {
            const uint32_t sourceY = header.height - destinationY - 1;
            const uint8_t* source = rgbaFrame.data() + (static_cast<size_t>(sourceY) * header.strideBytes);
            uint8_t* destination = bgraFrame->data() + (static_cast<size_t>(destinationY) * header.strideBytes);

            for (uint32_t x = 0; x < header.width; ++x)
            {
                destination[0] = source[2];
                destination[1] = source[1];
                destination[2] = source[0];
                destination[3] = source[3];
                source += 4;
                destination += 4;
            }

            const size_t packedRowBytes = static_cast<size_t>(header.width) * 4;
            if (header.strideBytes > packedRowBytes)
            {
                std::memcpy(
                    destination,
                    source,
                    static_cast<size_t>(header.strideBytes) - packedRowBytes);
            }
        }
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
    morphly::Publisher mediaFoundationPublisher;
    morphly::PublisherConfig mediaFoundationConfig{};
    std::vector<uint8_t> rgbaFrame;
    std::vector<uint8_t> bgraFrame;
    bool mediaFoundationPublisherOpen = false;
    bool receiverStateReported = false;
    bool receiverConnected = false;
    uint64_t lastMediaFoundationProbeTickMs = 0;
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

        const morphly::PublisherConfig nextMediaFoundationConfig{
            header.width,
            header.height,
            header.strideBytes,
            header.fpsNumerator,
            header.fpsDenominator,
        };
        if (!mediaFoundationPublisherOpen
            || mediaFoundationConfig.width != nextMediaFoundationConfig.width
            || mediaFoundationConfig.height != nextMediaFoundationConfig.height
            || mediaFoundationConfig.stride != nextMediaFoundationConfig.stride
            || mediaFoundationConfig.fpsNumerator != nextMediaFoundationConfig.fpsNumerator
            || mediaFoundationConfig.fpsDenominator != nextMediaFoundationConfig.fpsDenominator)
        {
            mediaFoundationPublisher.Close();
            const HRESULT openResult = mediaFoundationPublisher.Open(nextMediaFoundationConfig);
            mediaFoundationPublisherOpen = SUCCEEDED(openResult);
            if (mediaFoundationPublisherOpen)
            {
                mediaFoundationConfig = nextMediaFoundationConfig;
                std::cerr << "Media Foundation camera bridge ready for WhatsApp.\n";
            }
            else
            {
                std::cerr << "Unable to open the Media Foundation camera bridge. HRESULT=0x"
                          << std::hex << static_cast<unsigned long>(openResult) << std::dec << "\n";
            }
        }

        bool unityCaptureReceiverActive = unityCaptureSender.SendIsReady();
        if (unityCaptureReceiverActive)
        {
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
            }
            else if (
                result == SharedImageMemory::SENDRES_WARN_FRAMESKIP
                && ++skippedFramesWithoutReceiver >= kSkippedFramesBeforeReceiverIsInactive)
            {
                skippedFramesWithoutReceiver = kSkippedFramesBeforeReceiverIsInactive;
                unityCaptureReceiverActive = false;
            }
        }
        else
        {
            skippedFramesWithoutReceiver = 0;
        }

        bool mediaFoundationReceiverActive = mediaFoundationPublisherOpen
            && mediaFoundationPublisher.IsMediaFoundationReceiverActive();
        const uint64_t nowTickMs = GetTickCount64();
        const bool mediaFoundationProbeDue = mediaFoundationPublisherOpen
            && (nowTickMs - lastMediaFoundationProbeTickMs) >= kMediaFoundationProbeIntervalMilliseconds;

        if (mediaFoundationPublisherOpen && (mediaFoundationReceiverActive || mediaFoundationProbeDue))
        {
            ConvertBottomUpRgbaToTopDownBgra(header, rgbaFrame, &bgraFrame);
            const HRESULT publishResult = mediaFoundationPublisher.PublishBgraFrame(
                bgraFrame.data(),
                bgraFrame.size(),
                header.timestampHundredsOfNs);
            if (FAILED(publishResult))
            {
                std::cerr << "Media Foundation frame publish failed. HRESULT=0x"
                          << std::hex << static_cast<unsigned long>(publishResult) << std::dec << "\n";
            }
            lastMediaFoundationProbeTickMs = nowTickMs;
            mediaFoundationReceiverActive = mediaFoundationPublisher.IsMediaFoundationReceiverActive();
        }

        const bool nextReceiverConnected = unityCaptureReceiverActive || mediaFoundationReceiverActive;
        if (!receiverStateReported || nextReceiverConnected != receiverConnected)
        {
            receiverStateReported = true;
            receiverConnected = nextReceiverConnected;
            std::cerr << (receiverConnected
                ? "Connected to the Morphly virtual camera.\n"
                : "Waiting for an application to open Morphly Virtual Camera.\n");
        }
    }
}
