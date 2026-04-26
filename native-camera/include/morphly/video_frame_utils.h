#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

#include <objidl.h>
#include <ocidl.h>
#include <wincodec.h>
#include <windows.h>
#include <wrl/client.h>

namespace morphly::video
{
    using Microsoft::WRL::ComPtr;

    enum class PixelFormatKind
    {
        Yuy2,
        Nv12,
        Rgb24,
        Mjpeg,
    };

    inline uint8_t ClampToByte(int value) noexcept
    {
        return static_cast<uint8_t>(std::clamp(value, 0, 255));
    }

    inline uint8_t ClampLuma(int value) noexcept
    {
        return static_cast<uint8_t>(std::clamp(value, 16, 235));
    }

    inline uint8_t ClampChroma(int value) noexcept
    {
        return static_cast<uint8_t>(std::clamp(value, 16, 240));
    }

    inline uint8_t ToLuma(uint8_t red, uint8_t green, uint8_t blue) noexcept
    {
        const int value = ((66 * red) + (129 * green) + (25 * blue) + 128) >> 8;
        return ClampLuma(value + 16);
    }

    inline uint8_t ToChromaU(uint8_t red, uint8_t green, uint8_t blue) noexcept
    {
        const int value = ((-38 * red) - (74 * green) + (112 * blue) + 128) >> 8;
        return ClampChroma(value + 128);
    }

    inline uint8_t ToChromaV(uint8_t red, uint8_t green, uint8_t blue) noexcept
    {
        const int value = ((112 * red) - (94 * green) - (18 * blue) + 128) >> 8;
        return ClampChroma(value + 128);
    }

    inline uint32_t ComputeStrideBytes(PixelFormatKind format, uint32_t width) noexcept
    {
        switch (format)
        {
        case PixelFormatKind::Yuy2:
            return width * 2u;
        case PixelFormatKind::Nv12:
            return width;
        case PixelFormatKind::Rgb24:
            return (width * 3u + 3u) & ~3u;
        case PixelFormatKind::Mjpeg:
            return width * 4u;
        default:
            return 0;
        }
    }

    inline size_t ComputeFrameBytes(PixelFormatKind format, uint32_t width, uint32_t height) noexcept
    {
        switch (format)
        {
        case PixelFormatKind::Yuy2:
            return static_cast<size_t>(width) * height * 2u;
        case PixelFormatKind::Nv12:
            return static_cast<size_t>(width) * height * 3u / 2u;
        case PixelFormatKind::Rgb24:
            return static_cast<size_t>(ComputeStrideBytes(format, width)) * height;
        case PixelFormatKind::Mjpeg:
            return static_cast<size_t>(width) * height * 4u;
        default:
            return 0;
        }
    }

    inline void ResizeBgraFrameCover(
        const uint8_t* source,
        uint32_t sourceWidth,
        uint32_t sourceHeight,
        uint32_t sourceStride,
        uint8_t* destination,
        uint32_t destinationWidth,
        uint32_t destinationHeight,
        uint32_t destinationStride) noexcept
    {
        if (source == nullptr || destination == nullptr ||
            sourceWidth == 0 || sourceHeight == 0 ||
            destinationWidth == 0 || destinationHeight == 0)
        {
            return;
        }

        const double sourceAspect = static_cast<double>(sourceWidth) / static_cast<double>(sourceHeight);
        const double destinationAspect = static_cast<double>(destinationWidth) / static_cast<double>(destinationHeight);

        double cropWidth = static_cast<double>(sourceWidth);
        double cropHeight = static_cast<double>(sourceHeight);
        double cropX = 0.0;
        double cropY = 0.0;

        if (sourceAspect > destinationAspect)
        {
            cropWidth = static_cast<double>(sourceHeight) * destinationAspect;
            cropX = (static_cast<double>(sourceWidth) - cropWidth) * 0.5;
        }
        else if (sourceAspect < destinationAspect)
        {
            cropHeight = static_cast<double>(sourceWidth) / destinationAspect;
            cropY = (static_cast<double>(sourceHeight) - cropHeight) * 0.5;
        }

        for (uint32_t y = 0; y < destinationHeight; ++y)
        {
            uint8_t* destinationRow = destination + (static_cast<size_t>(y) * destinationStride);
            const double sourceY = cropY + ((static_cast<double>(y) + 0.5) * cropHeight / static_cast<double>(destinationHeight));
            const uint32_t sourcePixelY = std::min<uint32_t>(sourceHeight - 1u, static_cast<uint32_t>(sourceY));
            const uint8_t* sourceRow = source + (static_cast<size_t>(sourcePixelY) * sourceStride);

            for (uint32_t x = 0; x < destinationWidth; ++x)
            {
                const double sourceX = cropX + ((static_cast<double>(x) + 0.5) * cropWidth / static_cast<double>(destinationWidth));
                const uint32_t sourcePixelX = std::min<uint32_t>(sourceWidth - 1u, static_cast<uint32_t>(sourceX));
                const uint8_t* sourcePixel = sourceRow + (static_cast<size_t>(sourcePixelX) * 4u);
                uint8_t* destinationPixel = destinationRow + (static_cast<size_t>(x) * 4u);
                destinationPixel[0] = sourcePixel[0];
                destinationPixel[1] = sourcePixel[1];
                destinationPixel[2] = sourcePixel[2];
                destinationPixel[3] = 0xff;
            }
        }
    }

    inline void ApplyBgraHeartbeat(uint8_t* bgra, uint32_t width, uint32_t height, uint64_t frameIndex) noexcept
    {
        if (bgra == nullptr || width == 0 || height == 0)
        {
            return;
        }

        const uint8_t pulse = static_cast<uint8_t>(frameIndex & 0x01ULL);
        const size_t topLeft = 0;
        const size_t bottomRight = (static_cast<size_t>(height - 1u) * width + (width - 1u)) * 4u;

        bgra[topLeft + 0] = static_cast<uint8_t>((bgra[topLeft + 0] & 0xfeU) | pulse);
        bgra[topLeft + 2] = static_cast<uint8_t>((bgra[topLeft + 2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
        bgra[bottomRight + 0] = static_cast<uint8_t>((bgra[bottomRight + 0] & 0xfeU) | pulse);
        bgra[bottomRight + 2] = static_cast<uint8_t>((bgra[bottomRight + 2] & 0xfeU) | static_cast<uint8_t>(pulse ^ 0x01U));
    }

    inline void ConvertBgraToYuy2(
        const uint8_t* bgra,
        uint32_t width,
        uint32_t height,
        uint32_t bgraStride,
        uint8_t* yuy2,
        uint32_t yuy2Stride) noexcept
    {
        if (bgra == nullptr || yuy2 == nullptr)
        {
            return;
        }

        for (uint32_t y = 0; y < height; ++y)
        {
            const uint8_t* sourceRow = bgra + (static_cast<size_t>(y) * bgraStride);
            uint8_t* destinationRow = yuy2 + (static_cast<size_t>(y) * yuy2Stride);

            for (uint32_t x = 0; x < width; x += 2)
            {
                const uint8_t* pixel0 = sourceRow + (static_cast<size_t>(x) * 4u);
                const uint8_t* pixel1 = sourceRow + (static_cast<size_t>(std::min(x + 1u, width - 1u)) * 4u);

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

                const size_t destinationIndex = static_cast<size_t>(x) * 2u;
                destinationRow[destinationIndex + 0] = y0;
                destinationRow[destinationIndex + 1] = static_cast<uint8_t>((static_cast<uint16_t>(u0) + u1) / 2u);
                destinationRow[destinationIndex + 2] = y1;
                destinationRow[destinationIndex + 3] = static_cast<uint8_t>((static_cast<uint16_t>(v0) + v1) / 2u);
            }
        }
    }

    inline void ConvertBgraToNv12(
        const uint8_t* bgra,
        uint32_t width,
        uint32_t height,
        uint32_t bgraStride,
        uint8_t* nv12,
        uint32_t nv12Stride) noexcept
    {
        if (bgra == nullptr || nv12 == nullptr)
        {
            return;
        }

        uint8_t* yPlane = nv12;
        uint8_t* uvPlane = nv12 + (static_cast<size_t>(nv12Stride) * height);

        for (uint32_t y = 0; y < height; ++y)
        {
            const uint8_t* sourceRow = bgra + (static_cast<size_t>(y) * bgraStride);
            uint8_t* yRow = yPlane + (static_cast<size_t>(y) * nv12Stride);

            for (uint32_t x = 0; x < width; ++x)
            {
                const uint8_t* pixel = sourceRow + (static_cast<size_t>(x) * 4u);
                yRow[x] = ToLuma(pixel[2], pixel[1], pixel[0]);
            }
        }

        for (uint32_t y = 0; y < height; y += 2)
        {
            const uint8_t* sourceRow0 = bgra + (static_cast<size_t>(y) * bgraStride);
            const uint8_t* sourceRow1 = bgra + (static_cast<size_t>(std::min(y + 1u, height - 1u)) * bgraStride);
            uint8_t* uvRow = uvPlane + (static_cast<size_t>(y / 2u) * nv12Stride);

            for (uint32_t x = 0; x < width; x += 2)
            {
                const uint8_t* pixel00 = sourceRow0 + (static_cast<size_t>(x) * 4u);
                const uint8_t* pixel01 = sourceRow0 + (static_cast<size_t>(std::min(x + 1u, width - 1u)) * 4u);
                const uint8_t* pixel10 = sourceRow1 + (static_cast<size_t>(x) * 4u);
                const uint8_t* pixel11 = sourceRow1 + (static_cast<size_t>(std::min(x + 1u, width - 1u)) * 4u);

                const uint8_t u00 = ToChromaU(pixel00[2], pixel00[1], pixel00[0]);
                const uint8_t u01 = ToChromaU(pixel01[2], pixel01[1], pixel01[0]);
                const uint8_t u10 = ToChromaU(pixel10[2], pixel10[1], pixel10[0]);
                const uint8_t u11 = ToChromaU(pixel11[2], pixel11[1], pixel11[0]);

                const uint8_t v00 = ToChromaV(pixel00[2], pixel00[1], pixel00[0]);
                const uint8_t v01 = ToChromaV(pixel01[2], pixel01[1], pixel01[0]);
                const uint8_t v10 = ToChromaV(pixel10[2], pixel10[1], pixel10[0]);
                const uint8_t v11 = ToChromaV(pixel11[2], pixel11[1], pixel11[0]);

                const size_t uvIndex = x;
                uvRow[uvIndex + 0] = static_cast<uint8_t>((static_cast<uint16_t>(u00) + u01 + u10 + u11) / 4u);
                uvRow[uvIndex + 1] = static_cast<uint8_t>((static_cast<uint16_t>(v00) + v01 + v10 + v11) / 4u);
            }
        }
    }

    inline void ConvertBgraToRgb24(
        const uint8_t* bgra,
        uint32_t width,
        uint32_t height,
        uint32_t bgraStride,
        uint8_t* rgb24,
        uint32_t rgb24Stride) noexcept
    {
        if (bgra == nullptr || rgb24 == nullptr)
        {
            return;
        }

        for (uint32_t y = 0; y < height; ++y)
        {
            const uint8_t* sourceRow = bgra + (static_cast<size_t>(y) * bgraStride);
            uint8_t* destinationRow = rgb24 + (static_cast<size_t>(y) * rgb24Stride);

            for (uint32_t x = 0; x < width; ++x)
            {
                const uint8_t* pixel = sourceRow + (static_cast<size_t>(x) * 4u);
                uint8_t* destinationPixel = destinationRow + (static_cast<size_t>(x) * 3u);
                destinationPixel[0] = pixel[0];
                destinationPixel[1] = pixel[1];
                destinationPixel[2] = pixel[2];
            }
        }
    }

    inline HRESULT EncodeBgraToJpeg(
        const uint8_t* bgra,
        uint32_t width,
        uint32_t height,
        uint32_t bgraStride,
        std::vector<uint8_t>* jpegBytes)
    {
        if (bgra == nullptr || jpegBytes == nullptr || width == 0 || height == 0)
        {
            return E_INVALIDARG;
        }

        ComPtr<IWICImagingFactory> imagingFactory;
        HRESULT result = CoCreateInstance(
            CLSID_WICImagingFactory,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&imagingFactory));
        if (FAILED(result))
        {
            return result;
        }

        ComPtr<IWICBitmap> bitmap;
        result = imagingFactory->CreateBitmapFromMemory(
            width,
            height,
            GUID_WICPixelFormat32bppBGRA,
            bgraStride,
            static_cast<UINT>(bgraStride * height),
            const_cast<BYTE*>(bgra),
            &bitmap);
        if (FAILED(result))
        {
            return result;
        }

        ComPtr<IWICFormatConverter> converter;
        result = imagingFactory->CreateFormatConverter(&converter);
        if (FAILED(result))
        {
            return result;
        }

        result = converter->Initialize(
            bitmap.Get(),
            GUID_WICPixelFormat24bppBGR,
            WICBitmapDitherTypeNone,
            nullptr,
            0.0,
            WICBitmapPaletteTypeCustom);
        if (FAILED(result))
        {
            return result;
        }

        ComPtr<IStream> stream;
        result = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
        if (FAILED(result))
        {
            return result;
        }

        ComPtr<IWICBitmapEncoder> encoder;
        result = imagingFactory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder);
        if (FAILED(result))
        {
            return result;
        }

        result = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
        if (FAILED(result))
        {
            return result;
        }

        ComPtr<IWICBitmapFrameEncode> frame;
        ComPtr<IPropertyBag2> encoderOptions;
        result = encoder->CreateNewFrame(&frame, &encoderOptions);
        if (FAILED(result))
        {
            return result;
        }

        if (encoderOptions)
        {
            PROPBAG2 option{};
            option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");

            VARIANT optionValue{};
            VariantInit(&optionValue);
            optionValue.vt = VT_R4;
            optionValue.fltVal = 0.85f;
            (void)encoderOptions->Write(1, &option, &optionValue);
            VariantClear(&optionValue);
        }

        result = frame->Initialize(encoderOptions.Get());
        if (FAILED(result))
        {
            return result;
        }

        result = frame->SetSize(width, height);
        if (FAILED(result))
        {
            return result;
        }

        WICPixelFormatGUID pixelFormat = GUID_WICPixelFormat24bppBGR;
        result = frame->SetPixelFormat(&pixelFormat);
        if (FAILED(result))
        {
            return result;
        }

        result = frame->WriteSource(converter.Get(), nullptr);
        if (FAILED(result))
        {
            return result;
        }

        result = frame->Commit();
        if (FAILED(result))
        {
            return result;
        }

        result = encoder->Commit();
        if (FAILED(result))
        {
            return result;
        }

        HGLOBAL globalHandle = nullptr;
        result = GetHGlobalFromStream(stream.Get(), &globalHandle);
        if (FAILED(result) || globalHandle == nullptr)
        {
            return FAILED(result) ? result : E_FAIL;
        }

        const SIZE_T bytes = GlobalSize(globalHandle);
        if (bytes == 0)
        {
            jpegBytes->clear();
            return E_FAIL;
        }

        const void* lockedData = GlobalLock(globalHandle);
        if (lockedData == nullptr)
        {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        jpegBytes->assign(
            static_cast<const uint8_t*>(lockedData),
            static_cast<const uint8_t*>(lockedData) + bytes);
        GlobalUnlock(globalHandle);

        return S_OK;
    }
}
