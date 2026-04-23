#include "morphly/morphly_ids.h"

namespace morphly
{
    const GUID kVirtualCameraSourceClsid =
    { 0x6cb9df61, 0x861f, 0x4fc0, { 0x91, 0xeb, 0x43, 0xd2, 0x0d, 0x44, 0xd7, 0x91 } };

    const wchar_t* const kVirtualCameraFriendlyName = L"Morphly Cam G1";
    const wchar_t* const kPublisherMappingName = L"Local\\MorphlyCam.FrameBuffer";
    const wchar_t* const kPublisherMutexName = L"Local\\MorphlyCam.FrameMutex";
    const wchar_t* const kPublisherEventName = L"Local\\MorphlyCam.FrameEvent";
}
