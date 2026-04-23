#include "morphly/morphly_publisher.h"

#include <cstring>

#include "morphly/morphly_ids.h"
#include "morphly/morphly_protocol.h"

namespace morphly
{
    namespace
    {
        size_t ComputePayloadBytes(const PublisherConfig& config)
        {
            return static_cast<size_t>(config.stride) * static_cast<size_t>(config.height);
        }

        int64_t GetTimestampHundredsOfNs() noexcept
        {
            FILETIME fileTime{};
            GetSystemTimePreciseAsFileTime(&fileTime);

            ULARGE_INTEGER value{};
            value.LowPart = fileTime.dwLowDateTime;
            value.HighPart = fileTime.dwHighDateTime;
            return static_cast<int64_t>(value.QuadPart);
        }

        HRESULT WaitForOwnedMutex(HANDLE mutex)
        {
            const DWORD waitResult = WaitForSingleObject(mutex, 2000);
            if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_ABANDONED)
            {
                return S_OK;
            }

            if (waitResult == WAIT_TIMEOUT)
            {
                return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
            }

            return HRESULT_FROM_WIN32(GetLastError());
        }
    }

    Publisher::~Publisher()
    {
        Close();
    }

    HRESULT Publisher::Open(const PublisherConfig& config)
    {
        if (mapping_ != nullptr)
        {
            return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        }

        if (config.width == 0 || config.height == 0 || config.fpsNumerator == 0 || config.fpsDenominator == 0)
        {
            return E_INVALIDARG;
        }

        if (config.stride < config.width * 4u)
        {
            return E_INVALIDARG;
        }

        payloadByteCount_ = ComputePayloadBytes(config);
        mappingByteCount_ = sizeof(SharedFrameHeader) + payloadByteCount_;
        if (payloadByteCount_ == 0 || mappingByteCount_ <= sizeof(SharedFrameHeader))
        {
            return E_INVALIDARG;
        }

        config_ = config;

        mutex_ = CreateMutexW(nullptr, FALSE, kPublisherMutexName);
        if (mutex_ == nullptr)
        {
            Close();
            return HRESULT_FROM_WIN32(GetLastError());
        }

        event_ = CreateEventW(nullptr, FALSE, FALSE, kPublisherEventName);
        if (event_ == nullptr)
        {
            Close();
            return HRESULT_FROM_WIN32(GetLastError());
        }

        ULARGE_INTEGER mappingSize{};
        mappingSize.QuadPart = static_cast<unsigned long long>(mappingByteCount_);
        mapping_ = CreateFileMappingW(
            INVALID_HANDLE_VALUE,
            nullptr,
            PAGE_READWRITE,
            mappingSize.HighPart,
            mappingSize.LowPart,
            kPublisherMappingName);
        if (mapping_ == nullptr)
        {
            Close();
            return HRESULT_FROM_WIN32(GetLastError());
        }

        view_ = MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, mappingByteCount_);
        if (view_ == nullptr)
        {
            Close();
            return HRESULT_FROM_WIN32(GetLastError());
        }

        const HRESULT lockHr = WaitForOwnedMutex(mutex_);
        if (FAILED(lockHr))
        {
            Close();
            return lockHr;
        }

        auto* header = static_cast<SharedFrameHeader*>(view_);
        std::memset(view_, 0, mappingByteCount_);
        header->magic = kProtocolMagic;
        header->version = kProtocolVersion;
        header->width = config.width;
        header->height = config.height;
        header->stride = config.stride;
        header->pixelFormat = kPixelFormatBgra32;
        header->fpsNumerator = config.fpsNumerator;
        header->fpsDenominator = config.fpsDenominator;
        header->payloadBytes = static_cast<uint32_t>(payloadByteCount_);
        header->frameCounter = 1;
        header->timestampHundredsOfNs = GetTimestampHundredsOfNs();
        ReleaseMutex(mutex_);
        SetEvent(event_);

        return S_OK;
    }

    HRESULT Publisher::PublishBgraFrame(const uint8_t* bgraFrame, size_t byteCount, int64_t timestampHundredsOfNs)
    {
        if (view_ == nullptr || mutex_ == nullptr || event_ == nullptr)
        {
            return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
        }

        if (bgraFrame == nullptr || byteCount < payloadByteCount_)
        {
            return E_INVALIDARG;
        }

        const HRESULT lockHr = WaitForOwnedMutex(mutex_);
        if (FAILED(lockHr))
        {
            return lockHr;
        }

        auto* header = static_cast<SharedFrameHeader*>(view_);
        auto* payload = reinterpret_cast<uint8_t*>(header + 1);
        std::memcpy(payload, bgraFrame, payloadByteCount_);
        header->frameCounter += 1;
        header->timestampHundredsOfNs = timestampHundredsOfNs;
        ReleaseMutex(mutex_);

        SetEvent(event_);
        return S_OK;
    }

    void Publisher::Close()
    {
        if (view_ != nullptr)
        {
            UnmapViewOfFile(view_);
            view_ = nullptr;
        }

        if (event_ != nullptr)
        {
            CloseHandle(event_);
            event_ = nullptr;
        }

        if (mutex_ != nullptr)
        {
            CloseHandle(mutex_);
            mutex_ = nullptr;
        }

        if (mapping_ != nullptr)
        {
            CloseHandle(mapping_);
            mapping_ = nullptr;
        }

        mappingByteCount_ = 0;
        payloadByteCount_ = 0;
    }
}
