#include "morphly/morphly_ids.h"

namespace morphly
{
    const GUID kVirtualCameraSourceClsid =
    { 0x564d6611, 0x91f6, 0x4bf6, { 0xaf, 0x69, 0xde, 0xd5, 0x91, 0xc3, 0x35, 0x10 } };

    const wchar_t* const kVirtualCameraFriendlyName = L"Morphly Cam";
    const wchar_t* const kPublisherMappingName = L"Local\\MorphlyCam.FrameBuffer";
    const wchar_t* const kPublisherMutexName = L"Local\\MorphlyCam.FrameMutex";
    const wchar_t* const kPublisherEventName = L"Local\\MorphlyCam.FrameEvent";
}
