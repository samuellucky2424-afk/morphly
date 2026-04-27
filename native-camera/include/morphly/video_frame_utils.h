// ===============================
// Morphly Virtual Camera Core
// ===============================

#include <vector>
#include <mutex>
#include <atomic>
#include <cstdint>
#include <windows.h>
#include <dshow.h>

// -------------------------------
// GLOBAL FRAME BUFFER
// -------------------------------

static std::vector<uint8_t> g_latestFrame; // BGRA input
static std::mutex g_frameMutex;
static std::atomic<bool> g_hasFrame(false);

static int g_width = 1280;
static int g_height = 720;

static REFERENCE_TIME g_frameIndex = 0;
static const REFERENCE_TIME FRAME_DURATION = 333333; // 30 FPS

// -------------------------------
// PRODUCER (CALL THIS FROM YOUR ENGINE)
// -------------------------------

void UpdateFrame(const uint8_t* bgra, int width, int height)
{
    std::lock_guard<std::mutex> lock(g_frameMutex);

    g_width = width;
    g_height = height;

    g_latestFrame.resize(width * height * 4);
    memcpy(g_latestFrame.data(), bgra, g_latestFrame.size());

    g_hasFrame = true;
}

// -------------------------------
// BGRA → YUY2 CONVERSION
// -------------------------------

inline uint8_t clamp(int v)
{
    return (v < 0) ? 0 : (v > 255 ? 255 : v);
}

void BGRA_to_YUY2(const uint8_t* bgra, uint8_t* yuy2, int width, int height)
{
    int numPixels = width * height;

    for (int i = 0; i < numPixels; i += 2)
    {
        int idx1 = i * 4;
        int idx2 = (i + 1) * 4;

        int b1 = bgra[idx1 + 0];
        int g1 = bgra[idx1 + 1];
        int r1 = bgra[idx1 + 2];

        int b2 = bgra[idx2 + 0];
        int g2 = bgra[idx2 + 1];
        int r2 = bgra[idx2 + 2];

        int y1 = ((66*r1 + 129*g1 + 25*b1 + 128) >> 8) + 16;
        int y2 = ((66*r2 + 129*g2 + 25*b2 + 128) >> 8) + 16;

        int u  = ((-38*r1 - 74*g1 + 112*b1 + 128) >> 8) + 128;
        int v  = ((112*r1 - 94*g1 - 18*b1 + 128) >> 8) + 128;

        yuy2[i * 2 + 0] = clamp(y1);
        yuy2[i * 2 + 1] = clamp(u);
        yuy2[i * 2 + 2] = clamp(y2);
        yuy2[i * 2 + 3] = clamp(v);
    }
}

// -------------------------------
// FALLBACK PATTERN (NO BLACK SCREEN)
// -------------------------------

void GenerateTestPattern(uint8_t* yuy2, int width, int height, int frameIndex)
{
    for (int y = 0; y < height; y++)
    {
        for (int x = 0; x < width; x += 2)
        {
            int offset = (y * width + x) * 2;

            uint8_t val = (x + frameIndex) % 256;

            yuy2[offset + 0] = val;
            yuy2[offset + 1] = 128;
            yuy2[offset + 2] = val;
            yuy2[offset + 3] = 128;
        }
    }
}

// -------------------------------
// DIRECTSHOW: FillBuffer()
// -------------------------------

HRESULT FillBuffer(IMediaSample* pSample)
{
    BYTE* pData = nullptr;
    pSample->GetPointer(&pData);

    if (!pData)
        return E_POINTER;

    int width, height;
    bool hasFrame;

    {
        std::lock_guard<std::mutex> lock(g_frameMutex);
        width = g_width;
        height = g_height;
        hasFrame = g_hasFrame;
    }

    if (hasFrame)
    {
        std::lock_guard<std::mutex> lock(g_frameMutex);
        BGRA_to_YUY2(g_latestFrame.data(), pData, width, height);
    }
    else
    {
        GenerateTestPattern(pData, width, height, (int)g_frameIndex);
    }

    // Timestamp (CRITICAL for WhatsApp/Telegram)
    REFERENCE_TIME start = g_frameIndex * FRAME_DURATION;
    REFERENCE_TIME end   = start + FRAME_DURATION;

    pSample->SetTime(&start, &end);
    pSample->SetSyncPoint(TRUE);

    g_frameIndex++;

    return S_OK;
}