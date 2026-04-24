#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>
#include <dshow.h>
#include <windows.h>

#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>

#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

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

    struct CameraRegistrationMode
    {
        MFVirtualCameraLifetime lifetime = MFVirtualCameraLifetime_System;
        MFVirtualCameraAccess access = MFVirtualCameraAccess_CurrentUser;
        const wchar_t* label = L"";
    };

    struct ComScope
    {
        HRESULT hr = CoInitialize(nullptr);
        ~ComScope()
        {
            if (ShouldUninitializeCom(hr))
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

    std::wstring HrToString(HRESULT hr)
    {
        std::wstringstream stream;
        stream << L"0x" << std::hex << std::uppercase << static_cast<unsigned long>(hr);
        return stream.str();
    }

    std::wstring Win32ErrorToString(DWORD error)
    {
        wchar_t* message = nullptr;
        const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
        const DWORD length = FormatMessageW(
            flags,
            nullptr,
            error,
            0,
            reinterpret_cast<LPWSTR>(&message),
            0,
            nullptr);

        std::wstring result = L"code " + std::to_wstring(error);
        if (length != 0 && message != nullptr)
        {
            result += L" (";
            result += message;
            while (!result.empty() && (result.back() == L'\r' || result.back() == L'\n'))
            {
                result.pop_back();
            }
            result += L")";
        }

        if (message != nullptr)
        {
            LocalFree(message);
        }

        return result;
    }

    void LogInfo(const std::wstring& message)
    {
        std::wcout << message << L"\n";
    }

    void LogError(const std::wstring& message)
    {
        std::wcerr << message << L"\n";
    }

    void LogStepResult(const std::wstring& step, HRESULT hr)
    {
        if (SUCCEEDED(hr))
        {
            LogInfo(step + L": OK (" + HrToString(hr) + L")");
        }
        else
        {
            LogError(step + L": FAILED (" + HrToString(hr) + L")");
        }
    }

    bool ShouldUninitializeCom(HRESULT hr) noexcept
    {
        return hr == S_OK || hr == S_FALSE;
    }

    bool IsAdminLikeError(HRESULT hr) noexcept
    {
        return hr == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)
            || hr == HRESULT_FROM_WIN32(ERROR_ELEVATION_REQUIRED);
    }

    std::wstring DescribeMachine(WORD machine)
    {
        switch (machine)
        {
        case IMAGE_FILE_MACHINE_I386:
            return L"x86";
        case IMAGE_FILE_MACHINE_AMD64:
            return L"x64";
        case IMAGE_FILE_MACHINE_ARM64:
            return L"arm64";
        case IMAGE_FILE_MACHINE_UNKNOWN:
            return L"unknown";
        default:
        {
            std::wstringstream stream;
            stream << L"machine 0x" << std::hex << std::uppercase << machine;
            return stream.str();
        }
        }
    }

    WORD GetCurrentProcessMachine() noexcept
    {
#if defined(_M_X64)
        return IMAGE_FILE_MACHINE_AMD64;
#elif defined(_M_IX86)
        return IMAGE_FILE_MACHINE_I386;
#elif defined(_M_ARM64)
        return IMAGE_FILE_MACHINE_ARM64;
#else
        return IMAGE_FILE_MACHINE_UNKNOWN;
#endif
    }

    HRESULT IsProcessElevated(bool* elevated)
    {
        if (elevated == nullptr)
        {
            return E_POINTER;
        }

        *elevated = false;

        HANDLE token = nullptr;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        {
            return HRESULT_FROM_WIN32(GetLastError());
        }

        const auto closeToken = [&]() noexcept { CloseHandle(token); };

        TOKEN_ELEVATION elevation{};
        DWORD returnedLength = 0;
        if (!GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &returnedLength))
        {
            const HRESULT hr = HRESULT_FROM_WIN32(GetLastError());
            closeToken();
            return hr;
        }

        closeToken();
        *elevated = elevation.TokenIsElevated != 0;
        return S_OK;
    }

    HRESULT EnsureAdministrativePrivileges(const std::wstring& operation)
    {
        bool elevated = false;
        const HRESULT elevationHr = IsProcessElevated(&elevated);
        LogStepResult(L"Check admin privileges for " + operation, elevationHr);
        if (FAILED(elevationHr))
        {
            return elevationHr;
        }

        LogInfo(L"Registrar elevation state: " + std::wstring(elevated ? L"elevated" : L"not elevated"));
        if (!elevated)
        {
            return HRESULT_FROM_WIN32(ERROR_ELEVATION_REQUIRED);
        }

        return S_OK;
    }

    HRESULT ReadPortableExecutableMachine(const std::filesystem::path& filePath, WORD* machine)
    {
        if (machine == nullptr)
        {
            return E_POINTER;
        }

        std::ifstream stream(filePath, std::ios::binary);
        if (!stream)
        {
            return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
        }

        IMAGE_DOS_HEADER dosHeader{};
        stream.read(reinterpret_cast<char*>(&dosHeader), sizeof(dosHeader));
        if (!stream || dosHeader.e_magic != IMAGE_DOS_SIGNATURE)
        {
            return HRESULT_FROM_WIN32(ERROR_BAD_EXE_FORMAT);
        }

        stream.seekg(dosHeader.e_lfanew, std::ios::beg);
        DWORD peSignature = 0;
        stream.read(reinterpret_cast<char*>(&peSignature), sizeof(peSignature));
        if (!stream || peSignature != IMAGE_NT_SIGNATURE)
        {
            return HRESULT_FROM_WIN32(ERROR_BAD_EXE_FORMAT);
        }

        IMAGE_FILE_HEADER fileHeader{};
        stream.read(reinterpret_cast<char*>(&fileHeader), sizeof(fileHeader));
        if (!stream)
        {
            return HRESULT_FROM_WIN32(ERROR_BAD_EXE_FORMAT);
        }

        *machine = fileHeader.Machine;
        return S_OK;
    }

    HRESULT ValidateArchitecture(const std::filesystem::path& dllPath)
    {
        const WORD processMachine = GetCurrentProcessMachine();
        LogInfo(L"Registrar architecture: " + DescribeMachine(processMachine));

        WORD dllMachine = IMAGE_FILE_MACHINE_UNKNOWN;
        const HRESULT readHr = ReadPortableExecutableMachine(dllPath, &dllMachine);
        LogStepResult(L"Read DLL architecture for " + dllPath.wstring(), readHr);
        if (FAILED(readHr))
        {
            return readHr;
        }

        LogInfo(L"MorphlyVirtualCamera.dll architecture: " + DescribeMachine(dllMachine));
        if (processMachine != IMAGE_FILE_MACHINE_UNKNOWN && dllMachine != processMachine)
        {
            LogError(L"Architecture mismatch: registrar is " + DescribeMachine(processMachine)
                + L", DLL is " + DescribeMachine(dllMachine));
            return HRESULT_FROM_WIN32(ERROR_BAD_EXE_FORMAT);
        }

        return S_OK;
    }

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
        LogInfo(L"LoadLibraryW(" + dllPath.wstring() + L")...");
        HMODULE module = LoadLibraryW(dllPath.c_str());
        if (module == nullptr)
        {
            const DWORD lastError = GetLastError();
            LogError(L"LoadLibraryW failed for " + dllPath.wstring() + L": " + Win32ErrorToString(lastError));
            return HRESULT_FROM_WIN32(lastError);
        }

        const auto freeModule = [&]() noexcept { FreeLibrary(module); };
        LogInfo(L"LoadLibraryW succeeded for " + dllPath.wstring());

        std::wstringstream step;
        step << L"GetProcAddress(" << procName << L")";
        auto proc = reinterpret_cast<DllProc>(GetProcAddress(module, procName));
        if (proc == nullptr)
        {
            const DWORD lastError = GetLastError();
            LogError(step.str() + L" failed: " + Win32ErrorToString(lastError));
            freeModule();
            return HRESULT_FROM_WIN32(lastError);
        }

        LogInfo(step.str() + L": OK");
        LogInfo(L"Calling DLL entry point...");
        const HRESULT hr = proc();
        LogStepResult(L"Invoke DLL entry point", hr);
        freeModule();
        return hr;
    }

    HRESULT RegisterDirectShowFilter()
    {
        LogInfo(L"CoCreateInstance(CLSID_FilterMapper2)...");
        Microsoft::WRL::ComPtr<IFilterMapper2> mapper;
        const HRESULT mapperHr = CoCreateInstance(
            CLSID_FilterMapper2,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&mapper));
        LogStepResult(L"CoCreateInstance(CLSID_FilterMapper2)", mapperHr);
        if (FAILED(mapperHr))
        {
            return mapperHr;
        }

        static const REGPINTYPES mediaTypes[] =
        {
            { &MEDIATYPE_Video, &MEDIASUBTYPE_RGB32 },
        };

        REGFILTERPINS pins[] =
        {
            {
                const_cast<LPWSTR>(L"Capture"),
                FALSE,
                TRUE,
                FALSE,
                FALSE,
                GUID_NULL,
                nullptr,
                ARRAYSIZE(mediaTypes),
                mediaTypes,
            },
        };

        REGFILTER2 filterRegistration{};
        filterRegistration.dwVersion = 1;
        filterRegistration.dwMerit = MERIT_DO_NOT_USE;
        filterRegistration.cPins = ARRAYSIZE(pins);
        filterRegistration.rgPins = pins;

        HRESULT unregisterHr = mapper->UnregisterFilter(
            &CLSID_VideoInputDeviceCategory,
            morphly::kVirtualCameraFriendlyName,
            morphly::kVirtualCameraSourceClsid);
        if (FAILED(unregisterHr) && unregisterHr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) && unregisterHr != VFW_E_NOT_FOUND)
        {
            LogStepResult(L"IFilterMapper2::UnregisterFilter(CLSID_VideoInputDeviceCategory)", unregisterHr);
        }
        else
        {
            LogInfo(L"IFilterMapper2::UnregisterFilter(CLSID_VideoInputDeviceCategory): OK or not previously registered");
        }

        Microsoft::WRL::ComPtr<IMoniker> moniker;
        const HRESULT registerHr = mapper->RegisterFilter(
            morphly::kVirtualCameraSourceClsid,
            morphly::kVirtualCameraFriendlyName,
            &moniker,
            &CLSID_VideoInputDeviceCategory,
            morphly::kVirtualCameraFriendlyName,
            &filterRegistration);
        LogStepResult(L"IFilterMapper2::RegisterFilter(CLSID_VideoInputDeviceCategory)", registerHr);
        if (FAILED(registerHr))
        {
            return registerHr;
        }

        if (moniker)
        {
            Microsoft::WRL::ComPtr<IBindCtx> bindContext;
            const HRESULT bindHr = CreateBindCtx(0, &bindContext);
            LogStepResult(L"CreateBindCtx", bindHr);
            if (SUCCEEDED(bindHr))
            {
                LPOLESTR displayName = nullptr;
                const HRESULT nameHr = moniker->GetDisplayName(bindContext.Get(), nullptr, &displayName);
                LogStepResult(L"IMoniker::GetDisplayName", nameHr);
                if (SUCCEEDED(nameHr) && displayName != nullptr)
                {
                    LogInfo(L"Registered DirectShow moniker: " + std::wstring(displayName));
                    CoTaskMemFree(displayName);
                }
            }
        }

        return S_OK;
    }

    HRESULT UnregisterDirectShowFilter()
    {
        LogInfo(L"CoCreateInstance(CLSID_FilterMapper2)...");
        Microsoft::WRL::ComPtr<IFilterMapper2> mapper;
        const HRESULT mapperHr = CoCreateInstance(
            CLSID_FilterMapper2,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&mapper));
        LogStepResult(L"CoCreateInstance(CLSID_FilterMapper2)", mapperHr);
        if (FAILED(mapperHr))
        {
            return mapperHr;
        }

        HRESULT unregisterHr = mapper->UnregisterFilter(
            &CLSID_VideoInputDeviceCategory,
            morphly::kVirtualCameraFriendlyName,
            morphly::kVirtualCameraSourceClsid);
        if (FAILED(unregisterHr) && unregisterHr != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) && unregisterHr != VFW_E_NOT_FOUND)
        {
            LogStepResult(L"IFilterMapper2::UnregisterFilter(CLSID_VideoInputDeviceCategory)", unregisterHr);
            return unregisterHr;
        }

        LogInfo(L"IFilterMapper2::UnregisterFilter(CLSID_VideoInputDeviceCategory): OK or not previously registered");
        return S_OK;
    }

    std::wstring GetSourceClsidString()
    {
        wchar_t buffer[64]{};
        StringFromGUID2(morphly::kVirtualCameraSourceClsid, buffer, ARRAYSIZE(buffer));
        return buffer;
    }

    bool IsMissingCameraResult(HRESULT hr) noexcept
    {
        return hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
            || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
            || hr == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND);
    }

    std::vector<CameraRegistrationMode> BuildInstallModes(bool sessionLifetime, bool allUsers)
    {
        if (sessionLifetime)
        {
            return {
                { MFVirtualCameraLifetime_Session, MFVirtualCameraAccess_CurrentUser, L"session/current-user" },
            };
        }

        if (allUsers)
        {
            return {
                { MFVirtualCameraLifetime_System, MFVirtualCameraAccess_AllUsers, L"system/all-users" },
                { MFVirtualCameraLifetime_System, MFVirtualCameraAccess_CurrentUser, L"system/current-user" },
                { MFVirtualCameraLifetime_Session, MFVirtualCameraAccess_CurrentUser, L"session/current-user" },
            };
        }

        return {
            { MFVirtualCameraLifetime_System, MFVirtualCameraAccess_CurrentUser, L"system/current-user" },
            { MFVirtualCameraLifetime_Session, MFVirtualCameraAccess_CurrentUser, L"session/current-user" },
        };
    }

    std::vector<CameraRegistrationMode> BuildCleanupModes()
    {
        return {
            { MFVirtualCameraLifetime_System, MFVirtualCameraAccess_AllUsers, L"system/all-users" },
            { MFVirtualCameraLifetime_System, MFVirtualCameraAccess_CurrentUser, L"system/current-user" },
            { MFVirtualCameraLifetime_Session, MFVirtualCameraAccess_CurrentUser, L"session/current-user" },
        };
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

    HRESULT RemoveCameraRegistration(const CameraRegistrationMode& mode) noexcept
    {
        Microsoft::WRL::ComPtr<IMFVirtualCamera> camera;
        const HRESULT openHr = OpenVirtualCamera(mode.lifetime, mode.access, &camera);
        if (FAILED(openHr))
        {
            return openHr;
        }

        const HRESULT removeHr = camera->Remove();
        camera->Shutdown();
        return removeHr;
    }

    void CleanupStaleRegistrations()
    {
        for (const auto& mode : BuildCleanupModes())
        {
            const HRESULT hr = RemoveCameraRegistration(mode);
            if (SUCCEEDED(hr) || IsMissingCameraResult(hr))
            {
                if (SUCCEEDED(hr))
                {
                    std::wcout << L"Removed stale virtual camera registration for " << mode.label << L".\n";
                }
                continue;
            }

            std::wcout
                << L"Stale registration cleanup skipped for "
                << mode.label
                << L" with HRESULT 0x"
                << std::hex << static_cast<unsigned long>(hr)
                << std::dec << L"\n";
        }
    }

    HRESULT TryInstallCamera(const CameraRegistrationMode& mode)
    {
        Microsoft::WRL::ComPtr<IMFVirtualCamera> camera;
        std::wcout << L"Opening virtual camera registration for " << mode.label << L"...\n";
        RETURN_IF_FAILED(OpenVirtualCamera(mode.lifetime, mode.access, &camera));

        std::wcout << L"Starting virtual camera for " << mode.label << L"...\n";
        const HRESULT startHr = camera->Start(nullptr);
        if (FAILED(startHr))
        {
            camera->Shutdown();
            return startHr;
        }

        wchar_t* symbolicLink = nullptr;
        UINT32 cch = 0;
        if (SUCCEEDED(camera->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &symbolicLink, &cch)))
        {
            std::wcout << L"Virtual camera installed (" << mode.label << L"): " << symbolicLink << L"\n";
            CoTaskMemFree(symbolicLink);
        }
        else
        {
            std::wcout << L"Virtual camera installed (" << mode.label << L").\n";
        }

        camera->Shutdown();
        return S_OK;
    }

    HRESULT InstallCamera(bool sessionLifetime, bool allUsers)
    {
        RETURN_IF_FAILED(EnsureAdministrativePrivileges(L"install"));

        std::filesystem::path dllPath;
        const HRESULT stageHr = EnsureStagedDll(&dllPath);
        LogStepResult(L"Stage MorphlyVirtualCamera.dll", stageHr);
        RETURN_IF_FAILED(stageHr);

        const HRESULT archHr = ValidateArchitecture(dllPath);
        LogStepResult(L"Validate DLL architecture", archHr);
        RETURN_IF_FAILED(archHr);

        ComScope com;
        LogStepResult(L"CoInitialize", com.hr);
        if (FAILED(com.hr))
        {
            return com.hr;
        }

        const HRESULT dshowRegisterHr = RegisterDirectShowFilter();
        RETURN_IF_FAILED(dshowRegisterHr);

        LogInfo(L"Registering COM server: " + dllPath.wstring());
        const HRESULT registerServerHr = InvokeDllEntryPoint(dllPath, "DllRegisterServer");
        RETURN_IF_FAILED(registerServerHr);

        MfScope mf;
        LogStepResult(L"MFStartup", mf.hr);
        if (FAILED(mf.hr))
        {
            LogError(L"Media Foundation startup failed. DirectShow registration succeeded, so install will continue.");
            return S_OK;
        }

        CleanupStaleRegistrations();

        HRESULT lastHr = E_FAIL;
        for (const auto& mode : BuildInstallModes(sessionLifetime, allUsers))
        {
            const HRESULT installHr = TryInstallCamera(mode);
            if (SUCCEEDED(installHr))
            {
                LogInfo(L"Install completed with DirectShow and Media Foundation registration.");
                return S_OK;
            }

            lastHr = installHr;
            std::wcerr
                << L"Install attempt failed for "
                << mode.label
                << L" with HRESULT 0x"
                << std::hex << static_cast<unsigned long>(installHr)
                << std::dec << L"\n";
        }

        LogError(L"Media Foundation virtual camera registration failed after DirectShow registration succeeded.");
        return S_OK;
    }

    HRESULT RemoveCamera(bool sessionLifetime, bool allUsers, bool unregisterCom)
    {
        RETURN_IF_FAILED(EnsureAdministrativePrivileges(L"remove"));

        ComScope com;
        LogStepResult(L"CoInitialize", com.hr);
        if (FAILED(com.hr))
        {
            return com.hr;
        }

        const HRESULT dshowUnregisterHr = UnregisterDirectShowFilter();
        if (FAILED(dshowUnregisterHr))
        {
            return dshowUnregisterHr;
        }

        MfScope mf;
        LogStepResult(L"MFStartup", mf.hr);
        if (FAILED(mf.hr))
        {
            LogError(L"Media Foundation startup failed during remove. DirectShow registration was still removed.");
            return S_OK;
        }

        HRESULT lastHr = S_OK;
        bool removedAny = false;
        for (const auto& mode : BuildInstallModes(sessionLifetime, allUsers))
        {
            const HRESULT removeHr = RemoveCameraRegistration(mode);
            if (SUCCEEDED(removeHr))
            {
                removedAny = true;
                std::wcout << L"Virtual camera removed (" << mode.label << L").\n";
                continue;
            }

            if (IsMissingCameraResult(removeHr))
            {
                continue;
            }

            lastHr = removeHr;
            std::wcerr
                << L"Remove attempt failed for "
                << mode.label
                << L" with HRESULT 0x"
                << std::hex << static_cast<unsigned long>(removeHr)
                << std::dec << L"\n";
        }

        if (unregisterCom)
        {
            std::filesystem::path dllPath;
            const HRESULT stageHr = EnsureStagedDll(&dllPath);
            LogStepResult(L"Stage MorphlyVirtualCamera.dll", stageHr);
            RETURN_IF_FAILED(stageHr);

            const HRESULT archHr = ValidateArchitecture(dllPath);
            LogStepResult(L"Validate DLL architecture", archHr);
            RETURN_IF_FAILED(archHr);

            const HRESULT unregisterServerHr = InvokeDllEntryPoint(dllPath, "DllUnregisterServer");
            RETURN_IF_FAILED(unregisterServerHr);
        }

        if (removedAny || SUCCEEDED(lastHr))
        {
            std::wcout << L"Virtual camera removal completed.\n";
            return S_OK;
        }

        LogError(L"Media Foundation virtual camera removal failed, but DirectShow registration was removed.");
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
