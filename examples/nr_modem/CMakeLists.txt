# Minimal build description for the NR modem sample (used by build.yaml: compile_commands.json export).
cmake_minimum_required(VERSION 3.16)
project(nr_modem C)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
file(GLOB_RECURSE NR_SRC CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/*.c)
add_library(nr_modem STATIC ${NR_SRC})
target_include_directories(nr_modem PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(nr_modem PUBLIC CONFIG_NR_MU=1 CONFIG_NUM_CORES=4)
