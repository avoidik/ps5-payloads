/*
 * Runs payloads.json through PS5 Payload Manager's own code: adding the source,
 * parsing it, building the list its web UI reads, and the install-time checks.
 * The *.inc files are extracted from Payload Manager's sources by verify.sh.
 *
 * Usage: check <payloads.json>   (payload files must be in ./files/)
 * Writes source_name.txt, parsed.tsv and list.json for compare.mjs.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "repository.h"
#include "json_helpers.h"
#include "sha256.h"
#include "utils.h"

void pldmgr_utils_get_payload_folder_name(const char *filename, char *out_buf, size_t out_size);

#include "parse.inc"
#include "ext.inc"
#include "safe.inc"

#define RESPONSE_BUFFER_SIZE 1048576

struct Src {
    char id[64];
    char name[256];
};

int main(int argc, char **argv) {
    char *json;
    size_t sz;
    int failures = 0;

    if (argc < 2 || read_file_text(argv[1], &json, &sz) != 0) {
        fprintf(stderr, "cannot read payloads.json\n");
        return 2;
    }

    /* Adding the source: name scan from sources_add, then at least one valid payload */
    char source_name[256] = "";
    const char *url = "https://source.invalid/payloads.json";
    {
#include "namescan.inc"
    }
    RepoPayload *items = NULL;
    size_t count = 0;
    parse_repository_payloads(json, &items, &count);
    printf("add source: name \"%s\", %zu valid payloads\n", source_name, count);
    if (count == 0) failures++;
    FILE *f = fopen("source_name.txt", "w");
    fputs(source_name, f);
    fclose(f);

    /* The list the web UI receives, built the way sources_multi_repository_list_json does */
    char *buf = malloc(RESPONSE_BUFFER_SIZE);
    JsonListBuilder jb = { buf, RESPONSE_BUFFER_SIZE, 0, 1 };
    buf[0] = '\0';
    struct Src src = { "source_1", "" };
    strncpy(src.name, source_name, sizeof(src.name) - 1);
    struct Src *sources = &src;
    int si = 0;
    json_append(&jb, "{\"sources\":[\n  {\"id\":\"%s\",\"name\":\"%s\",\"last_update\":0,\"error\":false,\"payloads\":[\n",
                src.id, src.name);
#include "listitem.inc"
    if (json_append(&jb, "  ]}\n]}\n") != 0) {
        printf("list: does not fit in the %d-byte response buffer\n", RESPONSE_BUFFER_SIZE);
        failures++;
    }
    f = fopen("list.json", "w");
    fwrite(buf, 1, jb.pos, f);
    fclose(f);
    printf("list: %zu of %d bytes\n", jb.pos, RESPONSE_BUFFER_SIZE);

    /* Install checks for every payload, plus a dump of the parsed fields */
    FILE *t = fopen("parsed.tsv", "w");
    for (size_t i = 0; i < count; i++) {
        RepoPayload *it = &items[i];
        char folder[128], path[600], sum[65] = "";

        pldmgr_utils_get_payload_folder_name(it->filename, folder, sizeof(folder));
        snprintf(path, sizeof(path), "files/%s", it->filename);
        size_t first = 0;
        while (strcmp(items[first].filename, it->filename) != 0) first++;

        int safe = is_safe_filename(it->filename);
        int ext = is_supported_extension(it->filename);
        int sum_ok = strlen(it->checksum) == 64 && compute_sha256_file(path, sum) == 0 &&
                     strcasecmp(sum, it->checksum) == 0;
        int ok = safe && ext && first == i && sum_ok;
        if (!ok) failures++;
        printf("install %-24s %s  folder=%s%s%s%s%s\n", it->name, ok ? "ok  " : "FAIL", folder,
               safe ? "" : " unsafe-filename", ext ? "" : " unsupported-extension",
               first == i ? "" : " duplicate-filename", sum_ok ? "" : " checksum-not-verified");

        fprintf(t, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", it->name, it->filename, it->url, it->description,
                it->version, it->category, it->checksum);
    }
    fclose(t);

    return failures ? 1 : 0;
}
