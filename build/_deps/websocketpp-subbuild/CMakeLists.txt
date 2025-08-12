# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file Copyright.txt or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION 3.14.0)

# We name the project and the target for the ExternalProject_Add() call
# to something that will highlight to the user what we are working on if
# something goes wrong and an error message is produced.

project(websocketpp-populate NONE)

include(ExternalProject)
ExternalProject_Add(websocketpp-populate
                     "UPDATE_DISCONNECTED" "False" "GIT_REPOSITORY" "https://github.com/zaphoyd/websocketpp.git" "GIT_TAG" "0.8.2"
                    SOURCE_DIR          "/home/deepx/Documents/keenon_mic/build/_deps/websocketpp-src"
                    BINARY_DIR          "/home/deepx/Documents/keenon_mic/build/_deps/websocketpp-build"
                    CONFIGURE_COMMAND   ""
                    BUILD_COMMAND       ""
                    INSTALL_COMMAND     ""
                    TEST_COMMAND        ""
                    USES_TERMINAL_DOWNLOAD  YES
                    USES_TERMINAL_UPDATE    YES
)
