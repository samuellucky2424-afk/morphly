cmake_minimum_required(VERSION 3.20)

project(MorphlyUnityCaptureBridge VERSION 1.0.0 LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The UnityCapture bridge is available on Windows only.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(UNITY_CAPTURE_SOURCE_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/UnityCapture/Source"
    CACHE PATH
    "Path to the pinned UnityCapture Source directory"
)

if(NOT EXISTS "${UNITY_CAPTURE_SOURCE_DIR}/shared.inl")
    message(FATAL_ERROR
        "UnityCapture is missing. Run: git submodule update --init --recursive"
    )
endif()

add_subdirectory(
    "${CMAKE_CURRENT_SOURCE_DIR}/../native-camera"
    "${CMAKE_CURRENT_BINARY_DIR}/native-camera"
)

add_executable(morphly_unity_capture_sender
    src/main.cpp
)

target_include_directories(morphly_unity_capture_sender PRIVATE
    "${UNITY_CAPTURE_SOURCE_DIR}"
)

target_link_libraries(morphly_unity_capture_sender PRIVATE
    morphly_publisher
)

target_compile_definitions(morphly_unity_capture_sender PRIVATE
    NOMINMAX
)

set_target_properties(morphly_unity_capture_sender PROPERTIES
    OUTPUT_NAME "morphly_unity_capture_sender"
)
