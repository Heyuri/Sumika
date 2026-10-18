# source this from Git Bash:  . tools/env.sh
# puts the project's own Node (from emsdk) and, once installed, Emscripten on PATH
SUMIKA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$SUMIKA_ROOT/toolchain/emsdk/node/24.19.0_64bit:$SUMIKA_ROOT/toolchain/emsdk/upstream/emscripten:$SUMIKA_ROOT/toolchain/emsdk:$PATH"
export EMSDK="$SUMIKA_ROOT/toolchain/emsdk"
