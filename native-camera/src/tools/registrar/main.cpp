// morphly_cam_registrar/main.cpp
//
// Registers MorphlyVirtualCamera.dll as:
//   1. A COM in-process server (via DllRegisterServer)
//   2. A Media Foundation virtual camera (via MFCreateVirtualCamera)
//   3. A DirectShow Video Input Device (via IFilterMapper2::RegisterFilter)
//
// Must be run with administrator privileges.

#include <windows.h>

// COM / DirectShow
#include <objbase.h>
#include <strmif.h>      // IFilterMapper2, REGFILTER2, ICreateDevEnum
#include <uuids.h>       // CLSID_FilterMapper2, CLSID_VideoInputDeviceCategory, MEDIATYPE_*
#include <comdef.h>

// Media Foundation virtual camera
#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>

// KS categories
#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>

#include <filesystem>
#include <iostream>
#include <iomanip>
#include <string>
#include <sstream>

#include <wrl/client.h>
#include <shellapi.h>   // ShellExecuteEx for self-elevation

#include "morphly/morphly_ids.h"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Pretty-print an HRESULT
static std::wstring HrStr(HRESULT hr)
{
    wchar_t buf[64]{};
    swprintf_s(buf, L"0x%08X", static_cast<unsigned long>(hr));
    return buf;
}

// Print step banner
static void Log(const wchar_t* msg)
{
    std::wcout << L"[INFO]  " << msg << L"\n";
}

static void LogHr(const wchar_t* step, HRESULT hr)
{
    if (SUCCEEDED(hr))
        std::wcout << L"[OK]    " << step << L"  hr=" << HrStr(hr) << L"\n";
    else
        std::wcerr << L"[FAIL]  " << step << L"  hr=" << HrStr(hr) << L"\n";
}

static void LogWin32(const wchar_t* step, DWORD err)
{
    std::wcerr << L"[FAIL]  " << step << L"  GetLastError=" << err << L"\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin / elevation helpers
// ─────────────────────────────────────────────────────────────────────────────

static bool IsRunningAsAdmin()
{
    BOOL isAdmin = FALSE;
    PSID adminGroup = nullptr;

    SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
    if (AllocateAndInitializeSid(
            &ntAuthority, 2,
            SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS,
            0, 0, 0, 0, 0, 0, &adminGroup))
    {
        CheckTokenMembership(nullptr, adminGroup, &isAdmin);
        FreeSid(adminGroup);
    }
    return isAdmin == TRUE;
}

// Re-launch self with ShellExecute "runas" verb → triggers UAC prompt.
static int RelaunchAsAdmin(int argc, wchar_t** argv)
{
    // Reconstruct the command line (skip argv[0])
    std::wstring params;
    for (int i = 1; i < argc; ++i)
    {
        if (i > 1) params += L' ';
        params += L'"';
        params += argv[i];
        params += L'"';
    }

    wchar_t exePath[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exePath, ARRAYSIZE(exePath));

    SHELLEXECUTEINFOW sei{};
    sei.cbSize       = sizeof(sei);
    sei.fMask        = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb       = L"runas";
    sei.lpFile       = exePath;
    sei.lpParameters = params.c_str();
    sei.nShow        = SW_SHOWNORMAL;

    if (!ShellExecuteExW(&sei))
    {
        LogWin32(L"ShellExecuteEx(runas)", GetLastError());
        return 1;
    }

    if (sei.hProcess)
    {
        WaitForSingleObject(sei.hProcess, INFINITE);
        DWORD exitCode = 1;
        GetExitCodeProcess(sei.hProcess, &exitCode);
        CloseHandle(sei.hProcess);
        return static_cast<int>(exitCode);
    }

    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// RAII scopes
// ─────────────────────────────────────────────────────────────────────────────

namespace
{
    using DllProc = HRESULT(STDAPICALLTYPE*)();

    struct ComScope
    {
        HRESULT hr;
        ComScope()
        {
            hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            Log(L"CoInitializeEx(COINIT_MULTITHREADED)");
            LogHr(L"CoInitializeEx", hr);
        }
        ~ComScope()
        {
            if (SUCCEEDED(hr))
                CoUninitialize();
        }
    };

    struct MfScope
    {
        HRESULT hr;
        MfScope()
        {
            hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
            LogHr(L"MFStartup", hr);
        }
        ~MfScope()
        {
            if (SUCCEEDED(hr))
                MFShutdown();
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Path helpers
    // ─────────────────────────────────────────────────────────────────────────

    std::filesystem::path GetServiceInstallDirectory()
    {
        wchar_t commonAppData[MAX_PATH]{};
        const DWORD length = GetEnvironmentVariableW(L"ProgramData", commonAppData, ARRAYSIZE(commonAppData));
        if (length == 0 || length >= ARRAYSIZE(commonAppData))
            return std::filesystem::path(L"C:\\ProgramData") / L"MorphlyCam";
        return std::filesystem::path(commonAppData) / L"MorphlyCam";
    }

    std::filesystem::path ResolveDllPath()
    {
        wchar_t modulePath[MAX_PATH]{};
        GetModuleFileNameW(nullptr, modulePath, ARRAYSIZE(modulePath));
        return std::filesystem::path(modulePath).parent_path() / L"MorphlyVirtualCamera.dll";
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DLL loading + validation
    // ─────────────────────────────────────────────────────────────────────────

    HRESULT ValidateAndLoadDll(const std::filesystem::path& dllPath, HMODULE* phModule)
    {
        Log((L"LoadLibraryW: " + dllPath.wstring()).c_str());

        HMODULE hMod = LoadLibraryW(dllPath.c_str());
        if (hMod == nullptr)
        {
            DWORD err = GetLastError();
            LogWin32(L"LoadLibraryW", err);
            return HRESULT_FROM_WIN32(err);
        }

        Log(L"LoadLibraryW: OK");

        if (phModule)
            *phModule = hMod;
        else
            FreeLibrary(hMod);

        return S_OK;
    }

    HRESULT InvokeDllEntryPoint(const std::filesystem::path& dllPath, const char* procName)
    {
        HMODULE hMod = nullptr;
        HRESULT hr = ValidateAndLoadDll(dllPath, &hMod);
        if (FAILED(hr)) return hr;

        // Narrow → wide for logging
        std::wstring wprocName(procName, procName + strlen(procName));
        Log((L"GetProcAddress: " + wprocName).c_str());

        auto proc = reinterpret_cast<DllProc>(GetProcAddress(hMod, procName));
        if (proc == nullptr)
        {
            DWORD err = GetLastError();
            LogWin32((L"GetProcAddress(" + wprocName + L")").c_str(), err);
            FreeLibrary(hMod);
            return HRESULT_FROM_WIN32(err);
        }

        Log((L"Calling " + wprocName).c_str());
        hr = proc();
        LogHr(wprocName.c_str(), hr);

        FreeLibrary(hMod);
        return hr;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stage DLL to ProgramData\MorphlyCam\
    // ─────────────────────────────────────────────────────────────────────────

    HRESULT EnsureStagedDll(std::filesystem::path* stagedDllPath)
    {
        if (!stagedDllPath) return E_POINTER;

        const std::filesystem::path sourceDllPath  = ResolveDllPath();
        const std::filesystem::path installDirectory = GetServiceInstallDirectory();
        const std::filesystem::path targetDllPath  = installDirectory / L"MorphlyVirtualCamera.dll";

        Log((L"Source DLL:    " + sourceDllPath.wstring()).c_str());
        Log((L"Install dir:   " + installDirectory.wstring()).c_str());

        std::error_code ec;
        std::filesystem::create_directories(installDirectory, ec);
        if (ec)
        {
            std::wcerr << L"[FAIL]  create_directories: " << ec.message().c_str()
                       << L"  (win32=" << ec.value() << L")\n";
            return HRESULT_FROM_WIN32(static_cast<DWORD>(ec.value()));
        }

        std::filesystem::copy_file(
            sourceDllPath, targetDllPath,
            std::filesystem::copy_options::overwrite_existing, ec);
        if (ec)
        {
            std::wcerr << L"[FAIL]  copy_file: " << ec.message().c_str()
                       << L"  (win32=" << ec.value() << L")\n";
            return HRESULT_FROM_WIN32(static_cast<DWORD>(ec.value()));
        }

        Log((L"DLL copied to: " + targetDllPath.wstring()).c_str());
        *stagedDllPath = targetDllPath;
        return S_OK;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CLSID helpers
    // ─────────────────────────────────────────────────────────────────────────

    std::wstring GetSourceClsidString()
    {
        wchar_t buf[64]{};
        StringFromGUID2(morphly::kVirtualCameraSourceClsid, buf, ARRAYSIZE(buf));
        return buf;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Media Foundation virtual camera open/close
    // ─────────────────────────────────────────────────────────────────────────

    HRESULT OpenVirtualCamera(
        MFVirtualCameraLifetime lifetime,
        MFVirtualCameraAccess   access,
        IMFVirtualCamera**      camera)
    {
        if (!camera) return E_POINTER;
        *camera = nullptr;

        static const GUID categories[] = {
            KSCATEGORY_VIDEO_CAMERA,
            KSCATEGORY_VIDEO,
            KSCATEGORY_CAPTURE,
        };

        const std::wstring sourceId = GetSourceClsidString();
        Log((L"MFCreateVirtualCamera  sourceId=" + sourceId).c_str());

        HRESULT hr = MFCreateVirtualCamera(
            MFVirtualCameraType_SoftwareCameraSource,
            lifetime,
            access,
            morphly::kVirtualCameraFriendlyName,
            sourceId.c_str(),
            categories,
            ARRAYSIZE(categories),
            camera);
        LogHr(L"MFCreateVirtualCamera", hr);
        return hr;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // install
    // ─────────────────────────────────────────────────────────────────────────

    HRESULT InstallCamera(bool sessionLifetime, bool allUsers)
    {
        Log(L"InstallCamera");

        // 1. COM must be initialised first (needed by DllRegisterServer and IFilterMapper2)
        ComScope com;
        if (FAILED(com.hr)) return com.hr;

        // Stage the DLL to ProgramData/MorphlyCam
        std::filesystem::path dllPath;
        HRESULT hr = EnsureStagedDll(&dllPath);
        LogHr(L"EnsureStagedDll", hr);
        if (FAILED(hr)) return hr;

        // 3. Validate the DLL can actually be loaded (architecture / dependency check)
        {
            HMODULE hMod = nullptr;
            hr = ValidateAndLoadDll(dllPath, &hMod);
            if (FAILED(hr)) return hr;
            FreeLibrary(hMod);
        }

        // COM server (writes HKCR/HKLM registry keys)
        Log(L"COM registration (DllRegisterServer)");
        hr = InvokeDllEntryPoint(dllPath, "DllRegisterServer");
        LogHr(L"DllRegisterServer", hr);
        if (FAILED(hr)) return hr;

        // MFStartup
        MfScope mf;
        if (FAILED(mf.hr)) return mf.hr;

        // Register MF virtual camera
        Log(L"Media Foundation virtual camera registration");
        Microsoft::WRL::ComPtr<IMFVirtualCamera> camera;
        hr = OpenVirtualCamera(
            sessionLifetime ? MFVirtualCameraLifetime_Session : MFVirtualCameraLifetime_System,
            allUsers         ? MFVirtualCameraAccess_AllUsers  : MFVirtualCameraAccess_CurrentUser,
            &camera);
        if (FAILED(hr)) return hr;

        Log(L"Calling IMFVirtualCamera::Start");
        hr = camera->Start(nullptr);
        LogHr(L"IMFVirtualCamera::Start", hr);
        if (FAILED(hr)) return hr;

        wchar_t* symbolicLink = nullptr;
        UINT32   cch = 0;
        if (SUCCEEDED(camera->GetAllocatedString(
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                &symbolicLink, &cch)))
        {
            std::wcout << L"[OK]    Virtual camera symbolic link: " << symbolicLink << L"\n";
            CoTaskMemFree(symbolicLink);
        }
        else
        {
            Log(L"Virtual camera registered (no symbolic link available).");
        }

        camera->Shutdown();
        Log(L"Install complete");
        return S_OK;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // remove
    // ─────────────────────────────────────────────────────────────────────────

    HRESULT RemoveCamera(bool sessionLifetime, bool allUsers, bool unregisterCom)
    {
        Log(L"RemoveCamera");

        ComScope com;
        if (FAILED(com.hr)) return com.hr;

        MfScope mf;
        if (FAILED(mf.hr)) return mf.hr;

        Microsoft::WRL::ComPtr<IMFVirtualCamera> camera;
        HRESULT hr = OpenVirtualCamera(
            sessionLifetime ? MFVirtualCameraLifetime_Session : MFVirtualCameraLifetime_System,
            allUsers         ? MFVirtualCameraAccess_AllUsers  : MFVirtualCameraAccess_CurrentUser,
            &camera);
        if (FAILED(hr)) return hr;

        hr = camera->Remove();
        LogHr(L"IMFVirtualCamera::Remove", hr);
        camera->Shutdown();
        if (FAILED(hr)) return hr;

        if (unregisterCom)
        {
            std::filesystem::path dllPath;
            hr = EnsureStagedDll(&dllPath);
            if (SUCCEEDED(hr))
                hr = InvokeDllEntryPoint(dllPath, "DllUnregisterServer");
            LogHr(L"DllUnregisterServer", hr);
            if (FAILED(hr)) return hr;
        }

        Log(L"Remove complete");
        return S_OK;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // probe
    // ─────────────────────────────────────────────────────────────────────────

    HRESULT ProbeSource()
    {
        Log(L"ProbeSource");

        // 1. Validate raw DLL load from the local (non-staged) copy
        const std::filesystem::path dllPath = ResolveDllPath();
        {
            HMODULE hMod = nullptr;
            HRESULT hr = ValidateAndLoadDll(dllPath, &hMod);
            if (FAILED(hr)) return hr;
            FreeLibrary(hMod);
        }

        // 2. COM
        ComScope com;
        if (FAILED(com.hr)) return com.hr;

        // 3. Register COM temporarily
        HRESULT hr = InvokeDllEntryPoint(dllPath, "DllRegisterServer");
        if (FAILED(hr)) return hr;

        // 4. MF
        MfScope mf;
        if (FAILED(mf.hr)) return mf.hr;

        // 5. CoCreateInstance
        Microsoft::WRL::ComPtr<IMFActivate> activate;
        hr = CoCreateInstance(
            morphly::kVirtualCameraSourceClsid,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&activate));
        LogHr(L"CoCreateInstance(IMFActivate)", hr);
        if (FAILED(hr)) return hr;

        // 6. ActivateObject
        Microsoft::WRL::ComPtr<IMFMediaSource> mediaSource;
        hr = activate->ActivateObject(IID_PPV_ARGS(&mediaSource));
        LogHr(L"ActivateObject(IMFMediaSource)", hr);
        if (FAILED(hr)) return hr;

        // 7. Interface queries
        auto queryLog = [&](const wchar_t* name, auto& ptr) {
            HRESULT qhr = mediaSource.As(&ptr);
            LogHr(name, qhr);
        };

        Microsoft::WRL::ComPtr<IMFMediaSourceEx>         mediaSourceEx;
        Microsoft::WRL::ComPtr<IMFMediaSource2>          mediaSource2;
        Microsoft::WRL::ComPtr<IMFGetService>            getService;
        Microsoft::WRL::ComPtr<IKsControl>               ksControl;
        Microsoft::WRL::ComPtr<IMFSampleAllocatorControl> allocatorCtrl;

        queryLog(L"Query IMFMediaSourceEx",         mediaSourceEx);
        queryLog(L"Query IMFMediaSource2",           mediaSource2);
        queryLog(L"Query IMFGetService",             getService);
        queryLog(L"Query IKsControl",                ksControl);
        queryLog(L"Query IMFSampleAllocatorControl", allocatorCtrl);

        Microsoft::WRL::ComPtr<IMFPresentationDescriptor> descriptor;
        hr = mediaSource->CreatePresentationDescriptor(&descriptor);
        LogHr(L"CreatePresentationDescriptor", hr);

        mediaSource->Shutdown();
        Log(L"Probe complete");
        return S_OK;
    }

    void PrintUsage()
    {
        std::wcout
            << L"Usage:\n"
            << L"  morphly_cam_registrar install [--session] [--all-users]\n"
            << L"  morphly_cam_registrar remove  [--session] [--all-users] [--unregister-com]\n"
            << L"  morphly_cam_registrar probe\n"
            << L"  morphly_cam_registrar com-register\n"
            << L"  morphly_cam_registrar com-unregister\n"
            << L"  morphly_cam_registrar ds-register\n"
            << L"  morphly_cam_registrar ds-unregister\n";
    }

} // anonymous namespace

// ─────────────────────────────────────────────────────────────────────────────
// wmain
// ─────────────────────────────────────────────────────────────────────────────

int wmain(int argc, wchar_t** argv)
{
    // Admin check + self-elevation
    if (!IsRunningAsAdmin())
    {
        std::wcout << L"[INFO]  Not running as administrator - requesting elevation...\n";
        return RelaunchAsAdmin(argc, argv);
    }
    Log(L"Running with administrator privileges.");

    // Parse command
    if (argc < 2)
    {
        PrintUsage();
        return 1;
    }

    const std::wstring command = argv[1];
    bool sessionLifetime = false;
    bool allUsers        = false;
    bool unregisterCom   = false;

    for (int i = 2; i < argc; ++i)
    {
        const std::wstring opt = argv[i];
        if      (opt == L"--session")        sessionLifetime = true;
        else if (opt == L"--all-users")      allUsers        = true;
        else if (opt == L"--unregister-com") unregisterCom   = true;
        else
        {
            std::wcerr << L"[FAIL]  Unknown option: " << opt << L"\n";
            PrintUsage();
            return 1;
        }
    }

    // Dispatch
    HRESULT hr = E_INVALIDARG;

    if (command == L"install")
    {
        hr = InstallCamera(sessionLifetime, allUsers);
    }
    else if (command == L"remove")
    {
        hr = RemoveCamera(sessionLifetime, allUsers, unregisterCom);
    }
    else if (command == L"probe")
    {
        hr = ProbeSource();
    }
    else if (command == L"com-register")
    {
        std::filesystem::path dllPath;
        hr = EnsureStagedDll(&dllPath);
        if (SUCCEEDED(hr))
        {
            ComScope com;   // needed for COM server registration
            if (FAILED(com.hr)) { hr = com.hr; }
            else hr = InvokeDllEntryPoint(dllPath, "DllRegisterServer");
        }
    }
    else if (command == L"com-unregister")
    {
        std::filesystem::path dllPath;
        hr = EnsureStagedDll(&dllPath);
        if (SUCCEEDED(hr))
        {
            ComScope com;
            if (FAILED(com.hr)) { hr = com.hr; }
            else hr = InvokeDllEntryPoint(dllPath, "DllUnregisterServer");
        }
    }
    else
    {
        PrintUsage();
        return 1;
    }

    // Final result
    if (FAILED(hr))
    {
        std::wcerr << L"[FAIL]  Operation \"" << command
                   << L"\" failed  hr=" << HrStr(hr) << L"\n";
        return 1;
    }

    std::wcout << L"[OK]    Operation \"" << command << L"\" succeeded.\n";
    return 0;
}
