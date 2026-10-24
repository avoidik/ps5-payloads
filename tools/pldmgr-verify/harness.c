/*
 * Thin command-line wrapper around PS5 Payload Manager's own source handling.
 * verify.mjs compiles it together with Payload Manager's unmodified sources, so
 * every command below runs the same code the console does:
 *
 *   harness add <url>                  sources_add()
 *   harness list                       sources_multi_repository_list_json()
 *   harness install <source_url> <id>  sources_repo_install(), into a new slot
 *
 * Results go to stdout; Payload Manager's log lines go to stderr.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>

#include "autoload.h"
#include "config.h"
#include "pldmgr.h"
#include "sources.h"

#define RESPONSE_BUFFER_SIZE 4194304 /* same as http_server.c */

/* ── Stand-ins for console-only parts that source handling calls ── */

void pldmgr_log(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
}

/* Settings: defaults, except custom sources must be switched on to be listed */
void config_read(PldmgrConfig *cfg) {
    memset(cfg, 0, sizeof(*cfg));
    cfg->multi_sources_enabled = 1;
}

int config_read_bool(const char *key, int default_val) {
    (void)key;
    return default_val;
}

int config_write_last_update(long ts) {
    (void)ts;
    return 0;
}

/* Favorites and autoload follow payloads between slots; no such lists exist here */
int pldmgr_favorites_update_entry(const char *old_key, const char *new_key) {
    (void)old_key;
    (void)new_key;
    return 0;
}

int pldmgr_autoload_update_config_entry(const char *old_filename, const char *new_filename) {
    (void)old_filename;
    (void)new_filename;
    return 0;
}

int main(int argc, char **argv) {
    char msg[1024] = "";
    int rc;

    curl_global_init(CURL_GLOBAL_DEFAULT);

    if (argc == 3 && strcmp(argv[1], "add") == 0) {
        rc = sources_add(argv[2], msg, sizeof(msg));
        puts(msg);
    } else if (argc == 2 && strcmp(argv[1], "list") == 0) {
        char *buf = malloc(RESPONSE_BUFFER_SIZE);
        size_t len = sources_multi_repository_list_json(buf, RESPONSE_BUFFER_SIZE, 0);
        fwrite(buf, 1, len, stdout);
        rc = len == 0;
        free(buf);
    } else if (argc == 4 && strcmp(argv[1], "install") == 0) {
        char out[4096] = "";
        rc = sources_repo_install(argv[2], argv[3], "new", NULL, out, sizeof(out));
        puts(out);
    } else {
        fprintf(stderr, "usage: harness add <url> | list | install <source_url> <id>\n");
        rc = 2;
    }

    curl_global_cleanup();
    return rc ? 1 : 0;
}
