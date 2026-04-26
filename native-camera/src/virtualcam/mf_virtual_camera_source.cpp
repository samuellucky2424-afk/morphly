#include "mf_virtual_camera_source.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <vector>

#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <propvarutil.h>
#include <sddl.h>
#include <strsafe.h>
#include <wrl.h>

#include "morphly/morphly_ids.h"
#include "morphly/morphly_protocol.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

#ifndef RETURN_IF_FAILED
#define RETURN_IF_FAILED(expression)                     \
    do                                                  \
    {                                                   \
        const HRESULT __hr = (expression);              \
        if (FAILED(__hr))                               \
        {                                               \
            return __hr;                                \
        }                                               \
    } while (false)
#endif

namespace morphly::virtualcam
{
    namespace
    {
        constexpr uint32_t kDefaultWidth = 1280;
        constexpr uint32_t kDefaultHeight = 720;
        constexpr uint32_t kDefaultStride = kDefaultWidth * 4;
        constexpr uint32_t kDefaultFpsNumerator = 30;
        constexpr uint32_t kDefaultFpsDenominator = 1;
        constexpr DWORD kStreamId = 0;
        constexpr LONGLONG kHundredsOfNsPerSecond = 10'000'000LL;

        std::atomic_ulong g_objectCount = 0;
        std::atomic_ulong g_lockCount = 0;

        enum class SourceState
        {
            Invalid,
            Stopped,
            Started,
            Shutdown,
        };

        struct MediaConfig
        {
            uint32_t width = kDefaultWidth;
            uint32_t height = kDefaultHeight;
            uint32_t stride = kDefaultStride;
            uint32_t fpsNumerator = kDefaultFpsNumerator;
            uint32_t fpsDenominator = kDefaultFpsDenominator;
        };

        void AddObjectRef() noexcept
        {
            ++g_objectCount;
        }

        void ReleaseObjectRef() noexcept
        {
            --g_objectCount;
        }

        HRESULT WaitForOwnedMutex(HANDLE mutex) noexcept
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

        uint32_t ClampToByte(int value) noexcept
        {
            return static_cast<uint32_t>(std::clamp(value, 0, 255));
        }

        uint8_t ToLuma(uint8_t red, uint8_t green, uint8_t blue) noexcept
        {
            const int value = ((66 * red) + (129 * green) + (25 * blue) + 128) >> 8;
            return static_cast<uint8_t>(ClampToByte(value + 16));
        }

        uint8_t ToChromaU(uint8_t red, uint8_t green, uint8_t blue) noexcept
        {
            const int value = ((-38 * red) - (74 * green) + (112 * blue) + 128) >> 8;
            return static_cast<uint8_t>(ClampToByte(value + 128));
        }

        uint8_t ToChromaV(uint8_t red, uint8_t green, uint8_t blue) noexcept
        {
            const int value = ((112 * red) - (94 * green) - (18 * blue) + 128) >> 8;
            return static_cast<uint8_t>(ClampToByte(value + 128));
        }

        HRESULT CreateVideoType(const GUID& subtype, const MediaConfig& config, IMFMediaType** mediaType)
        {
            if (mediaType == nullptr)
            {
                return E_POINTER;
            }

            if (subtype != MFVideoFormat_YUY2)
            {
                return MF_E_INVALIDMEDIATYPE;
            }

            *mediaType = nullptr;

            ComPtr<IMFMediaType> value;
            RETURN_IF_FAILED(MFCreateMediaType(&value));
            RETURN_IF_FAILED(value->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
            RETURN_IF_FAILED(value->SetGUID(MF_MT_SUBTYPE, subtype));
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE));
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE));
            RETURN_IF_FAILED(MFSetAttributeSize(value.Get(), MF_MT_FRAME_SIZE, config.width, config.height));
            RETURN_IF_FAILED(MFSetAttributeRatio(value.Get(), MF_MT_FRAME_RATE, config.fpsNumerator, config.fpsDenominator));
            RETURN_IF_FAILED(MFSetAttributeRatio(value.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));

            const uint32_t sampleSize = config.width * config.height * 2;
            RETURN_IF_FAILED(value->SetUINT32(MF_MT_DEFAULT_STRIDE, config.width * 2));

            RETURN_IF_FAILED(value->SetUINT32(MF_MT_SAMPLE_SIZE, sampleSize));

            *mediaType = value.Detach();
            return S_OK;
        }

        bool IsSupportedStartPosition(const PROPVARIANT* startPosition) noexcept
        {
            if (startPosition == nullptr)
            {
                return false;
            }

            if (startPosition->vt == VT_EMPTY)
            {
                return true;
            }

            return startPosition->vt == VT_I8 && startPosition->hVal.QuadPart == 0;
        }

        void FillSyntheticBgra(const MediaConfig& config, uint64_t frameIndex, std::vector<uint8_t>* bgra)
        {
            const size_t payloadSize = static_cast<size_t>(config.stride) * config.height;
            bgra->resize(payloadSize);

            for (uint32_t y = 0; y < config.height; ++y)
            {
                uint8_t* row = bgra->data() + (static_cast<size_t>(y) * config.stride);
                for (uint32_t x = 0; x < config.width; ++x)
                {
                    const uint8_t phase = static_cast<uint8_t>((frameIndex * 3) & 0xff);
                    row[(x * 4) + 0] = static_cast<uint8_t>((x + phase) & 0xff);
                    row[(x * 4) + 1] = static_cast<uint8_t>((y + phase) & 0xff);
                    row[(x * 4) + 2] = static_cast<uint8_t>(((x / 2) + (y / 3) + phase) & 0xff);
                    row[(x * 4) + 3] = 0xff;
                }
            }
        }

        void ConvertBgraToYuy2(const MediaConfig& config, const uint8_t* bgra, std::vector<uint8_t>* yuy2)
        {
            const uint32_t outputStride = config.width * 2;
            yuy2->resize(static_cast<size_t>(outputStride) * config.height);

            for (uint32_t y = 0; y < config.height; ++y)
            {
                const uint8_t* srcRow = bgra + (static_cast<size_t>(y) * config.stride);
                uint8_t* dstRow = yuy2->data() + (static_cast<size_t>(y) * outputStride);

                for (uint32_t x = 0; x < config.width; x += 2)
                {
                    const uint8_t* pixel0 = srcRow + (x * 4);
                    const uint8_t* pixel1 = srcRow + (std::min(x + 1, config.width - 1) * 4);

                    const uint8_t blue0 = pixel0[0];
                    const uint8_t green0 = pixel0[1];
                    const uint8_t red0 = pixel0[2];

                    const uint8_t blue1 = pixel1[0];
                    const uint8_t green1 = pixel1[1];
                    const uint8_t red1 = pixel1[2];

                    const uint8_t y0 = ToLuma(red0, green0, blue0);
                    const uint8_t y1 = ToLuma(red1, green1, blue1);
                    const uint8_t u0 = ToChromaU(red0, green0, blue0);
                    const uint8_t u1 = ToChromaU(red1, green1, blue1);
                    const uint8_t v0 = ToChromaV(red0, green0, blue0);
                    const uint8_t v1 = ToChromaV(red1, green1, blue1);

                    const size_t outIndex = static_cast<size_t>(x) * 2;
                    dstRow[outIndex + 0] = y0;
                    dstRow[outIndex + 1] = static_cast<uint8_t>((static_cast<uint16_t>(u0) + u1) / 2);
                    dstRow[outIndex + 2] = y1;
                    dstRow[outIndex + 3] = static_cast<uint8_t>((static_cast<uint16_t>(v0) + v1) / 2);
                }
            }
        }

        void ApplyYuy2Heartbeat(uint8_t* yuy2Bytes, size_t byteCount, uint64_t frameIndex) noexcept
        {
            if (yuy2Bytes == nullptr || byteCount < 4)
            {
                return;
            }

            const uint8_t pulse = static_cast<uint8_t>(frameIndex & 0x01ULL);
            const size_t tailOffset = byteCount >= 8 ? byteCount - 8 : 0;

            yuy2Bytes[0] = static_cast<uint8_t>((yuy2Bytes[0] & 0xfeU) | pulse);
            yuy2Bytes[2] = static_cast<uint8_t>((yuy2Bytes[2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
            yuy2Bytes[tailOffset + 0] = static_cast<uint8_t>((yuy2Bytes[tailOffset + 0] & 0xfeU) | pulse);
            yuy2Bytes[tailOffset + 2] = static_cast<uint8_t>((yuy2Bytes[tailOffset + 2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
        }

        class SharedFrameReader
        {
        public:
            SharedFrameReader() = default;

            ~SharedFrameReader()
            {
                Close();
            }

            void SetDefaultConfig(const MediaConfig& config)
            {
                std::lock_guard<std::mutex> guard(lock_);
                defaultConfig_ = config;
            }

            HRESULT GetConfig(MediaConfig* config)
            {
                if (config == nullptr)
                {
                    return E_POINTER;
                }

                std::lock_guard<std::mutex> guard(lock_);
                RETURN_IF_FAILED(EnsureOpen());
                return ReadConfigLocked(config);
            }

            HRESULT ReadFrame(std::vector<uint8_t>* bgra, MediaConfig* config, int64_t* timestampHundredsOfNs, uint64_t* frameCounter)
            {
                if (bgra == nullptr || config == nullptr || timestampHundredsOfNs == nullptr || frameCounter == nullptr)
                {
                    return E_POINTER;
                }

                std::lock_guard<std::mutex> guard(lock_);
                RETURN_IF_FAILED(EnsureOpen());

                RETURN_IF_FAILED(WaitForOwnedMutex(mutex_));

                auto unlock = [&]() noexcept
                {
                    if (mutex_ != nullptr)
                    {
                        ReleaseMutex(mutex_);
                    }
                };

                auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    unlock();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                if (header->frameCounter == 0 || header->payloadBytes == 0)
                {
                    *frameCounter = 0;
                    *timestampHundredsOfNs = 0;
                    unlock();
                    return S_FALSE;
                }

                config->width = header->width;
                config->height = header->height;
                config->stride = header->stride;
                config->fpsNumerator = header->fpsNumerator == 0 ? kDefaultFpsNumerator : header->fpsNumerator;
                config->fpsDenominator = header->fpsDenominator == 0 ? kDefaultFpsDenominator : header->fpsDenominator;

                const uint8_t* payload = reinterpret_cast<const uint8_t*>(header + 1);
                bgra->resize(header->payloadBytes);
                std::memcpy(bgra->data(), payload, header->payloadBytes);
                *timestampHundredsOfNs = header->timestampHundredsOfNs;
                *frameCounter = header->frameCounter;

                unlock();
                return S_OK;
            }

            void Close() noexcept
            {
                std::lock_guard<std::mutex> guard(lock_);

                if (view_ != nullptr)
                {
                    UnmapViewOfFile(view_);
                    view_ = nullptr;
                }

                if (mapping_ != nullptr)
                {
                    CloseHandle(mapping_);
                    mapping_ = nullptr;
                }

                if (mutex_ != nullptr)
                {
                    CloseHandle(mutex_);
                    mutex_ = nullptr;
                }

                if (event_ != nullptr)
                {
                    CloseHandle(event_);
                    event_ = nullptr;
                }
            }

        private:
            HRESULT EnsureOpen()
            {
                if (mapping_ != nullptr && mutex_ != nullptr && view_ != nullptr)
                {
                    return S_OK;
                }

                HRESULT globalHr = EnsureOpenWithNamespace(
                    kGlobalPublisherMappingName,
                    kGlobalPublisherMutexName,
                    kGlobalPublisherEventName);
                if (SUCCEEDED(globalHr))
                {
                    return S_OK;
                }

                Close();

                RETURN_IF_FAILED(EnsureOpenWithNamespace(
                    kPublisherMappingName,
                    kPublisherMutexName,
                    kPublisherEventName));

                return S_OK;
            }

            HRESULT EnsureOpenWithNamespace(
                const wchar_t* mappingName,
                const wchar_t* mutexName,
                const wchar_t* eventName)
            {
                SecurityDescriptorHolder securityDescriptor;
                SECURITY_ATTRIBUTES securityAttributes{};
                RETURN_IF_FAILED(BuildBridgeSecurityAttributes(&securityAttributes, &securityDescriptor));

                if (mutex_ == nullptr)
                {
                    mutex_ = CreateMutexW(&securityAttributes, FALSE, mutexName);
                    if (mutex_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }
                }

                bool createdMapping = false;
                if (mapping_ == nullptr)
                {
                    const uint32_t width = defaultConfig_.width == 0 ? kDefaultWidth : defaultConfig_.width;
                    const uint32_t height = defaultConfig_.height == 0 ? kDefaultHeight : defaultConfig_.height;
                    const uint32_t stride = defaultConfig_.stride == 0 ? (width * 4) : defaultConfig_.stride;
                    const size_t mappingByteCount = sizeof(SharedFrameHeader) + (static_cast<size_t>(stride) * height);

                    ULARGE_INTEGER mappingSize{};
                    mappingSize.QuadPart = static_cast<unsigned long long>(mappingByteCount);
                    mapping_ = CreateFileMappingW(
                        INVALID_HANDLE_VALUE,
                        &securityAttributes,
                        PAGE_READWRITE,
                        mappingSize.HighPart,
                        mappingSize.LowPart,
                        mappingName);
                    if (mapping_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }

                    createdMapping = GetLastError() != ERROR_ALREADY_EXISTS;
                }

                if (event_ == nullptr)
                {
                    event_ = CreateEventW(&securityAttributes, FALSE, FALSE, eventName);
                    if (event_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }
                }

                if (view_ == nullptr)
                {
                    view_ = MapViewOfFile(mapping_, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, 0);
                    if (view_ == nullptr)
                    {
                        return HRESULT_FROM_WIN32(GetLastError());
                    }
                }

                auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (createdMapping
                    || header == nullptr
                    || header->magic != kProtocolMagic
                    || header->version != kProtocolVersion)
                {
                    RETURN_IF_FAILED(InitializeSharedState());
                }

                return S_OK;
            }

            HRESULT ReadConfigLocked(MediaConfig* config)
            {
                RETURN_IF_FAILED(WaitForOwnedMutex(mutex_));

                auto unlock = [&]() noexcept
                {
                    if (mutex_ != nullptr)
                    {
                        ReleaseMutex(mutex_);
                    }
                };

                auto* header = static_cast<const SharedFrameHeader*>(view_);
                if (header == nullptr || header->magic != kProtocolMagic || header->version != kProtocolVersion)
                {
                    unlock();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
                }

                config->width = header->width == 0 ? kDefaultWidth : header->width;
                config->height = header->height == 0 ? kDefaultHeight : header->height;
                config->stride = header->stride == 0 ? (config->width * 4) : header->stride;
                config->fpsNumerator = header->fpsNumerator == 0 ? kDefaultFpsNumerator : header->fpsNumerator;
                config->fpsDenominator = header->fpsDenominator == 0 ? kDefaultFpsDenominator : header->fpsDenominator;
                unlock();
                return S_OK;
            }

            HRESULT InitializeSharedState()
            {
                RETURN_IF_FAILED(WaitForOwnedMutex(mutex_));

                auto unlock = [&]() noexcept
                {
                    if (mutex_ != nullptr)
                    {
                        ReleaseMutex(mutex_);
                    }
                };

                const uint32_t width = defaultConfig_.width == 0 ? kDefaultWidth : defaultConfig_.width;
                const uint32_t height = defaultConfig_.height == 0 ? kDefaultHeight : defaultConfig_.height;
                const uint32_t stride = defaultConfig_.stride == 0 ? (width * 4) : defaultConfig_.stride;
                const uint32_t fpsNumerator = defaultConfig_.fpsNumerator == 0 ? kDefaultFpsNumerator : defaultConfig_.fpsNumerator;
                const uint32_t fpsDenominator = defaultConfig_.fpsDenominator == 0 ? kDefaultFpsDenominator : defaultConfig_.fpsDenominator;

                auto* header = static_cast<SharedFrameHeader*>(view_);
                if (header == nullptr)
                {
                    unlock();
                    return HRESULT_FROM_WIN32(ERROR_INVALID_ADDRESS);
                }

                const size_t payloadBytes = static_cast<size_t>(stride) * height;
                std::memset(header, 0, sizeof(SharedFrameHeader) + payloadBytes);
                header->magic = kProtocolMagic;
                header->version = kProtocolVersion;
                header->width = width;
                header->height = height;
                header->stride = stride;
                header->pixelFormat = kPixelFormatBgra32;
                header->fpsNumerator = fpsNumerator;
                header->fpsDenominator = fpsDenominator;
                header->payloadBytes = static_cast<uint32_t>(payloadBytes);

                unlock();
                return S_OK;
            }

            std::mutex lock_;
            HANDLE mapping_ = nullptr;
            HANDLE mutex_ = nullptr;
            HANDLE event_ = nullptr;
            void* view_ = nullptr;
            MediaConfig defaultConfig_{};
        };

        class MorphlyMediaSource;

        class MorphlyMediaStream final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFMediaStream2>
        {
        public:
            MorphlyMediaStream()
            {
                AddObjectRef();
            }

            ~MorphlyMediaStream() override
            {
                ReleaseObjectRef();
            }

            HRESULT Initialize(MorphlyMediaSource* parent, const MediaConfig& config);
            HRESULT Start(IMFMediaType* mediaType, bool sendEvents);
            HRESULT Stop(bool sendEvents);
            HRESULT ShutdownStream();
            bool IsSelected() const noexcept;
            DWORD StreamIdentifier() const noexcept;
            HRESULT CopyAttributes(IMFAttributes** attributes);

            IFACEMETHODIMP QueryInterface(REFIID interfaceId, void** object) override;
            IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
            IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value) override;
            IFACEMETHODIMP GetMediaSource(IMFMediaSource** mediaSource) override;
            IFACEMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** streamDescriptor) override;
            IFACEMETHODIMP RequestSample(IUnknown* token) override;
            IFACEMETHODIMP SetStreamState(MF_STREAM_STATE value) override;
            IFACEMETHODIMP GetStreamState(MF_STREAM_STATE* value) override;

        private:
            HRESULT CreateNextSample(IMFMediaType* mediaType, IMFSample** sample);

            mutable std::mutex lock_;
            MorphlyMediaSource* parent_ = nullptr;
            ComPtr<IMFMediaEventQueue> eventQueue_;
            ComPtr<IMFAttributes> attributes_;
            ComPtr<IMFStreamDescriptor> streamDescriptor_;
            ComPtr<IMFMediaType> currentMediaType_;
            MediaConfig mediaConfig_{};
            SharedFrameReader frameReader_;
            std::vector<uint8_t> cachedBgraFrame_;
            bool isShutdown_ = false;
            bool isSelected_ = false;
            bool hasCachedFrame_ = false;
            MF_STREAM_STATE streamState_ = MF_STREAM_STATE_STOPPED;
            uint64_t sampleFrameIndex_ = 0;
            uint64_t syntheticFrameIndex_ = 0;
        };

        class MorphlyMediaSource final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFMediaSourceEx, IMFGetService, IKsControl, IMFSampleAllocatorControl>
        {
        public:
            MorphlyMediaSource()
            {
                AddObjectRef();
            }

            ~MorphlyMediaSource() override
            {
                ReleaseObjectRef();
            }

            HRESULT Initialize(IMFAttributes* activateAttributes = nullptr);

            IFACEMETHODIMP QueryInterface(REFIID interfaceId, void** object) override;
            IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
            IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** eventValue) override;
            IFACEMETHODIMP QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value) override;
            IFACEMETHODIMP GetCharacteristics(DWORD* characteristics) override;
            IFACEMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** presentationDescriptor) override;
            IFACEMETHODIMP Start(IMFPresentationDescriptor* presentationDescriptor, const GUID* timeFormat, const PROPVARIANT* startPosition) override;
            IFACEMETHODIMP Stop() override;
            IFACEMETHODIMP Pause() override;
            IFACEMETHODIMP Shutdown() override;
            IFACEMETHODIMP GetSourceAttributes(IMFAttributes** attributes) override;
            IFACEMETHODIMP GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes) override;
            IFACEMETHODIMP SetD3DManager(IUnknown* manager) override;
            IFACEMETHODIMP GetService(REFGUID serviceGuid, REFIID interfaceId, void** object) override;
            IFACEMETHODIMP KsProperty(PKSPROPERTY property, ULONG propertyLength, void* propertyData, ULONG dataLength, ULONG* bytesReturned) override;
            IFACEMETHODIMP KsMethod(PKSMETHOD method, ULONG methodLength, void* methodData, ULONG dataLength, ULONG* bytesReturned) override;
            IFACEMETHODIMP KsEvent(PKSEVENT eventValue, ULONG eventLength, void* eventData, ULONG dataLength, ULONG* bytesReturned) override;
            IFACEMETHODIMP SetDefaultAllocator(DWORD outputStreamId, IUnknown* allocator) override;
            IFACEMETHODIMP GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId, MFSampleAllocatorUsage* usage) override;

        private:
            mutable std::mutex lock_;
            bool initialized_ = false;
            SourceState state_ = SourceState::Invalid;
            MediaConfig mediaConfig_{};
            ComPtr<IMFMediaEventQueue> eventQueue_;
            ComPtr<IMFAttributes> sourceAttributes_;
            ComPtr<IMFPresentationDescriptor> presentationDescriptor_;
            ComPtr<MorphlyMediaStream> stream_;

            HRESULT CreateSourceAttributes(IMFAttributes* activateAttributes);
        };

        class MorphlyMediaSourceActivate final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IMFActivate>
        {
        public:
            MorphlyMediaSourceActivate()
            {
                AddObjectRef();
            }

            ~MorphlyMediaSourceActivate() override
            {
                ReleaseObjectRef();
            }

            HRESULT Initialize()
            {
                return MFCreateAttributes(&attributes_, 4);
            }

            IFACEMETHODIMP QueryInterface(REFIID interfaceId, void** object) override;

            IFACEMETHODIMP ActivateObject(REFIID interfaceId, void** object) override;
            IFACEMETHODIMP ShutdownObject() override;
            IFACEMETHODIMP DetachObject() override;

            IFACEMETHODIMP GetItem(REFGUID key, PROPVARIANT* value) override;
            IFACEMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override;
            IFACEMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result) override;
            IFACEMETHODIMP Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result) override;
            IFACEMETHODIMP GetUINT32(REFGUID key, UINT32* value) override;
            IFACEMETHODIMP GetUINT64(REFGUID key, UINT64* value) override;
            IFACEMETHODIMP GetDouble(REFGUID key, double* value) override;
            IFACEMETHODIMP GetGUID(REFGUID key, GUID* value) override;
            IFACEMETHODIMP GetStringLength(REFGUID key, UINT32* length) override;
            IFACEMETHODIMP GetString(REFGUID key, LPWSTR value, UINT32 valueSize, UINT32* length) override;
            IFACEMETHODIMP GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length) override;
            IFACEMETHODIMP GetBlobSize(REFGUID key, UINT32* size) override;
            IFACEMETHODIMP GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize, UINT32* size) override;
            IFACEMETHODIMP GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) override;
            IFACEMETHODIMP GetUnknown(REFGUID key, REFIID interfaceId, void** object) override;
            IFACEMETHODIMP SetItem(REFGUID key, REFPROPVARIANT value) override;
            IFACEMETHODIMP DeleteItem(REFGUID key) override;
            IFACEMETHODIMP DeleteAllItems() override;
            IFACEMETHODIMP SetUINT32(REFGUID key, UINT32 value) override;
            IFACEMETHODIMP SetUINT64(REFGUID key, UINT64 value) override;
            IFACEMETHODIMP SetDouble(REFGUID key, double value) override;
            IFACEMETHODIMP SetGUID(REFGUID key, REFGUID value) override;
            IFACEMETHODIMP SetString(REFGUID key, LPCWSTR value) override;
            IFACEMETHODIMP SetBlob(REFGUID key, const UINT8* buffer, UINT32 bufferSize) override;
            IFACEMETHODIMP SetUnknown(REFGUID key, IUnknown* value) override;
            IFACEMETHODIMP LockStore() override;
            IFACEMETHODIMP UnlockStore() override;
            IFACEMETHODIMP GetCount(UINT32* items) override;
            IFACEMETHODIMP GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value) override;
            IFACEMETHODIMP CopyAllItems(IMFAttributes* destination) override;

        private:
            ComPtr<IMFAttributes> attributes_;
            ComPtr<MorphlyMediaSource> activeSource_;
        };

        class MorphlyClassFactory final : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IClassFactory>
        {
        public:
            MorphlyClassFactory()
            {
                AddObjectRef();
            }

            ~MorphlyClassFactory() override
            {
                ReleaseObjectRef();
            }

            IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID interfaceId, void** object) override
            {
                if (object == nullptr)
                {
                    return E_POINTER;
                }

                *object = nullptr;

                if (outer != nullptr)
                {
                    return CLASS_E_NOAGGREGATION;
                }

                auto activate = Make<MorphlyMediaSourceActivate>();
                if (!activate)
                {
                    return E_OUTOFMEMORY;
                }

                RETURN_IF_FAILED(activate->Initialize());
                return activate.CopyTo(interfaceId, object);
            }

            IFACEMETHODIMP LockServer(BOOL lock) override
            {
                if (lock)
                {
                    ++g_lockCount;
                }
                else
                {
                    --g_lockCount;
                }

                return S_OK;
            }
        };

        HRESULT MorphlyMediaStream::Initialize(MorphlyMediaSource* parent, const MediaConfig& config)
        {
            if (parent == nullptr)
            {
                return E_INVALIDARG;
            }

            std::lock_guard<std::mutex> guard(lock_);

            parent_ = parent;
            mediaConfig_ = config;
            frameReader_.SetDefaultConfig(mediaConfig_);

            RETURN_IF_FAILED(MFCreateEventQueue(&eventQueue_));
            RETURN_IF_FAILED(MFCreateAttributes(&attributes_, 4));
            RETURN_IF_FAILED(attributes_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
            RETURN_IF_FAILED(attributes_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, kStreamId));
            RETURN_IF_FAILED(attributes_->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
            RETURN_IF_FAILED(attributes_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, static_cast<UINT32>(MFFrameSourceTypes::MFFrameSourceTypes_Color)));

            ComPtr<IMFMediaType> mediaTypes[1];
            RETURN_IF_FAILED(CreateVideoType(MFVideoFormat_YUY2, mediaConfig_, &mediaTypes[0]));
            IMFMediaType* mediaTypePointers[] = { mediaTypes[0].Get() };
            RETURN_IF_FAILED(MFCreateStreamDescriptor(kStreamId, ARRAYSIZE(mediaTypePointers), mediaTypePointers, &streamDescriptor_));
            RETURN_IF_FAILED(attributes_->CopyAllItems(streamDescriptor_.Get()));

            ComPtr<IMFMediaTypeHandler> handler;
            RETURN_IF_FAILED(streamDescriptor_->GetMediaTypeHandler(&handler));
            RETURN_IF_FAILED(handler->SetCurrentMediaType(mediaTypes[0].Get()));
            currentMediaType_ = mediaTypes[0];

            streamState_ = MF_STREAM_STATE_STOPPED;
            isSelected_ = false;

            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaStream::QueryInterface(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IUnknown) ||
                interfaceId == __uuidof(IMFMediaEventGenerator) ||
                interfaceId == __uuidof(IMFMediaStream))
            {
                *object = static_cast<IMFMediaStream*>(static_cast<IMFMediaStream2*>(this));
            }
            else if (interfaceId == __uuidof(IMFMediaStream2))
            {
                *object = static_cast<IMFMediaStream2*>(this);
            }
            else
            {
                return E_NOINTERFACE;
            }

            AddRef();
            return S_OK;
        }

        HRESULT MorphlyMediaStream::Start(IMFMediaType* mediaType, bool sendEvents)
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            if (mediaType == nullptr)
            {
                return E_INVALIDARG;
            }

            ComPtr<IMFMediaTypeHandler> handler;
            RETURN_IF_FAILED(streamDescriptor_->GetMediaTypeHandler(&handler));
            RETURN_IF_FAILED(handler->SetCurrentMediaType(mediaType));
            currentMediaType_ = mediaType;
            streamState_ = MF_STREAM_STATE_RUNNING;
            isSelected_ = true;

            if (sendEvents)
            {
                RETURN_IF_FAILED(eventQueue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr));
            }

            return S_OK;
        }

        HRESULT MorphlyMediaStream::Stop(bool sendEvents)
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            isSelected_ = false;
            streamState_ = MF_STREAM_STATE_STOPPED;

            if (sendEvents)
            {
                RETURN_IF_FAILED(eventQueue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr));
            }

            return S_OK;
        }

        HRESULT MorphlyMediaStream::ShutdownStream()
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (isShutdown_)
            {
                return S_OK;
            }

            isShutdown_ = true;
            if (eventQueue_)
            {
                eventQueue_->Shutdown();
                eventQueue_.Reset();
            }
            attributes_.Reset();
            currentMediaType_.Reset();
            streamDescriptor_.Reset();
            frameReader_.Close();
            parent_ = nullptr;
            return S_OK;
        }

        bool MorphlyMediaStream::IsSelected() const noexcept
        {
            std::lock_guard<std::mutex> guard(lock_);
            return isSelected_;
        }

        DWORD MorphlyMediaStream::StreamIdentifier() const noexcept
        {
            return kStreamId;
        }

        HRESULT MorphlyMediaStream::CopyAttributes(IMFAttributes** attributes)
        {
            if (attributes == nullptr)
            {
                return E_POINTER;
            }

            *attributes = nullptr;

            return attributes_.CopyTo(attributes);
        }

        IFACEMETHODIMP MorphlyMediaStream::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->BeginGetEvent(callback, state);
        }

        IFACEMETHODIMP MorphlyMediaStream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->EndGetEvent(result, eventValue);
        }

        IFACEMETHODIMP MorphlyMediaStream::GetEvent(DWORD flags, IMFMediaEvent** eventValue)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->GetEvent(flags, eventValue);
        }

        IFACEMETHODIMP MorphlyMediaStream::QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->QueueEventParamVar(eventType, extendedType, status, value);
        }

        IFACEMETHODIMP MorphlyMediaStream::GetMediaSource(IMFMediaSource** mediaSource)
        {
            if (mediaSource == nullptr)
            {
                return E_POINTER;
            }

            *mediaSource = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return parent_->QueryInterface(IID_PPV_ARGS(mediaSource));
        }

        IFACEMETHODIMP MorphlyMediaStream::GetStreamDescriptor(IMFStreamDescriptor** streamDescriptor)
        {
            if (streamDescriptor == nullptr)
            {
                return E_POINTER;
            }

            *streamDescriptor = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            return streamDescriptor_.CopyTo(streamDescriptor);
        }

        IFACEMETHODIMP MorphlyMediaStream::RequestSample(IUnknown* token)
        {
            ComPtr<IMFMediaEventQueue> eventQueue;
            ComPtr<IMFMediaType> mediaType;

            {
                std::lock_guard<std::mutex> guard(lock_);
                if (isShutdown_)
                {
                    return MF_E_SHUTDOWN;
                }

                if (!isSelected_ || streamState_ != MF_STREAM_STATE_RUNNING)
                {
                    return MF_E_INVALIDREQUEST;
                }

                eventQueue = eventQueue_;
                mediaType = currentMediaType_;
            }

            ComPtr<IMFSample> sample;
            RETURN_IF_FAILED(CreateNextSample(mediaType.Get(), &sample));

            if (token != nullptr)
            {
                RETURN_IF_FAILED(sample->SetUnknown(MFSampleExtension_Token, token));
            }

            return eventQueue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
        }

        IFACEMETHODIMP MorphlyMediaStream::SetStreamState(MF_STREAM_STATE value)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            streamState_ = value;
            isSelected_ = value == MF_STREAM_STATE_RUNNING;
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaStream::GetStreamState(MF_STREAM_STATE* value)
        {
            if (value == nullptr)
            {
                return E_POINTER;
            }

            std::lock_guard<std::mutex> guard(lock_);
            if (isShutdown_)
            {
                return MF_E_SHUTDOWN;
            }

            *value = streamState_;
            return S_OK;
        }

        HRESULT MorphlyMediaStream::CreateNextSample(IMFMediaType* mediaType, IMFSample** sample)
        {
            if (sample == nullptr || mediaType == nullptr)
            {
                return E_POINTER;
            }

            *sample = nullptr;

            MediaConfig currentConfig = mediaConfig_;
            ComPtr<IMFMediaBuffer> buffer;
            ComPtr<IMFSample> value;
            GUID subtype = GUID_NULL;
            uint32_t width = currentConfig.width;
            uint32_t height = currentConfig.height;
            uint32_t fpsNum = currentConfig.fpsNumerator;
            uint32_t fpsDen = currentConfig.fpsDenominator;

            RETURN_IF_FAILED(mediaType->GetGUID(MF_MT_SUBTYPE, &subtype));
            RETURN_IF_FAILED(MFGetAttributeSize(mediaType, MF_MT_FRAME_SIZE, &width, &height));
            RETURN_IF_FAILED(MFGetAttributeRatio(mediaType, MF_MT_FRAME_RATE, &fpsNum, &fpsDen));

            currentConfig.width = width;
            currentConfig.height = height;
            currentConfig.fpsNumerator = fpsNum;
            currentConfig.fpsDenominator = fpsDen;
            currentConfig.stride = width * 4;
            const size_t expectedBgraBytes = static_cast<size_t>(currentConfig.stride) * currentConfig.height;

            std::vector<uint8_t> bgra;
            MediaConfig sharedConfig{};
            int64_t timestampHundredsOfNs = 0;
            uint64_t frameCounter = 0;
            const HRESULT readHr = frameReader_.ReadFrame(&bgra, &sharedConfig, &timestampHundredsOfNs, &frameCounter);
            const bool hasFreshBridgeFrame =
                SUCCEEDED(readHr)
                && readHr != S_FALSE
                && sharedConfig.width == width
                && sharedConfig.height == height
                && sharedConfig.stride >= (width * 4);

            if (hasFreshBridgeFrame)
            {
                currentConfig.stride = sharedConfig.stride;
            }

            {
                std::lock_guard<std::mutex> guard(lock_);

                if (hasFreshBridgeFrame && bgra.size() >= expectedBgraBytes)
                {
                    cachedBgraFrame_ = bgra;
                    hasCachedFrame_ = true;
                }
                else if (hasCachedFrame_ && cachedBgraFrame_.size() >= expectedBgraBytes)
                {
                    bgra = cachedBgraFrame_;
                }
                else
                {
                    ++syntheticFrameIndex_;
                    frameCounter = syntheticFrameIndex_;
                    FillSyntheticBgra(currentConfig, frameCounter, &bgra);
                    cachedBgraFrame_ = bgra;
                    hasCachedFrame_ = true;
                }
            }

            if (subtype != MFVideoFormat_YUY2)
            {
                return MF_E_INVALIDMEDIATYPE;
            }

            std::vector<uint8_t> outputBytes;
            ConvertBgraToYuy2(currentConfig, bgra.data(), &outputBytes);
            ApplyYuy2Heartbeat(outputBytes.data(), outputBytes.size(), sampleFrameIndex_);

            RETURN_IF_FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(outputBytes.size()), &buffer));

            BYTE* destination = nullptr;
            DWORD maxLength = 0;
            RETURN_IF_FAILED(buffer->Lock(&destination, nullptr, &maxLength));
            std::memcpy(destination, outputBytes.data(), outputBytes.size());
            RETURN_IF_FAILED(buffer->SetCurrentLength(static_cast<DWORD>(outputBytes.size())));
            RETURN_IF_FAILED(buffer->Unlock());

            RETURN_IF_FAILED(MFCreateSample(&value));
            RETURN_IF_FAILED(value->AddBuffer(buffer.Get()));

            const LONGLONG duration = (kHundredsOfNsPerSecond * fpsDen) / fpsNum;
            const LONGLONG sampleTime = static_cast<LONGLONG>(sampleFrameIndex_) * duration;
            ++sampleFrameIndex_;
            RETURN_IF_FAILED(value->SetSampleTime(sampleTime));
            RETURN_IF_FAILED(value->SetSampleDuration(duration));

            *sample = value.Detach();
            return S_OK;
        }

        HRESULT MorphlyMediaSource::Initialize(IMFAttributes* activateAttributes)
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (initialized_)
            {
                return MF_E_ALREADY_INITIALIZED;
            }

            SharedFrameReader reader;
            MediaConfig detected{};
            if (SUCCEEDED(reader.GetConfig(&detected)))
            {
                mediaConfig_ = detected;
            }

            RETURN_IF_FAILED(MFCreateEventQueue(&eventQueue_));
            RETURN_IF_FAILED(CreateSourceAttributes(activateAttributes));

            stream_ = Make<MorphlyMediaStream>();
            if (!stream_)
            {
                return E_OUTOFMEMORY;
            }

            RETURN_IF_FAILED(stream_->Initialize(this, mediaConfig_));

            ComPtr<IMFStreamDescriptor> streamDescriptor;
            RETURN_IF_FAILED(stream_->GetStreamDescriptor(&streamDescriptor));
            IMFStreamDescriptor* descriptors[] = { streamDescriptor.Get() };
            RETURN_IF_FAILED(MFCreatePresentationDescriptor(ARRAYSIZE(descriptors), descriptors, &presentationDescriptor_));
            RETURN_IF_FAILED(presentationDescriptor_->SelectStream(0));

            state_ = SourceState::Stopped;
            initialized_ = true;
            return S_OK;
        }

        HRESULT MorphlyMediaSource::CreateSourceAttributes(IMFAttributes* activateAttributes)
        {
            RETURN_IF_FAILED(MFCreateAttributes(&sourceAttributes_, 4));
            if (activateAttributes != nullptr)
            {
                RETURN_IF_FAILED(activateAttributes->CopyAllItems(sourceAttributes_.Get()));
            }

            RETURN_IF_FAILED(sourceAttributes_->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID));
            RETURN_IF_FAILED(sourceAttributes_->SetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, kVirtualCameraFriendlyName));

            ComPtr<IMFSensorProfileCollection> profileCollection;
            ComPtr<IMFSensorProfile> profile;
            RETURN_IF_FAILED(MFCreateSensorProfileCollection(&profileCollection));
            RETURN_IF_FAILED(MFCreateSensorProfile(KSCAMERAPROFILE_Legacy, 0, nullptr, &profile));
            RETURN_IF_FAILED(profile->AddProfileFilter(kStreamId, L"((RES==;FRT<=30,1;SUT==))"));
            RETURN_IF_FAILED(profileCollection->AddProfile(profile.Get()));
            RETURN_IF_FAILED(sourceAttributes_->SetUnknown(MF_DEVICEMFT_SENSORPROFILE_COLLECTION, profileCollection.Get()));

            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSource::QueryInterface(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IUnknown) ||
                interfaceId == __uuidof(IMFMediaEventGenerator) ||
                interfaceId == __uuidof(IMFMediaSource))
            {
                *object = static_cast<IMFMediaSource*>(static_cast<IMFMediaSourceEx*>(this));
            }
            else if (interfaceId == __uuidof(IMFMediaSourceEx))
            {
                *object = static_cast<IMFMediaSourceEx*>(this);
            }
            else if (interfaceId == __uuidof(IMFGetService))
            {
                *object = static_cast<IMFGetService*>(this);
            }
            else if (interfaceId == __uuidof(IKsControl))
            {
                *object = static_cast<IKsControl*>(this);
            }
            else if (interfaceId == __uuidof(IMFSampleAllocatorControl))
            {
                *object = static_cast<IMFSampleAllocatorControl*>(this);
            }
            else
            {
                return E_NOINTERFACE;
            }

            AddRef();
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::QueryInterface(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IUnknown) || interfaceId == __uuidof(IMFActivate))
            {
                *object = static_cast<IMFActivate*>(this);
            }
            else if (interfaceId == __uuidof(IMFAttributes))
            {
                *object = static_cast<IMFAttributes*>(this);
            }
            else
            {
                return E_NOINTERFACE;
            }

            AddRef();
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::ActivateObject(REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            auto source = Make<MorphlyMediaSource>();
            if (!source)
            {
                return E_OUTOFMEMORY;
            }

            RETURN_IF_FAILED(source->Initialize(attributes_.Get()));
            activeSource_ = source;
            return source->QueryInterface(interfaceId, object);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::ShutdownObject()
        {
            if (activeSource_)
            {
                activeSource_->Shutdown();
                activeSource_.Reset();
            }

            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::DetachObject()
        {
            activeSource_.Reset();
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetItem(REFGUID key, PROPVARIANT* value)
        {
            return attributes_->GetItem(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type)
        {
            return attributes_->GetItemType(key, type);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result)
        {
            return attributes_->CompareItem(key, value, result);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result)
        {
            return attributes_->Compare(theirs, matchType, result);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetUINT32(REFGUID key, UINT32* value)
        {
            return attributes_->GetUINT32(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetUINT64(REFGUID key, UINT64* value)
        {
            return attributes_->GetUINT64(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetDouble(REFGUID key, double* value)
        {
            return attributes_->GetDouble(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetGUID(REFGUID key, GUID* value)
        {
            return attributes_->GetGUID(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetStringLength(REFGUID key, UINT32* length)
        {
            return attributes_->GetStringLength(key, length);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetString(REFGUID key, LPWSTR value, UINT32 valueSize, UINT32* length)
        {
            return attributes_->GetString(key, value, valueSize, length);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length)
        {
            return attributes_->GetAllocatedString(key, value, length);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetBlobSize(REFGUID key, UINT32* size)
        {
            return attributes_->GetBlobSize(key, size);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize, UINT32* size)
        {
            return attributes_->GetBlob(key, buffer, bufferSize, size);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size)
        {
            return attributes_->GetAllocatedBlob(key, buffer, size);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetUnknown(REFGUID key, REFIID interfaceId, void** object)
        {
            return attributes_->GetUnknown(key, interfaceId, object);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetItem(REFGUID key, REFPROPVARIANT value)
        {
            return attributes_->SetItem(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::DeleteItem(REFGUID key)
        {
            return attributes_->DeleteItem(key);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::DeleteAllItems()
        {
            return attributes_->DeleteAllItems();
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetUINT32(REFGUID key, UINT32 value)
        {
            return attributes_->SetUINT32(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetUINT64(REFGUID key, UINT64 value)
        {
            return attributes_->SetUINT64(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetDouble(REFGUID key, double value)
        {
            return attributes_->SetDouble(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetGUID(REFGUID key, REFGUID value)
        {
            return attributes_->SetGUID(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetString(REFGUID key, LPCWSTR value)
        {
            return attributes_->SetString(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetBlob(REFGUID key, const UINT8* buffer, UINT32 bufferSize)
        {
            return attributes_->SetBlob(key, buffer, bufferSize);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::SetUnknown(REFGUID key, IUnknown* value)
        {
            return attributes_->SetUnknown(key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::LockStore()
        {
            return attributes_->LockStore();
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::UnlockStore()
        {
            return attributes_->UnlockStore();
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetCount(UINT32* items)
        {
            return attributes_->GetCount(items);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value)
        {
            return attributes_->GetItemByIndex(index, key, value);
        }

        IFACEMETHODIMP MorphlyMediaSourceActivate::CopyAllItems(IMFAttributes* destination)
        {
            return attributes_->CopyAllItems(destination);
        }

        IFACEMETHODIMP MorphlyMediaSource::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->BeginGetEvent(callback, state);
        }

        IFACEMETHODIMP MorphlyMediaSource::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** eventValue)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->EndGetEvent(result, eventValue);
        }

        IFACEMETHODIMP MorphlyMediaSource::GetEvent(DWORD flags, IMFMediaEvent** eventValue)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->GetEvent(flags, eventValue);
        }

        IFACEMETHODIMP MorphlyMediaSource::QueueEvent(MediaEventType eventType, REFGUID extendedType, HRESULT status, const PROPVARIANT* value)
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return eventQueue_->QueueEventParamVar(eventType, extendedType, status, value);
        }

        IFACEMETHODIMP MorphlyMediaSource::GetCharacteristics(DWORD* characteristics)
        {
            if (characteristics == nullptr)
            {
                return E_POINTER;
            }

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            *characteristics = MFMEDIASOURCE_IS_LIVE;
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSource::CreatePresentationDescriptor(IMFPresentationDescriptor** presentationDescriptor)
        {
            if (presentationDescriptor == nullptr)
            {
                return E_POINTER;
            }

            *presentationDescriptor = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return presentationDescriptor_->Clone(presentationDescriptor);
        }

        IFACEMETHODIMP MorphlyMediaSource::Start(IMFPresentationDescriptor* presentationDescriptor, const GUID* timeFormat, const PROPVARIANT* startPosition)
        {
            if (presentationDescriptor == nullptr || startPosition == nullptr)
            {
                return E_INVALIDARG;
            }

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            if (state_ == SourceState::Started)
            {
                return MF_E_INVALID_STATE_TRANSITION;
            }

            if (timeFormat != nullptr && *timeFormat != GUID_NULL)
            {
                return MF_E_UNSUPPORTED_TIME_FORMAT;
            }

            if (!IsSupportedStartPosition(startPosition))
            {
                return MF_E_INVALIDREQUEST;
            }

            BOOL selected = FALSE;
            ComPtr<IMFStreamDescriptor> requestedStream;
            RETURN_IF_FAILED(presentationDescriptor->GetStreamDescriptorByIndex(0, &selected, &requestedStream));

            if (selected)
            {
                ComPtr<IMFMediaTypeHandler> mediaTypeHandler;
                ComPtr<IMFMediaType> mediaType;
                RETURN_IF_FAILED(requestedStream->GetMediaTypeHandler(&mediaTypeHandler));
                RETURN_IF_FAILED(mediaTypeHandler->GetCurrentMediaType(&mediaType));

                const bool wasSelected = stream_->IsSelected();
                RETURN_IF_FAILED(stream_->Start(mediaType.Get(), true));
                RETURN_IF_FAILED(presentationDescriptor_->SelectStream(0));
                RETURN_IF_FAILED(eventQueue_->QueueEventParamUnk(wasSelected ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK, stream_.Get()));
            }
            else
            {
                RETURN_IF_FAILED(stream_->Stop(false));
                RETURN_IF_FAILED(presentationDescriptor_->DeselectStream(0));
            }

            state_ = SourceState::Started;
            RETURN_IF_FAILED(eventQueue_->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, nullptr));
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSource::Stop()
        {
            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            if (state_ != SourceState::Started)
            {
                return S_OK;
            }

            RETURN_IF_FAILED(stream_->Stop(true));
            state_ = SourceState::Stopped;
            return eventQueue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
        }

        IFACEMETHODIMP MorphlyMediaSource::Pause()
        {
            return MF_E_INVALID_STATE_TRANSITION;
        }

        IFACEMETHODIMP MorphlyMediaSource::Shutdown()
        {
            std::lock_guard<std::mutex> guard(lock_);

            if (state_ == SourceState::Shutdown)
            {
                return S_OK;
            }

            state_ = SourceState::Shutdown;

            if (stream_)
            {
                stream_->ShutdownStream();
                stream_.Reset();
            }

            if (eventQueue_)
            {
                eventQueue_->Shutdown();
                eventQueue_.Reset();
            }

            presentationDescriptor_.Reset();
            sourceAttributes_.Reset();
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSource::GetSourceAttributes(IMFAttributes** attributes)
        {
            if (attributes == nullptr)
            {
                return E_POINTER;
            }

            *attributes = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            return sourceAttributes_.CopyTo(attributes);
        }

        IFACEMETHODIMP MorphlyMediaSource::GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes)
        {
            if (attributes == nullptr)
            {
                return E_POINTER;
            }

            *attributes = nullptr;

            std::lock_guard<std::mutex> guard(lock_);
            if (state_ == SourceState::Shutdown)
            {
                return MF_E_SHUTDOWN;
            }

            if (streamIdentifier != kStreamId)
            {
                return MF_E_INVALIDSTREAMNUMBER;
            }

            return stream_->CopyAttributes(attributes);
        }

        IFACEMETHODIMP MorphlyMediaSource::SetD3DManager(IUnknown* /*manager*/)
        {
            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSource::GetService(REFGUID /*serviceGuid*/, REFIID interfaceId, void** object)
        {
            if (object == nullptr)
            {
                return E_POINTER;
            }

            *object = nullptr;

            if (interfaceId == __uuidof(IKsControl))
            {
                return QueryInterface(interfaceId, object);
            }

            return MF_E_UNSUPPORTED_SERVICE;
        }

        IFACEMETHODIMP MorphlyMediaSource::KsProperty(PKSPROPERTY /*property*/, ULONG /*propertyLength*/, void* /*propertyData*/, ULONG /*dataLength*/, ULONG* bytesReturned)
        {
            if (bytesReturned != nullptr)
            {
                *bytesReturned = 0;
            }

            return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
        }

        IFACEMETHODIMP MorphlyMediaSource::KsMethod(PKSMETHOD /*method*/, ULONG /*methodLength*/, void* /*methodData*/, ULONG /*dataLength*/, ULONG* bytesReturned)
        {
            if (bytesReturned != nullptr)
            {
                *bytesReturned = 0;
            }

            return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
        }

        IFACEMETHODIMP MorphlyMediaSource::KsEvent(PKSEVENT /*eventValue*/, ULONG /*eventLength*/, void* /*eventData*/, ULONG /*dataLength*/, ULONG* bytesReturned)
        {
            if (bytesReturned != nullptr)
            {
                *bytesReturned = 0;
            }

            return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
        }

        IFACEMETHODIMP MorphlyMediaSource::SetDefaultAllocator(DWORD outputStreamId, IUnknown* /*allocator*/)
        {
            if (outputStreamId != kStreamId)
            {
                return MF_E_INVALIDSTREAMNUMBER;
            }

            return S_OK;
        }

        IFACEMETHODIMP MorphlyMediaSource::GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId, MFSampleAllocatorUsage* usage)
        {
            if (inputStreamId == nullptr || usage == nullptr)
            {
                return E_POINTER;
            }

            if (outputStreamId != kStreamId)
            {
                return MF_E_INVALIDSTREAMNUMBER;
            }

            *inputStreamId = kStreamId;
            *usage = MFSampleAllocatorUsage_UsesCustomAllocator;
            return S_OK;
        }
    }

    bool CanUnloadMfModule() noexcept
    {
        return g_objectCount.load() == 0 && g_lockCount.load() == 0;
    }

    HRESULT CreateMfClassFactory(REFCLSID classId, REFIID interfaceId, void** object) noexcept
    {
        if (object == nullptr)
        {
            return E_POINTER;
        }

        *object = nullptr;

        if (!IsEqualGUID(classId, kWindowsVirtualCameraSourceClsid))
        {
            return CLASS_E_CLASSNOTAVAILABLE;
        }

        auto factory = Make<MorphlyClassFactory>();
        if (!factory)
        {
            return E_OUTOFMEMORY;
        }

        return factory.CopyTo(interfaceId, object);
    }
}
