/*
 * Thin command-line wrapper around PS5 Payload Manager's own source handling.
 * verify.mjs compiles it together with Payload Manager's unmodified sources, so
 * every command below runs the same code the console does:
 *
 *   harness add <url>                    sources_add()
 *   harness list                         sources_multi_repository_list_json()
 *   harness install <filename> <source>  sources_multi_repository_install()
 *
 * Results go to stdout; Payload Manager's log lines go to stderr.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>

#include "config.h"
#include "payload_mgr.h"
#include "pldmgr.h"
#include "sources.h"

#define RESPONSE_BUFFER_SIZE 1048576 /* same as http_server.c */

/* ── Stand-ins for console-only parts that source handling calls ── */

void pldmgr_log(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
}

/* Only used for the built-in repository's refresh timestamp */
int config_read_last_update(long *out_ts) {
    *out_ts = 0;
    return 0;
}

int config_write_last_update(long ts) {
    (void)ts;
    return 0;
}

/* The real one also updates the autoload list; every install here starts in an empty folder */
void payload_mgr_remove_old_files(const char *dir_path, const char *new_filename) {
    (void)dir_path;
    (void)new_filename;
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
        rc = sources_multi_repository_install(argv[2], argv[3], "", msg, sizeof(msg));
        puts(msg);
    } else {
        fprintf(stderr, "usage: harness add <url> | list | install <filename> <source_id>\n");
        rc = 2;
    }

    curl_global_cleanup();
    return rc ? 1 : 0;
}
