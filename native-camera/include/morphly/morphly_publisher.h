#pragma once

#include <cstddef>
#include <cstdint>
#include <windows.h>

namespace morphly
{
    struct PublisherConfig
    {
        uint32_t width = 1280;
        uint32_t height = 720;
        uint32_t stride = 1280 * 4;
        uint32_t fpsNumerator = 30;
        uint32_t fpsDenominator = 1;
    };

    class Publisher
    {
    public:
        Publisher() = default;
        ~Publisher();

        Publisher(const Publisher&) = delete;
        Publisher& operator=(const Publisher&) = delete;

        HRESULT Open(const PublisherConfig& config);
        HRESULT PublishBgraFrame(const uint8_t* bgraFrame, size_t byteCount, int64_t timestampHundredsOfNs);
        void Close();

    private:
        PublisherConfig config_{};
        HANDLE mapping_ = nullptr;
        HANDLE mutex_ = nullptr;
        HANDLE event_ = nullptr;
        HANDLE globalMapping_ = nullptr;
        HANDLE globalMutex_ = nullptr;
        HANDLE globalEvent_ = nullptr;
        HANDLE mfBridgeFile_ = nullptr;
        HANDLE mfBridgeMapping_ = nullptr;
        size_t mappingByteCount_ = 0;
        size_t payloadByteCount_ = 0;
        void* view_ = nullptr;
        void* globalView_ = nullptr;
        void* mfBridgeView_ = nullptr;
        ULONGLONG lastGlobalAttachAttemptTickMs_ = 0;
    };
}

