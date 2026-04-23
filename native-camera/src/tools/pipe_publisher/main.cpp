#include <windows.h>

#include <chrono>
#include <fcntl.h>
#include <io.h>

#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "morphly/morphly_publisher.h"

namespace
{
    constexpr uint32_t kPipeProtocolMagic = 0x5041434d;
    constexpr uint32_t kPipeProtocolVersion = 1;

    struct PipeFrameHeader
    {
        uint32_t magic = kPipeProtocolMagic;
        uint32_t version = kPipeProtocolVersion;
        uint32_t width = 0;
        uint32_t height = 0;
        uint32_t stride = 0;
        uint32_t fpsNumerator = 0;
        uint32_t fpsDenominator = 1;
        uint32_t payloadBytes = 0;
        int64_t timestampHundredsOfNs = 0;
    };

    static_assert(sizeof(PipeFrameHeader) == 40, "PipeFrameHeader must stay stable.");

    int64_t GetTimestampHundredsOfNs()
    {
        FILETIME fileTime{};
        GetSystemTimePreciseAsFileTime(&fileTime);

        ULARGE_INTEGER value{};
        value.LowPart = fileTime.dwLowDateTime;
        value.HighPart = fileTime.dwHighDateTime;
        return static_cast<int64_t>(value.QuadPart);
    }

    bool ReadExact(std::istream* input, void* buffer, size_t byteCount)
    {
        if (input == nullptr || buffer == nullptr)
        {
            return false;
        }

        input->read(static_cast<char*>(buffer), static_cast<std::streamsize>(byteCount));
        return static_cast<size_t>(input->gcount()) == byteCount;
    }

    bool NeedsReopen(const morphly::PublisherConfig& currentConfig, const morphly::PublisherConfig& nextConfig, bool isOpen)
    {
        return !isOpen
            || currentConfig.width != nextConfig.width
            || currentConfig.height != nextConfig.height
            || currentConfig.stride != nextConfig.stride
            || currentConfig.fpsNumerator != nextConfig.fpsNumerator
            || currentConfig.fpsDenominator != nextConfig.fpsDenominator;
    }

    bool ValidateHeader(const PipeFrameHeader& header)
    {
        if (header.magic != kPipeProtocolMagic || header.version != kPipeProtocolVersion)
        {
            return false;
        }

        if (header.width == 0 || header.height == 0 || header.stride < (header.width * 4))
        {
            return false;
        }

        if (header.fpsNumerator == 0 || header.fpsDenominator == 0)
        {
            return false;
        }

        const uint64_t expectedBytes = static_cast<uint64_t>(header.stride) * header.height;
        return expectedBytes == header.payloadBytes;
    }

    void FillTestPattern(const morphly::PublisherConfig& config, uint64_t frameIndex, std::vector<uint8_t>* frameBytes)
    {
        frameBytes->resize(static_cast<size_t>(config.stride) * config.height);

        for (uint32_t y = 0; y < config.height; ++y)
        {
            uint8_t* row = frameBytes->data() + (static_cast<size_t>(y) * config.stride);
            for (uint32_t x = 0; x < config.width; ++x)
            {
                const uint8_t phase = static_cast<uint8_t>((frameIndex * 4) & 0xff);
                row[(x * 4) + 0] = static_cast<uint8_t>((x + phase) & 0xff);
                row[(x * 4) + 1] = static_cast<uint8_t>((y + 64) & 0xff);
                row[(x * 4) + 2] = static_cast<uint8_t>(((x / 2) + (y / 2) + phase) & 0xff);
                row[(x * 4) + 3] = 0xff;
            }
        }
    }

    void LogFrameStats(const morphly::PublisherConfig& config, uint64_t publishedFrames, const std::chrono::steady_clock::time_point& startedAt)
    {
        if (publishedFrames == 0)
        {
            return;
        }

        const auto elapsed = std::chrono::steady_clock::now() - startedAt;
        const double seconds = std::max(0.001, std::chrono::duration<double>(elapsed).count());
        const double fps = static_cast<double>(publishedFrames) / seconds;

        std::cerr
            << "MorphlyCam publisher stats: frames=" << publishedFrames
            << " fps=" << fps
            << " size=" << config.width << "x" << config.height
            << " stride=" << config.stride
            << " format=BGRA32\n";
    }
}

int wmain(int argc, wchar_t** argv)
{
    bool testMode = false;
    morphly::PublisherConfig testConfig{};

    for (int index = 1; index < argc; ++index)
    {
        const std::wstring option = argv[index];
        if (option == L"--test")
        {
            testMode = true;
        }
        else if (option == L"--width" && index + 1 < argc)
        {
            testConfig.width = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else if (option == L"--height" && index + 1 < argc)
        {
            testConfig.height = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else if (option == L"--fps" && index + 1 < argc)
        {
            testConfig.fpsNumerator = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else
        {
            std::cerr << "Usage: morphly_cam_pipe_publisher.exe [--test] [--width N] [--height N] [--fps N]\n";
            return 1;
        }
    }

    testConfig.stride = testConfig.width * 4;

    if (!testMode && _setmode(_fileno(stdin), _O_BINARY) == -1)
    {
        std::cerr << "Failed to switch stdin to binary mode.\n";
        return 1;
    }

    morphly::Publisher publisher;
    morphly::PublisherConfig currentConfig{};
    bool isOpen = false;
    std::vector<uint8_t> frameBytes;
    uint64_t publishedFrames = 0;
    auto statsWindowStartedAt = std::chrono::steady_clock::now();

    if (testMode)
    {
        const morphly::PublisherConfig nextConfig = testConfig;
        if (nextConfig.width == 0 || nextConfig.height == 0 || nextConfig.fpsNumerator == 0)
        {
            std::cerr << "Test mode requires non-zero width, height, and fps.\n";
            return 1;
        }

        const HRESULT openHr = publisher.Open(nextConfig);
        if (FAILED(openHr))
        {
            std::cerr << "Failed to open Morphly publisher in test mode. HRESULT=0x" << std::hex << static_cast<unsigned long>(openHr) << "\n";
            return 1;
        }

        currentConfig = nextConfig;
        isOpen = true;
        std::cerr
            << "MorphlyCam publisher test mode active: "
            << currentConfig.width << "x" << currentConfig.height
            << " @" << currentConfig.fpsNumerator << "/" << currentConfig.fpsDenominator
            << " format=BGRA32\n";

        const auto frameInterval = std::chrono::nanoseconds(1'000'000'000LL / currentConfig.fpsNumerator);
        auto nextFrameDeadline = std::chrono::steady_clock::now();

        for (uint64_t frameIndex = 0;; ++frameIndex)
        {
            FillTestPattern(currentConfig, frameIndex, &frameBytes);
            const HRESULT publishHr = publisher.PublishBgraFrame(frameBytes.data(), frameBytes.size(), GetTimestampHundredsOfNs());
            if (FAILED(publishHr))
            {
                std::cerr << "Failed to publish test frame. HRESULT=0x" << std::hex << static_cast<unsigned long>(publishHr) << "\n";
                return 1;
            }

            ++publishedFrames;
            if ((publishedFrames % currentConfig.fpsNumerator) == 0)
            {
                LogFrameStats(currentConfig, publishedFrames, statsWindowStartedAt);
            }

            nextFrameDeadline += frameInterval;
            Sleep(0);
            std::this_thread::sleep_until(nextFrameDeadline);
        }
    }

    for (;;)
    {
        PipeFrameHeader header{};
        std::cin.read(reinterpret_cast<char*>(&header), static_cast<std::streamsize>(sizeof(header)));

        const auto headerBytesRead = static_cast<size_t>(std::cin.gcount());
        if (headerBytesRead == 0 && std::cin.eof())
        {
            break;
        }

        if (headerBytesRead != sizeof(header))
        {
            std::cerr << "Unexpected end of stream while reading frame header.\n";
            return 1;
        }

        if (!ValidateHeader(header))
        {
            std::cerr << "Invalid frame header received.\n";
            return 1;
        }

        morphly::PublisherConfig nextConfig{};
        nextConfig.width = header.width;
        nextConfig.height = header.height;
        nextConfig.stride = header.stride;
        nextConfig.fpsNumerator = header.fpsNumerator;
        nextConfig.fpsDenominator = header.fpsDenominator;

        if (NeedsReopen(currentConfig, nextConfig, isOpen))
        {
            publisher.Close();
            const HRESULT openHr = publisher.Open(nextConfig);
            if (FAILED(openHr))
            {
                std::cerr << "Failed to open Morphly publisher. HRESULT=0x" << std::hex << static_cast<unsigned long>(openHr) << "\n";
                return 1;
            }

            currentConfig = nextConfig;
            isOpen = true;
        }

        frameBytes.resize(header.payloadBytes);
        if (!ReadExact(&std::cin, frameBytes.data(), frameBytes.size()))
        {
            std::cerr << "Unexpected end of stream while reading frame payload.\n";
            return 1;
        }

        const int64_t timestampHundredsOfNs = header.timestampHundredsOfNs == 0
            ? GetTimestampHundredsOfNs()
            : header.timestampHundredsOfNs;

        const HRESULT publishHr = publisher.PublishBgraFrame(frameBytes.data(), frameBytes.size(), timestampHundredsOfNs);
        if (FAILED(publishHr))
        {
            std::cerr << "Failed to publish frame. HRESULT=0x" << std::hex << static_cast<unsigned long>(publishHr) << "\n";
            return 1;
        }

        ++publishedFrames;
        if ((publishedFrames % currentConfig.fpsNumerator) == 0)
        {
            LogFrameStats(currentConfig, publishedFrames, statsWindowStartedAt);
        }
    }

    publisher.Close();
    return 0;
}
