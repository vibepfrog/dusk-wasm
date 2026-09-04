#include <aurora/web_disc.h>

#include <algorithm>
#include <cstring>
#include <limits>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

namespace {

// Bound every temporary JavaScript ArrayBuffer. The image stays in the
// browser's File object; only the requested range enters the Wasm heap.
constexpr size_t kMaxTemporaryBytes = 4 * 1024 * 1024;

EM_JS(int, aurora_web_disc_read_chunk, (double offset, void* out, int len), {
  var file = globalThis.__duskDiscFile;
  if (!file || typeof FileReaderSync !== 'function' || len < 0 || len > 4194304) {
    return -1;
  }
  try {
    var reader = globalThis.__duskDiscReader;
    if (!reader) reader = globalThis.__duskDiscReader = new FileReaderSync();
    var buffer = reader.readAsArrayBuffer(file.slice(offset, offset + len));
    var bytes = new Uint8Array(buffer);
    HEAPU8.set(bytes, out);
    return bytes.byteLength;
  } catch (error) {
    console.error('[dusk] Browser disc read failed:', error);
    return -1;
  }
});

EM_JS(double, aurora_web_disc_size, (), {
  var file = globalThis.__duskDiscFile;
  return file ? file.size : -1;
});

}  // namespace
#endif

extern "C" {

bool aurora_web_disc_is_path(const char* path) {
  return path != nullptr && std::strcmp(path, AURORA_WEB_DISC_PATH) == 0;
}

int64_t aurora_web_disc_read_at(void*, uint64_t offset, void* out, size_t len) {
#ifdef __EMSCRIPTEN__
  if (out == nullptr && len != 0) {
    return -1;
  }
  if (offset > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    return -1;
  }

  size_t total = 0;
  auto* dst = static_cast<unsigned char*>(out);
  while (total < len) {
    const size_t chunk = std::min(len - total, kMaxTemporaryBytes);
    const int read = aurora_web_disc_read_chunk(
        static_cast<double>(offset + total), dst + total, static_cast<int>(chunk));
    if (read < 0) {
      return -1;
    }
    total += static_cast<size_t>(read);
    if (static_cast<size_t>(read) < chunk) {
      break;
    }
  }
  return static_cast<int64_t>(total);
#else
  (void)offset;
  (void)out;
  (void)len;
  return -1;
#endif
}

int64_t aurora_web_disc_length(void*) {
#ifdef __EMSCRIPTEN__
  const double size = aurora_web_disc_size();
  if (size < 0 || size > static_cast<double>(std::numeric_limits<int64_t>::max())) {
    return -1;
  }
  return static_cast<int64_t>(size);
#else
  return -1;
#endif
}

void aurora_web_disc_close(void*) {}

}  // extern "C"
