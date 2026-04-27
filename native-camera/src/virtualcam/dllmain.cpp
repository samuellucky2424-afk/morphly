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

    if (SUCCEEDED(result))
    {
        // Add DevicePath to the DirectShow category instance so Chromium-based apps
        // can properly enumerate this camera alongside the MF virtual camera.
        static constexpr wchar_t kDevicePath[] =
            L"@device:sw:{860BB310-5D01-11d0-BD3B-00A0C911CE86}\\{6CB9DF61-861F-4FC0-91EB-43D20D44D791}";
        static constexpr wchar_t kInstanceKeyPath[] =
            L"SOFTWARE\\Classes\\CLSID\\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\\Instance\\Morphly G1";

        HKEY instanceKey = nullptr;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, kInstanceKeyPath, 0, KEY_SET_VALUE, &instanceKey) == ERROR_SUCCESS)
        {
            const size_t byteCount = (wcslen(kDevicePath) + 1) * sizeof(wchar_t);
            RegSetValueExW(instanceKey, L"DevicePath", 0, REG_SZ,
                reinterpret_cast<const BYTE*>(kDevicePath), static_cast<DWORD>(byteCount));
            RegCloseKey(instanceKey);
        }
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
