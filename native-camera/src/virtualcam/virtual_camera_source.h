#pragma once

#include <chrono>
#include <cstdint>
#include <vector>

#include <streams.h>

namespace morphly::virtualcam
{
    class MorphlyG1Stream;

    class MorphlyG1Filter final : public CSource, public IAMStreamConfig
    {
    public:
        static CUnknown* WINAPI CreateInstance(LPUNKNOWN outerUnknown, HRESULT* result);

        DECLARE_IUNKNOWN

        STDMETHODIMP NonDelegatingQueryInterface(REFIID interfaceId, void** object) override;

        HRESULT STDMETHODCALLTYPE SetFormat(AM_MEDIA_TYPE* mediaType) override;
        HRESULT STDMETHODCALLTYPE GetFormat(AM_MEDIA_TYPE** mediaType) override;
        HRESULT STDMETHODCALLTYPE GetNumberOfCapabilities(int* count, int* size) override;
        HRESULT STDMETHODCALLTYPE GetStreamCaps(int index, AM_MEDIA_TYPE** mediaType, BYTE* capabilities) override;

    private:
        explicit MorphlyG1Filter(LPUNKNOWN outerUnknown, HRESULT* result);
        ~MorphlyG1Filter() override;

        CCritSec configLock_;
        MorphlyG1Stream* stream_ = nullptr;
    };

    class MorphlyG1Stream final : public CSourceStream, public IKsPropertySet, public IAMStreamConfig
    {
    public:
        MorphlyG1Stream(HRESULT* result, MorphlyG1Filter* parentFilter, LPCWSTR pinName);
        ~MorphlyG1Stream() override;

        DECLARE_IUNKNOWN

        STDMETHODIMP NonDelegatingQueryInterface(REFIID interfaceId, void** object) override;
        STDMETHODIMP Notify(IBaseFilter* sender, Quality quality) override;

        HRESULT DecideBufferSize(IMemAllocator* allocator, ALLOCATOR_PROPERTIES* properties) override;
        HRESULT FillBuffer(IMediaSample* mediaSample) override;
        HRESULT GetMediaType(CMediaType* mediaType) override;
        HRESULT CheckMediaType(const CMediaType* mediaType) override;
        HRESULT SetMediaType(const CMediaType* mediaType) override;
        HRESULT OnThreadCreate() override;
        HRESULT OnThreadDestroy() override;

        HRESULT STDMETHODCALLTYPE Set(REFGUID propertySet, DWORD propertyId, LPVOID instanceData, DWORD instanceDataSize, LPVOID propertyData, DWORD propertyDataSize) override;
        HRESULT STDMETHODCALLTYPE Get(REFGUID propertySet, DWORD propertyId, LPVOID instanceData, DWORD instanceDataSize, LPVOID propertyData, DWORD propertyDataSize, DWORD* bytesReturned) override;
        HRESULT STDMETHODCALLTYPE QuerySupported(REFGUID propertySet, DWORD propertyId, DWORD* typeSupport) override;

        HRESULT STDMETHODCALLTYPE SetFormat(AM_MEDIA_TYPE* mediaType) override;
        HRESULT STDMETHODCALLTYPE GetFormat(AM_MEDIA_TYPE** mediaType) override;
        HRESULT STDMETHODCALLTYPE GetNumberOfCapabilities(int* count, int* size) override;
        HRESULT STDMETHODCALLTYPE GetStreamCaps(int index, AM_MEDIA_TYPE** mediaType, BYTE* capabilities) override;

    private:
        MorphlyG1Filter* GetParentFilter() const;

        CCritSec sampleLock_;
        std::uint64_t frameIndex_ = 0;
        std::uint64_t lastPresentedFrameSequence_ = 0;
        GUID currentSubtype_ = MEDIASUBTYPE_YUY2;
        long currentWidth_ = 1280;
        long currentHeight_ = 720;
        long currentOutputStride_ = 1280 * 2;
        long currentSampleBytes_ = 1280 * 720 * 2;
        bool loggedCachedFrameReuse_ = false;
        bool hasBufferedFrame_ = false;
        std::vector<uint8_t> bgraScratch_;
        std::chrono::steady_clock::time_point nextFrameDue_{};
    };

    HRESULT ValidateFixedYuy2MediaType(const AM_MEDIA_TYPE* mediaType) noexcept;
    HRESULT CreateFixedYuy2MediaType(AM_MEDIA_TYPE** mediaType) noexcept;
    void FillFixedVideoStreamCaps(VIDEO_STREAM_CONFIG_CAPS* capabilities) noexcept;
}
