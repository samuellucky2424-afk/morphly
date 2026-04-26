#include <initguid.h>
#include <olectl.h>

#include "virtual_camera_source.h"

#include "morphly/morphly_ids.h"

namespace
{
    const AMOVIESETUP_MEDIATYPE kPinMediaTypes[] =
    {
        {
            &MEDIATYPE_Video,
            &MEDIASUBTYPE_YUY2
        }
    };

    const AMOVIESETUP_PIN kPins[] =
    {
        {
            const_cast<LPWSTR>(L"Output"),
            FALSE,
            TRUE,
            FALSE,
            FALSE,
            nullptr,
            nullptr,
            1,
            kPinMediaTypes
        }
    };

    const REGFILTER2 kCaptureFilterRegistration =
    {
        1,
        MERIT_DO_NOT_USE,
        1,
        kPins
    };
}

CFactoryTemplate g_Templates[] =
{
    {
        morphly::kVirtualCameraFriendlyName,
        &morphly::kVirtualCameraSourceClsid,
        &morphly::virtualcam::MorphlyG1Filter::CreateInstance,
        nullptr,
        nullptr
    }
};

int g_cTemplates = sizeof(g_Templates) / sizeof(g_Templates[0]);

STDAPI DllRegisterServer()
{
    HRESULT result = AMovieDllRegisterServer2(TRUE);
    if (FAILED(result))
    {
        return result;
    }

    result = CoInitialize(nullptr);
    if (FAILED(result))
    {
        return result;
    }

    IFilterMapper2* filterMapper = nullptr;
    result = CoCreateInstance(
        CLSID_FilterMapper2,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_IFilterMapper2,
        reinterpret_cast<void**>(&filterMapper));

    if (SUCCEEDED(result))
    {
        filterMapper->UnregisterFilter(
            &CLSID_VideoInputDeviceCategory,
            0,
            morphly::kVirtualCameraSourceClsid);

        result = filterMapper->RegisterFilter(
            morphly::kVirtualCameraSourceClsid,
            morphly::kVirtualCameraFriendlyName,
            nullptr,
            &CLSID_VideoInputDeviceCategory,
            morphly::kVirtualCameraFriendlyName,
            &kCaptureFilterRegistration);

        filterMapper->Release();
    }

    CoFreeUnusedLibraries();
    CoUninitialize();
    return result;
}

STDAPI DllUnregisterServer()
{
    HRESULT result = AMovieDllRegisterServer2(FALSE);
    if (FAILED(result))
    {
        return result;
    }

    result = CoInitialize(nullptr);
    if (FAILED(result))
    {
        return result;
    }

    IFilterMapper2* filterMapper = nullptr;
    result = CoCreateInstance(
        CLSID_FilterMapper2,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_IFilterMapper2,
        reinterpret_cast<void**>(&filterMapper));

    if (SUCCEEDED(result))
    {
        result = filterMapper->UnregisterFilter(
            &CLSID_VideoInputDeviceCategory,
            morphly::kVirtualCameraFriendlyName,
            morphly::kVirtualCameraSourceClsid);
        filterMapper->Release();
    }

    CoFreeUnusedLibraries();
    CoUninitialize();
    return result;
}

extern "C" BOOL WINAPI DllEntryPoint(HINSTANCE, ULONG, LPVOID);

BOOL APIENTRY DllMain(HANDLE moduleHandle, DWORD reason, LPVOID reserved)
{
    return DllEntryPoint(static_cast<HINSTANCE>(moduleHandle), reason, reserved);
}
