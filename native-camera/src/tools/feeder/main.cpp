#include <windows.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "morphly/morphly_publisher.h"

namespace
{
    std::atomic_bool g_running = true;

    BOOL WINAPI HandleConsoleSignal(DWORD signal)
    {
        switch (signal)
        {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_LOGOFF_EVENT:
        case CTRL_SHUTDOWN_EVENT:
            g_running = false;
            return TRUE;
        default:
            return FALSE;
        }
    }

    int64_t GetTimestampHundredsOfNs()
    {
        FILETIME fileTime{};
        GetSystemTimePreciseAsFileTime(&fileTime);

        ULARGE_INTEGER value{};
        value.LowPart = fileTime.dwLowDateTime;
        value.HighPart = fileTime.dwHighDateTime;
        return static_cast<int64_t>(value.QuadPart);
    }

    void FillFrame(const morphly::PublisherConfig& config, uint64_t frameIndex, std::vector<uint8_t>* frame)
    {
        frame->resize(static_cast<size_t>(config.stride) * config.height);

        for (uint32_t y = 0; y < config.height; ++y)
        {
            uint8_t* row = frame->data() + (static_cast<size_t>(y) * config.stride);
            for (uint32_t x = 0; x < config.width; ++x)
            {
                const uint8_t phase = static_cast<uint8_t>((frameIndex * 5) & 0xff);
                row[(x * 4) + 0] = static_cast<uint8_t>((x + phase) & 0xff);
                row[(x * 4) + 1] = static_cast<uint8_t>((y + (phase * 2)) & 0xff);
                row[(x * 4) + 2] = static_cast<uint8_t>(((x / 3) + (y / 2) + phase) & 0xff);
                row[(x * 4) + 3] = 0xff;
            }
        }
    }

    void PrintUsage()
    {
        std::wcout
            << L"Usage:\n"
            << L"  morphly_cam_feeder [--seconds N] [--width N] [--height N] [--fps N]\n";
    }
}

int wmain(int argc, wchar_t** argv)
{
    morphly::PublisherConfig config;
    uint32_t runtimeSeconds = 0;

    for (int index = 1; index < argc; ++index)
    {
        const std::wstring option = argv[index];
        if (option == L"--seconds" && index + 1 < argc)
        {
            runtimeSeconds = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else if (option == L"--width" && index + 1 < argc)
        {
            config.width = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else if (option == L"--height" && index + 1 < argc)
        {
            config.height = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else if (option == L"--fps" && index + 1 < argc)
        {
            config.fpsNumerator = static_cast<uint32_t>(_wtoi(argv[++index]));
        }
        else
        {
            PrintUsage();
            return 1;
        }
    }

    config.stride = config.width * 4;

    if (config.width == 0 || config.height == 0 || config.fpsNumerator == 0)
    {
        PrintUsage();
        return 1;
    }

    morphly::Publisher publisher;
    const HRESULT openHr = publisher.Open(config);
    if (FAILED(openHr))
    {
        std::wcerr << L"Failed to open frame publisher. HRESULT=0x" << std::hex << static_cast<unsigned long>(openHr) << L"\n";
        return 1;
    }

    SetConsoleCtrlHandler(HandleConsoleSignal, TRUE);

    std::vector<uint8_t> frame;
    uint64_t frameIndex = 0;
    const auto frameInterval = std::chrono::nanoseconds(1'000'000'000LL / config.fpsNumerator);
    const auto startedAt = std::chrono::steady_clock::now();
    auto nextFrameTime = startedAt;

    std::wcout << L"Publishing frames to Morphly Cam. Press Ctrl+C to stop.\n";

    while (g_running)
    {
        if (runtimeSeconds > 0)
        {
            const auto elapsed = std::chrono::steady_clock::now() - startedAt;
            if (elapsed >= std::chrono::seconds(runtimeSeconds))
            {
                break;
            }
        }

        FillFrame(config, frameIndex, &frame);
        const HRESULT publishHr = publisher.PublishBgraFrame(frame.data(), frame.size(), GetTimestampHundredsOfNs());
        if (FAILED(publishHr))
        {
            std::wcerr << L"Failed to publish a frame. HRESULT=0x" << std::hex << static_cast<unsigned long>(publishHr) << L"\n";
            return 1;
        }

        ++frameIndex;
        nextFrameTime += frameInterval;
        std::this_thread::sleep_until(nextFrameTime);
    }

    publisher.Close();
    return 0;
}