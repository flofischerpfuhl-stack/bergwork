# libjpeg-turbo WASM decoder

`jpeg.mjs` and `jpeg.wasm` contain the libjpeg API library from libjpeg-turbo
3.1.2, built without SIMD, tools, tests, shared libraries, or the TurboJPEG API.
The release archive used to build them is:

- https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.2/libjpeg-turbo-3.1.2.tar.gz
- SHA-256: `8f0012234b464ce50890c490f18194f913a7b1f4e6a03d6644179fa0f867d0cf`

Build with the Emscripten version pinned by the repository's `toolchain.json`:

```sh
emcmake cmake -S libjpeg-turbo-3.1.2 -B build \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
  -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF
cmake --build build --target jpeg-static
emcc jpeg_bridge.c build/libjpeg.a -Ibuild -Ilibjpeg-turbo-3.1.2/src -O3 \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH -sSUPPORT_LONGJMP=wasm \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_compositor_jpeg_decode \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -o jpeg.mjs
```

License terms and attribution are in `LICENSE.md` and the repository's
`THIRD_PARTY_NOTICES.md`.
