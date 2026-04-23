#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>
#include <windows.h>

#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>

#include <filesystem>
#include <iostream>
#include <string>

#include <wrl/client.h>

#include "morphly/morphly_ids.h"

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

namespace
{
    using DllProc = HRESULT(STDAPICALLTYPE*)();

    struct ComScope
    {
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        ~ComScope()
        {
            if (SUCCEEDED(hr))
            {
                CoUninitialize();
            }
        }
    };

    struct MfScope
    {
        HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
        ~MfScope()
        {
            if (SUCCEEDED(hr))
            {
                MFShutdown();
            }
        }
    };

    void PrintUsage()
    {
        std::wcout
            << L"Usage:\n"
            << L"  morphly_cam_registrar install [--session] [--all-users]\n"
            << L"  morphly_cam_registrar remove [--session] [--all-users] [--unregister-com]\n"
            << L"  morphly_cam_registrar probe\n"
            << L"  morphly_cam_registrar com-register\n"
            << L"  morphly_cam_registrar com-unregister\n";
    }

    std::filesystem::path GetServiceInstallDirectory()
    {
        wchar_t commonAppData[MAX_PATH]{};
        const DWORD length = GetEnvironmentVariableW(L"ProgramData", commonAppData, ARRAYSIZE(commonAppData));
        if (length == 0 || length >= ARRAYSIZE(commonAppData))
        {
            return std::filesystem::path(L"C:\\ProgramData") / L"MorphlyCam";
        }

        return std::filesystem::path(commonAppData) / L"MorphlyCam";
    }

    std::filesystem::path ResolveDllPath()
    {
        wchar_t modulePath[MAX_PATH]{};
        GetModuleFileNameW(nullptr, modulePath, ARRAYSIZE(modulePath));
        std::filesystem::path path(modulePath);
        return path.parent_path() / L"MorphlyVirtualCamera.dll";
    }

    HRESULT EnsureStagedDll(std::filesystem::path* stagedDllPath)
    {
        if (stagedDllPath == nullptr)
        {
            return E_POINTER;
        }

        const std::filesystem::path sourceDllPath = ResolveDllPath();
        const std::filesystem::path installDirectory = GetServiceInstallDirectory();
        const std::filesystem::path targetDllPath = installDirectory / L"MorphlyVirtualCamera.dll";

        std::error_code errorCode;
        std::filesystem::create_directories(installDirectory, errorCode);
        if (errorCode)
        {
            return HRESULT_FROM_WIN32(static_cast<DWORD>(errorCode.value()));
        }

        std::filesystem::copy_file(
            sourceDllPath,
            targetDllPath,
            std::filesystem::copy_options::overwrite_existing,
            errorCode);
        if (errorCode)
        {
            return HRESULT_FROM_WIN32(static_cast<DWORD>(errorCode.value()));
        }

        *stagedDllPath = targetDllPath;
        return S_OK;
    }

    HRESULT InvokeDllEntryPoint(const std::filesystem::path& dllPath, const char* procName)
    {
        HMODULE module = LoadLibraryW(dllPath.c_str());
        if (module == nullptr)
        {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        const auto freeModule = [&]() noexcept { FreeLibrary(module); };

        auto proc = reinterpret_cast<DllProc>(GetProcAddress(module, procName));
        if (proc == nullptr)
        {
            freeModule();
            return HRESULT_FROM_WIN32(GetLastError());
        }

        const HRESULT hr = proc();
        freeModule();
        return hr;
    }

    std::wstring GetSourceClsidString()
    {
        wchar_t buffer[64]{};
        StringFromGUID2(morphly::kVirtualCameraSourceClsid, buffer, ARRAYSIZE(buffer));
        return buffer;
    }

    HRESULT OpenVirtualCamera(MFVirtualCameraLifetime lifetime, MFVirtualCameraAccess access, IMFVirtualCamera** camera)
    {
        if (camera == nullptr)
        {
            return E_POINTER;
        }

        *camera = nullptr;

        static const GUID categories[] =
        {
            KSCATEGORY_VIDEO_CAMERA,
            KSCATEGORY_VIDEO,
            KSCATEGORY_CAPTURE,
        };

        const std::wstring sourceId = GetSourceClsidString();
        return MFCreateVirtualCamera(
            MFVirtualCameraType_SoftwareCameraSource,
            lifetime,
            access,
            morphly::kVirtualCameraFriendlyName,
            sourceId.c_str(),
            categories,
            ARRAYSIZE(categories),
            camera);
    }

    HRESULT InstallCamera(bool sessionLifetime, bool allUsers)
    {
        std::filesystem::path dllPath;
        RETURN_IF_FAILED(EnsureStagedDll(&dllPath));
        std::wcout << L"Registering COM server: " << dllPath.c_str() << L"\n";
        RETURN_IF_FAILED(InvokeDllEntryPoint(dllPath, "DllRegisterServer"));

        ComScope com;
        if (FAILED(com.hr))
        {
            return com.hr;
        }

        MfScope mf;
        if (FAILED(mf.hr))
        {
            return mf.hr;
        }

        std::wcout << L"Opening virtual camera registration...\n";

        Microsoft::WRL::ComPtr<IMFVirtualCamera> camera;
        RETURN_IF_FAILED(OpenVirtualCamera(
            sessionLifetime ? MFVirtualCameraLifetime_Session : MFVirtualCameraLifetime_System,
            allUsers ? MFVirtualCameraAccess_AllUsers : MFVirtualCameraAccess_CurrentUser,
            &camera));

        std::wcout << L"Starting virtual camera...\n";
        RETURN_IF_FAILED(camera->Start(nullptr));

        wchar_t* symbolicLink = nullptr;
        UINT32 cch = 0;
        if (SUCCEEDED(camera->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &symbolicLink, &cch)))
        {
            std::wcout << L"Virtual camera installed: " << symbolicLink << L"\n";
            CoTaskMemFree(symbolicLink);
        }
        else
        {
            std::wcout << L"Virtual camera installed.\n";
        }

        camera->Shutdown();
        return S_OK;
    }

    HRESULT RemoveCamera(bool sessionLifetime, bool allUsers, bool unregisterCom)
    {
        ComScope com;
        if (FAILED(com.hr))
        {
            return com.hr;
        }

        MfScope mf;
        if (FAILED(mf.hr))
        {
            return mf.hr;
        }

        Microsoft::WRL::ComPtr<IMFVirtualCamera> camera;
        RETURN_IF_FAILED(OpenVirtualCamera(
            sessionLifetime ? MFVirtualCameraLifetime_Session : MFVirtualCameraLifetime_System,
            allUsers ? MFVirtualCameraAccess_AllUsers : MFVirtualCameraAccess_CurrentUser,
            &camera));
        RETURN_IF_FAILED(camera->Remove());
        camera->Shutdown();

        if (unregisterCom)
        {
            std::filesystem::path dllPath;
            RETURN_IF_FAILED(EnsureStagedDll(&dllPath));
            RETURN_IF_FAILED(InvokeDllEntryPoint(dllPath, "DllUnregisterServer"));
        }

        std::wcout << L"Virtual camera removed.\n";
        return S_OK;
    }

    HRESULT ProbeSource()
    {
        const std::filesystem::path dllPath = ResolveDllPath();
        RETURN_IF_FAILED(InvokeDllEntryPoint(dllPath, "DllRegisterServer"));

        ComScope com;
        if (FAILED(com.hr))
        {
            return com.hr;
        }

        MfScope mf;
        if (FAILED(mf.hr))
        {
            return mf.hr;
        }

        Microsoft::WRL::ComPtr<IMFActivate> activate;
        RETURN_IF_FAILED(CoCreateInstance(
            morphly::kVirtualCameraSourceClsid,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&activate)));

        std::wcout << L"CoCreateInstance(IMFActivate): OK\n";

        Microsoft::WRL::ComPtr<IMFMediaSource> mediaSource;
        RETURN_IF_FAILED(activate->ActivateObject(IID_PPV_ARGS(&mediaSource)));
        std::wcout << L"ActivateObject(IMFMediaSource): OK\n";

        Microsoft::WRL::ComPtr<IMFMediaSourceEx> mediaSourceEx;
        const HRESULT sourceExHr = mediaSource.As(&mediaSourceEx);
        std::wcout << L"Query IMFMediaSourceEx: 0x" << std::hex << static_cast<unsigned long>(sourceExHr) << L"\n";

        Microsoft::WRL::ComPtr<IMFMediaSource2> mediaSource2;
        const HRESULT source2Hr = mediaSource.As(&mediaSource2);
        std::wcout << L"Query IMFMediaSource2: 0x" << std::hex << static_cast<unsigned long>(source2Hr) << L"\n";

        Microsoft::WRL::ComPtr<IMFGetService> getService;
        const HRESULT getServiceHr = mediaSource.As(&getService);
        std::wcout << L"Query IMFGetService: 0x" << std::hex << static_cast<unsigned long>(getServiceHr) << L"\n";

        Microsoft::WRL::ComPtr<IKsControl> ksControl;
        const HRESULT ksHr = mediaSource.As(&ksControl);
        std::wcout << L"Query IKsControl: 0x" << std::hex << static_cast<unsigned long>(ksHr) << L"\n";

        Microsoft::WRL::ComPtr<IMFSampleAllocatorControl> allocatorControl;
        const HRESULT allocatorHr = mediaSource.As(&allocatorControl);
        std::wcout << L"Query IMFSampleAllocatorControl: 0x" << std::hex << static_cast<unsigned long>(allocatorHr) << L"\n";

        Microsoft::WRL::ComPtr<IMFPresentationDescriptor> descriptor;
        const HRESULT descriptorHr = mediaSource->CreatePresentationDescriptor(&descriptor);
        std::wcout << L"CreatePresentationDescriptor: 0x" << std::hex << static_cast<unsigned long>(descriptorHr) << L"\n";

        mediaSource->Shutdown();
        return S_OK;
    }
}

int wmain(int argc, wchar_t** argv)
{
    if (argc < 2)
    {
        PrintUsage();
        return 1;
    }

    const std::wstring command = argv[1];
    bool sessionLifetime = false;
    bool allUsers = false;
    bool unregisterCom = false;

    for (int index = 2; index < argc; ++index)
    {
        const std::wstring option = argv[index];
        if (option == L"--session")
        {
            sessionLifetime = true;
        }
        else if (option == L"--all-users")
        {
            allUsers = true;
        }
        else if (option == L"--unregister-com")
        {
            unregisterCom = true;
        }
        else
        {
            std::wcerr << L"Unknown option: " << option << L"\n";
            PrintUsage();
            return 1;
        }
    }

    HRESULT hr = E_INVALIDARG;
    if (command == L"install")
    {
        hr = InstallCamera(sessionLifetime, allUsers);
    }
    else if (command == L"remove")
    {
        hr = RemoveCamera(sessionLifetime, allUsers, unregisterCom);
    }
    else if (command == L"com-register")
    {
        std::filesystem::path dllPath;
        hr = EnsureStagedDll(&dllPath);
        if (SUCCEEDED(hr))
        {
            hr = InvokeDllEntryPoint(dllPath, "DllRegisterServer");
        }
    }
    else if (command == L"com-unregister")
    {
        std::filesystem::path dllPath;
        hr = EnsureStagedDll(&dllPath);
        if (SUCCEEDED(hr))
        {
            hr = InvokeDllEntryPoint(dllPath, "DllUnregisterServer");
        }
    }
    else if (command == L"probe")
    {
        hr = ProbeSource();
    }
    else
    {
        PrintUsage();
        return 1;
    }

    if (FAILED(hr))
    {
        std::wcerr << L"Operation failed with HRESULT 0x" << std::hex << static_cast<unsigned long>(hr) << L"\n";
        return 1;
    }

    return 0;
}
