cmake_minimum_required(VERSION 3.26)

project(MorphlyCam VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "MorphlyCam currently targets Windows only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

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
    morphly_common
    mf
    mfplat
    mfsensorgroup
    mfuuid
    ole32
    shlwapi
)
set_target_properties(morphly_virtualcam PROPERTIES
    OUTPUT_NAME "MorphlyVirtualCamera"
)
if(MSVC)
    target_link_options(morphly_virtualcam PRIVATE
        "/EXPORT:DllCanUnloadNow"
        "/EXPORT:DllGetClassObject"
        "/EXPORT:DllRegisterServer"
        "/EXPORT:DllUnregisterServer"
    )
endif()

add_executable(morphly_cam_registrar
    src/common/morphly_ids.cpp
    src/tools/registrar/main.cpp
)
target_link_libraries(morphly_cam_registrar PRIVATE
    morphly_common
    mf
    mfplat
    mfsensorgroup
    ole32
)

add_executable(morphly_cam_feeder
    src/tools/feeder/main.cpp
)
target_link_libraries(morphly_cam_feeder PRIVATE
    morphly_common
    morphly_publisher
)

add_executable(morphly_cam_pipe_publisher
    src/tools/pipe_publisher/main.cpp
)
target_link_libraries(morphly_cam_pipe_publisher PRIVATE
    morphly_common
    morphly_publisher
)
