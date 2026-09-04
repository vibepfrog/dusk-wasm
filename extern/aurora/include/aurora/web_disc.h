#ifndef AURORA_WEB_DISC_H
#define AURORA_WEB_DISC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AURORA_WEB_DISC_PATH "/dusk/browser-disc"

bool aurora_web_disc_is_path(const char* path);
int64_t aurora_web_disc_read_at(void* user_data, uint64_t offset, void* out, size_t len);
int64_t aurora_web_disc_length(void* user_data);
void aurora_web_disc_close(void* user_data);

#ifdef __cplusplus
}
#endif

#endif
