cmake_minimum_required(VERSION 3.10)
project(audio_client)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find required packages
find_package(Boost REQUIRED COMPONENTS system)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
find_package(CURL REQUIRED)

# Include FetchContent for downloading dependencies
include(FetchContent)

# Download and configure websocketpp
FetchContent_Declare(
    websocketpp
    GIT_REPOSITORY https://github.com/zaphoyd/websocketpp.git
    GIT_TAG 0.8.2
)
FetchContent_MakeAvailable(websocketpp)

# Add executables
# add_executable(audio_server server.cpp)
add_executable(audio_uploader main.cpp)
add_executable(speak speak.cpp)
add_executable(tts tts.cpp)

# Link libraries for audio_server
# target_link_libraries(audio_server
#     PRIVATE
#     Threads::Threads
# )

# Link libraries for audio_uploader
target_link_libraries(audio_uploader
    PRIVATE
    Threads::Threads
    OpenSSL::SSL
    OpenSSL::Crypto
    ${Boost_LIBRARIES}
)

# Link libraries for speak
target_link_libraries(speak
    PRIVATE
    Threads::Threads
    OpenSSL::SSL
    OpenSSL::Crypto
    ${Boost_LIBRARIES}
    CURL::libcurl
)

# Link libraries for tts
target_link_libraries(tts
    PRIVATE
    CURL::libcurl
)

# Include directories
target_include_directories(audio_uploader PRIVATE ${websocketpp_SOURCE_DIR})
target_include_directories(speak PRIVATE ${websocketpp_SOURCE_DIR}) 