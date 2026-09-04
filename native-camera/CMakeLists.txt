cmake_minimum_required(VERSION 3.26)

project(MorphlyMediaFoundationCamera VERSION 1.0.0 LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The Morphly Media Foundation camera is available on Windows only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_library(morphly_common INTERFACE)
target_include_directories(morphly_common INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_definitions(morphly_common INTERFACE
    UNICODE
    _UNICODE
    NOMINMAX
)

add_library(morphly_publisher STATIC
    src/common/morphly_ids.cpp
    src/publisher/morphly_publisher.cpp
)
target_link_libraries(morphly_publisher PUBLIC morphly_common advapi32)

add_library(morphly_virtualcam_mf SHARED
    src/common/morphly_ids.cpp
    src/virtualcam/mf_dllmain.cpp
    src/virtualcam/mf_virtual_camera_source.cpp
)
target_link_libraries(morphly_virtualcam_mf PRIVATE
    advapi32
    morphly_common
    mf
    mfplat
    mfsensorgroup
    mfuuid
    ole32
    shlwapi
)
set_target_properties(morphly_virtualcam_mf PROPERTIES
    OUTPUT_NAME "MorphlyVirtualCameraMF"
)
if(MSVC)
    target_link_options(morphly_virtualcam_mf PRIVATE
        "/EXPORT:DllCanUnloadNow,PRIVATE"
        "/EXPORT:DllGetClassObject,PRIVATE"
        "/EXPORT:DllRegisterServer,PRIVATE"
        "/EXPORT:DllUnregisterServer,PRIVATE"
    )
endif()

add_executable(morphly_cam_registrar
    src/common/morphly_ids.cpp
    src/tools/registrar/main.cpp
)
target_link_libraries(morphly_cam_registrar PRIVATE
    advapi32
    mf
    mfplat
    mfreadwrite
    mfsensorgroup
    mfuuid
    morphly_common
    ole32
    oleaut32
    shell32
    shlwapi
    strmiids
)
