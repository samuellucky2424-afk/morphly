cmake_minimum_required(VERSION 3.26)

project(MorphlyCam VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "MorphlyCam currently targets Windows only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(TEST_PATTERN_MODE "Build the DirectShow virtual camera in animated test-pattern mode." OFF)


add_library(morphly_common INTERFACE)
target_include_directories(morphly_common INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_definitions(morphly_common INTERFACE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)

set(MORPHLY_DSHOW_BASECLASSES_DIR ${CMAKE_CURRENT_SOURCE_DIR}/baseclasses)

add_library(morphly_dshow_baseclasses STATIC
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/amfilter.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/amvideo.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/combase.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/dllentry.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/dllsetup.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/mtype.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/source.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/winutil.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/wxdebug.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/wxlist.cpp
    ${MORPHLY_DSHOW_BASECLASSES_DIR}/wxutil.cpp
)
target_include_directories(morphly_dshow_baseclasses PUBLIC
    ${MORPHLY_DSHOW_BASECLASSES_DIR}
)
target_compile_definitions(morphly_dshow_baseclasses PUBLIC
    WIN32
    _CRT_SECURE_NO_WARNINGS
)
target_link_libraries(morphly_dshow_baseclasses PUBLIC
    morphly_common
    strmiids
)

add_library(morphly_publisher STATIC
    src/common/morphly_ids.cpp
    src/publisher/morphly_publisher.cpp
)
target_link_libraries(morphly_publisher PUBLIC morphly_common)

add_library(morphly_virtualcam SHARED
    src/common/morphly_ids.cpp
    src/virtualcam/dllmain.cpp
    src/virtualcam/virtual_camera_source.cpp
)
target_link_libraries(morphly_virtualcam PRIVATE
    advapi32
    morphly_dshow_baseclasses
    morphly_common
    ole32
    oleaut32
    shlwapi
    strmiids
    winmm
)
target_include_directories(morphly_virtualcam PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)
if(TEST_PATTERN_MODE)
    target_compile_definitions(morphly_virtualcam PRIVATE TEST_PATTERN_MODE=1)
endif()
set_target_properties(morphly_virtualcam PROPERTIES
    OUTPUT_NAME "MorphlyVirtualCamera"
)
if(MSVC)
    target_link_options(morphly_virtualcam PRIVATE
        "/EXPORT:DllCanUnloadNow,PRIVATE"
        "/EXPORT:DllGetClassObject,PRIVATE"
        "/EXPORT:DllRegisterServer,PRIVATE"
        "/EXPORT:DllUnregisterServer,PRIVATE"
    )
endif()

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
    mf
    mfplat
    mfsensorgroup
    mfuuid
    morphly_common
    ole32
    oleaut32
    strmiids      # DirectShow GUIDs (CLSID_FilterMapper2, CLSID_VideoInputDeviceCategory, MEDIATYPE_Video, …)
    shell32       # ShellExecuteEx (UAC self-elevation)
    advapi32      # AllocateAndInitializeSid / CheckTokenMembership
    shlwapi       # StrStrIW (case-insensitive substring search)
)
add_executable(morphly_cam_feeder
    src/tools/feeder/main.cpp
)
target_link_libraries(morphly_cam_feeder PRIVATE
    advapi32
    morphly_common
    morphly_publisher
)

add_executable(morphly_cam_pipe_publisher
    src/tools/pipe_publisher/main.cpp
)
target_link_libraries(morphly_cam_pipe_publisher PRIVATE
    advapi32
    morphly_common
    morphly_publisher
)
