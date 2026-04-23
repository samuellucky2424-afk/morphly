#include <windows.h>

#include <string>

#include <strsafe.h>

#include "virtual_camera_source.h"

#include "morphly/morphly_ids.h"

namespace
{
    HMODULE g_moduleHandle = nullptr;

    HRESULT SetRegistryString(HKEY key, const wchar_t* valueName, const wchar_t* value)
    {
        const size_t byteCount = (wcslen(value) + 1) * sizeof(wchar_t);
        const LSTATUS status = RegSetValueExW(
            key,
            valueName,
            0,
            REG_SZ,
            reinterpret_cast<const BYTE*>(value),
            static_cast<DWORD>(byteCount));

        return HRESULT_FROM_WIN32(status);
    }

    HRESULT GetClsidString(std::wstring* clsidString)
    {
        if (clsidString == nullptr)
        {
            return E_POINTER;
        }

        wchar_t value[64]{};
        if (StringFromGUID2(morphly::kVirtualCameraSourceClsid, value, ARRAYSIZE(value)) == 0)
        {
            return E_FAIL;
        }

        *clsidString = value;
        return S_OK;
    }

    HRESULT GetModulePath(std::wstring* modulePath)
    {
        if (modulePath == nullptr)
        {
            return E_POINTER;
        }

        wchar_t path[MAX_PATH]{};
        const DWORD length = GetModuleFileNameW(g_moduleHandle, path, ARRAYSIZE(path));
        if (length == 0 || length == ARRAYSIZE(path))
        {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        *modulePath = path;
        return S_OK;
    }

    HRESULT RegisterComClassInRoot(HKEY rootKey)
    {
        std::wstring clsidString;
        std::wstring modulePath;
        if (FAILED(GetClsidString(&clsidString)) || FAILED(GetModulePath(&modulePath)))
        {
            return E_FAIL;
        }

        std::wstring classKeyPath = L"Software\\Classes\\CLSID\\" + clsidString;
        HKEY classKey = nullptr;
        LSTATUS status = RegCreateKeyExW(
            rootKey,
            classKeyPath.c_str(),
            0,
            nullptr,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            nullptr,
            &classKey,
            nullptr);
        if (status != ERROR_SUCCESS)
        {
            return HRESULT_FROM_WIN32(status);
        }

        const auto closeClassKey = [&]() noexcept { RegCloseKey(classKey); };

        HRESULT hr = SetRegistryString(classKey, nullptr, L"Morphly Camera Media Source");
        if (FAILED(hr))
        {
            closeClassKey();
            return hr;
        }

        HKEY inprocKey = nullptr;
        status = RegCreateKeyExW(
            classKey,
            L"InprocServer32",
            0,
            nullptr,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            nullptr,
            &inprocKey,
            nullptr);
        if (status != ERROR_SUCCESS)
        {
            closeClassKey();
            return HRESULT_FROM_WIN32(status);
        }

        hr = SetRegistryString(inprocKey, nullptr, modulePath.c_str());
        if (SUCCEEDED(hr))
        {
            hr = SetRegistryString(inprocKey, L"ThreadingModel", L"Both");
        }

        RegCloseKey(inprocKey);
        closeClassKey();
        return hr;
    }

    HRESULT RegisterComClass()
    {
        const HRESULT machineHr = RegisterComClassInRoot(HKEY_LOCAL_MACHINE);
        if (SUCCEEDED(machineHr))
        {
            return S_OK;
        }

        if (HRESULT_CODE(machineHr) != ERROR_ACCESS_DENIED)
        {
            return machineHr;
        }

        return RegisterComClassInRoot(HKEY_CURRENT_USER);
    }

    HRESULT UnregisterComClassInRoot(HKEY rootKey)
    {
        std::wstring clsidString;
        if (FAILED(GetClsidString(&clsidString)))
        {
            return E_FAIL;
        }

        std::wstring classKeyPath = L"Software\\Classes\\CLSID\\" + clsidString;
        const LSTATUS status = RegDeleteTreeW(rootKey, classKeyPath.c_str());
        if (status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND)
        {
            return S_OK;
        }

        return HRESULT_FROM_WIN32(status);
    }

    HRESULT UnregisterComClass()
    {
        const HRESULT machineHr = UnregisterComClassInRoot(HKEY_LOCAL_MACHINE);
        const HRESULT userHr = UnregisterComClassInRoot(HKEY_CURRENT_USER);

        if (FAILED(machineHr) && HRESULT_CODE(machineHr) != ERROR_ACCESS_DENIED)
        {
            return machineHr;
        }

        if (FAILED(userHr) && HRESULT_CODE(userHr) != ERROR_ACCESS_DENIED)
        {
            return userHr;
        }

        return S_OK;
    }
}

STDAPI DllCanUnloadNow()
{
    return morphly::virtualcam::CanUnloadModule() ? S_OK : S_FALSE;
}

STDAPI DllGetClassObject(REFCLSID classId, REFIID interfaceId, void** object)
{
    return morphly::virtualcam::CreateClassFactory(classId, interfaceId, object);
}

STDAPI DllRegisterServer()
{
    return RegisterComClass();
}

STDAPI DllUnregisterServer()
{
    return UnregisterComClass();
}

BOOL APIENTRY DllMain(HMODULE moduleHandle, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        g_moduleHandle = moduleHandle;
        DisableThreadLibraryCalls(moduleHandle);
    }

    return TRUE;
}
