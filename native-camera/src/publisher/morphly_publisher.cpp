#include "morphly/morphly_publisher.h"

#include <cstring>
#include <sddl.h>

#include "morphly/morphly_ids.h"
#include "morphly/morphly_protocol.h"

namespace morphly
{
    namespace
    {
        constexpr DWORD kGlobalAttachRetryMs = 1000;

        struct BridgeNames
        {
            const wchar_t* mappingName = nullptr;
            const wchar_t* mutexName = nullptr;
            const wchar_t* eventName = nullptr;
        };

        const BridgeNames kLocalBridgeNames{
            kPublisherMappingName,
            kPublisherMutexName,
            kPublisherEventName,
        };

        const BridgeNames kGlobalBridgeNames{
            kGlobalPublisherMappingName,
            kGlobalPublisherMutexName,
            kGlobalPublisherEventName,
        };

        size_t ComputePayloadBytes(const PublisherConfig& config)
        {
            return static_cast<size_t>(config.stride) * static_cast<size_t>(config.height);
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

        struct SecurityDescriptorHolder
        {
            ~SecurityDescriptorHolder()
            {
                if (descriptor != nullptr)
                {
                    LocalFree(descriptor);
                }
            }

            PSECURITY_DESCRIPTOR descriptor = nullptr;
        };

        HRESULT BuildBridgeSecurityAttributes(SECURITY_ATTRIBUTES* attributes, SecurityDescriptorHolder* descriptorHolder)
        {
            if (attributes == nullptr || descriptorHolder == nullptr)
            {
                return E_POINTER;
            }

            static constexpr wchar_t kBridgeSecurityDescriptor[] =
                L"D:P"
                L"(A;;GA;;;SY)"
                L"(A;;GA;;;BA)"
                L"(A;;GA;;;LS)"
                L"(A;;GA;;;AU)";

            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    kBridgeSecurityDescriptor,
                    SDDL_REVISION_1,
                    &descriptorHolder->descriptor,
                    nullptr))
            {
                return HRESULT_FROM_WIN32(GetLastError());
            }

            attributes->nLength = sizeof(*attributes);
            attributes->lpSecurityDescriptor = descriptorHolder->descriptor;
            attributes->bInheritHandle = FALSE;
            return S_OK;
        }

        void CloseEndpoint(HANDLE* mapping, HANDLE* mutex, HANDLE* eventValue, void** view) noexcept
        {
            if (view != nullptr && *view != nullptr)
            {
                UnmapViewOfFile(*view);
                *view = nullptr;
            }

            if (eventValue != nullptr && *eventValue != nullptr)
            {
                CloseHandle(*eventValue);
                *eventValue = nullptr;
            }

            if (mutex != nullptr && *mutex != nullptr)
            {
                CloseHandle(*mutex);
                *mutex = nullptr;
            }

            if (mapping != nullptr && *mapping != nullptr)
            {
                CloseHandle(*mapping);
                *mapping = nullptr;
            }
        }

        HRESULT InitializeEndpointHeader(
            HANDLE mutex,
            void* view,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount)
        {
            if (mutex == nullptr || view == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
            }

            const HRESULT lockHr = WaitForOwnedMutex(mutex);
            if (FAILED(lockHr))
            {
                return lockHr;
            }

            auto unlock = [&]() noexcept
            {
                ReleaseMutex(mutex);
            };

            auto* header = static_cast<SharedFrameHeader*>(view);
            if (header == nullptr)
            {
                unlock();
                return HRESULT_FROM_WIN32(ERROR_INVALID_ADDRESS);
            }

            const bool needsReset =
                header->magic != kProtocolMagic ||
                header->version != kProtocolVersion ||
                header->width != config.width ||
                header->height != config.height ||
                header->stride != config.stride ||
                header->pixelFormat != kPixelFormatBgra32 ||
                header->fpsNumerator != config.fpsNumerator ||
                header->fpsDenominator != config.fpsDenominator ||
                header->payloadBytes != payloadByteCount;

            if (needsReset)
            {
                std::memset(view, 0, mappingByteCount);
                header->magic = kProtocolMagic;
                header->version = kProtocolVersion;
                header->width = config.width;
                header->height = config.height;
                header->stride = config.stride;
                header->pixelFormat = kPixelFormatBgra32;
                header->fpsNumerator = config.fpsNumerator;
                header->fpsDenominator = config.fpsDenominator;
                header->payloadBytes = static_cast<uint32_t>(payloadByteCount);
            }

            unlock();
            return S_OK;
        }

        HRESULT CreateEndpoint(
            const BridgeNames& names,
            const SECURITY_ATTRIBUTES* securityAttributes,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount,
            HANDLE* mapping,
            HANDLE* mutex,
            HANDLE* eventValue,
            void** view)
        {
            if (mapping == nullptr || mutex == nullptr || eventValue == nullptr || view == nullptr)
            {
                return E_POINTER;
            }

            ULARGE_INTEGER mappingSize{};
            mappingSize.QuadPart = static_cast<unsigned long long>(mappingByteCount);

            *mutex = CreateMutexW(const_cast<SECURITY_ATTRIBUTES*>(securityAttributes), FALSE, names.mutexName);
            if (*mutex == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *eventValue = CreateEventW(const_cast<SECURITY_ATTRIBUTES*>(securityAttributes), FALSE, FALSE, names.eventName);
            if (*eventValue == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *mapping = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                const_cast<SECURITY_ATTRIBUTES*>(securityAttributes),
                PAGE_READWRITE,
                mappingSize.HighPart,
                mappingSize.LowPart,
                names.mappingName);
            if (*mapping == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *view = MapViewOfFile(*mapping, FILE_MAP_ALL_ACCESS, 0, 0, mappingByteCount);
            if (*view == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            return InitializeEndpointHeader(*mutex, *view, config, mappingByteCount, payloadByteCount);
        }

        HRESULT AttachExistingEndpoint(
            const BridgeNames& names,
            const PublisherConfig& config,
            size_t mappingByteCount,
            size_t payloadByteCount,
            HANDLE* mapping,
            HANDLE* mutex,
            HANDLE* eventValue,
            void** view)
        {
            if (mapping == nullptr || mutex == nullptr || eventValue == nullptr || view == nullptr)
            {
                return E_POINTER;
            }

            *mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, names.mappingName);
            if (*mapping == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *mutex = OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, FALSE, names.mutexName);
            if (*mutex == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *eventValue = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, names.eventName);
            if (*eventValue == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            *view = MapViewOfFile(*mapping, FILE_MAP_ALL_ACCESS, 0, 0, mappingByteCount);
            if (*view == nullptr)
            {
                CloseEndpoint(mapping, mutex, eventValue, view);
                return HRESULT_FROM_WIN32(GetLastError());
            }

            return InitializeEndpointHeader(*mutex, *view, config, mappingByteCount, payloadByteCount);
        }

        HRESULT PublishFrameToEndpoint(
            HANDLE mutex,
            HANDLE eventValue,
            void* view,
            size_t payloadByteCount,
            const uint8_t* bgraFrame,
            size_t byteCount,
            int64_t timestampHundredsOfNs)
        {
            if (view == nullptr || mutex == nullptr || eventValue == nullptr)
            {
                return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
            }

            if (bgraFrame == nullptr || byteCount < payloadByteCount)
            {
                return E_INVALIDARG;
            }

            const HRESULT lockHr = WaitForOwnedMutex(mutex);
            if (FAILED(lockHr))
            {
                return lockHr;
            }

            auto* header = static_cast<SharedFrameHeader*>(view);
            auto* payload = reinterpret_cast<uint8_t*>(header + 1);
            std::memcpy(payload, bgraFrame, payloadByteCount);
            header->frameCounter += 1;
            header->timestampHundredsOfNs = timestampHundredsOfNs;
            ReleaseMutex(mutex);

            SetEvent(eventValue);
            return S_OK;
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

        SecurityDescriptorHolder securityDescriptor;
        SECURITY_ATTRIBUTES securityAttributes{};
        const HRESULT securityHr = BuildBridgeSecurityAttributes(&securityAttributes, &securityDescriptor);
        if (FAILED(securityHr))
        {
            return securityHr;
        }

        const HRESULT createHr = CreateEndpoint(
            kLocalBridgeNames,
            &securityAttributes,
            config_,
            mappingByteCount_,
            payloadByteCount_,
            &mapping_,
            &mutex_,
            &event_,
            &view_);
        if (FAILED(createHr))
        {
            Close();
            return createHr;
        }

        lastGlobalAttachAttemptTickMs_ = 0;

        return S_OK;
    }

    HRESULT Publisher::PublishBgraFrame(const uint8_t* bgraFrame, size_t byteCount, int64_t timestampHundredsOfNs)
    {
        if (view_ == nullptr || mutex_ == nullptr || event_ == nullptr)
        {
            return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);
        }

        const HRESULT localHr = PublishFrameToEndpoint(
            mutex_,
            event_,
            view_,
            payloadByteCount_,
            bgraFrame,
            byteCount,
            timestampHundredsOfNs);
        if (FAILED(localHr))
        {
            return localHr;
        }

        const ULONGLONG now = GetTickCount64();
        if (globalView_ == nullptr && (now - lastGlobalAttachAttemptTickMs_) >= kGlobalAttachRetryMs)
        {
            lastGlobalAttachAttemptTickMs_ = now;
            const HRESULT globalAttachHr = AttachExistingEndpoint(
                kGlobalBridgeNames,
                config_,
                mappingByteCount_,
                payloadByteCount_,
                &globalMapping_,
                &globalMutex_,
                &globalEvent_,
                &globalView_);
            if (FAILED(globalAttachHr))
            {
                CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
            }
        }

        if (globalView_ != nullptr)
        {
            const HRESULT globalHr = PublishFrameToEndpoint(
                globalMutex_,
                globalEvent_,
                globalView_,
                payloadByteCount_,
                bgraFrame,
                byteCount,
                timestampHundredsOfNs);
            if (FAILED(globalHr))
            {
                CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
            }
        }

        return S_OK;
    }

    void Publisher::Close()
    {
        CloseEndpoint(&globalMapping_, &globalMutex_, &globalEvent_, &globalView_);
        CloseEndpoint(&mapping_, &mutex_, &event_, &view_);

        mappingByteCount_ = 0;
        payloadByteCount_ = 0;
        lastGlobalAttachAttemptTickMs_ = 0;
    }
}
