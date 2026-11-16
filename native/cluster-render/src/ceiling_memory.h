/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* The upload ceiling remembered across runs (README.md "Upload budget"), so
 * a car whose cluster cannot take the higher levels does not lose the map
 * on every drive while the governor (governor.h) finds its level again.
 *
 * A run is one start of the service: on the unit, one drive. The file
 * (/var/opt/cluster-render/state/upload-ceiling) holds the remembered
 * ceiling, the clean runs at it, and the head unit's firmware and KOMBI
 * variant when it was written:
 *
 *   - A removal the governor counts at cap C lowers the remembered ceiling
 *     to C less one step (the floor at the least), when that is lower, and
 *     starts the clean count over.
 *   - A clean run has a target shown kCleanShownMs in all, and no removal
 *     counted. On the car the KOMBI removed the map 1 to 20 min after the
 *     cap came to a level it could not take, most often within 10.
 *   - After kCleanRuns clean runs at the remembered ceiling, the next run
 *     probes one step above it. Clean, that step is remembered and the
 *     count starts over; with a removal at it, the remembered ceiling stays
 *     and the count starts over; too short to tell, the next run probes
 *     again. A car whose cluster takes no more than the remembered level
 *     loses the map on at most one run in kCleanRuns + 1.
 *   - The run starts at the remembered ceiling or the probe, never above
 *     upload_kb_per_s nor below the floor. Reaching upload_kb_per_s removes
 *     the file: nothing is remembered.
 *   - Another firmware or KOMBI variant than the file names (an update, a
 *     cluster swap) drops it. A value that cannot be read is not compared.
 *   - upload_kb_per_s set in local_conf is the ceiling: the file is neither
 *     used nor changed.
 *
 * The file is read once at start and written (a temporary file renamed
 * over it, opened, written and closed at once) only when its values
 * change, so no descriptor stays open on /var/opt. A read-only or full file
 * system loses the write without a word; any other failure is one warning.
 * A file that is missing, unreadable or malformed is no remembered ceiling.
 * Lines this version does not know are skipped. */
#ifndef CRS_CEILING_MEMORY_H
#define CRS_CEILING_MEMORY_H

#include <stdint.h>
#include <sys/types.h>

#include <string>

namespace crs {

/* What the file holds. */
struct CeilingRecord {
    uint64_t ceiling_kb = 0;   /* 0: none */
    int clean = 0;             /* clean runs at it */
    std::string firmware, kombi;
};

/* False, *out untouched, when the text has no valid ceiling_kb. */
bool parse_ceiling(const std::string &text, CeilingRecord *out);
std::string format_ceiling(const CeilingRecord &r);

/* The calls the file goes through; host tests swap them. */
struct CeilingFileCalls {
    int (*open_file)(const char *path, int flags, mode_t mode);
    ssize_t (*write_file)(int fd, const void *buf, size_t n);
    int (*close_file)(int fd);
    int (*rename_file)(const char *from, const char *to);
    int (*unlink_file)(const char *path);
};
extern CeilingFileCalls ceiling_file_calls;

/* The firmware's name: the first line of etc_dir/os-release-id-dlt, else
 * PRETTY_NAME in etc_dir/os-release; "" when neither is there. */
std::string firmware_id(const std::string &etc_dir);
/* KI_KOMBI_VARIANT in the iDrive 7 coding image at path; "" when it cannot
 * be read or the coding is not valid. */
std::string kombi_variant(const std::string &path);

struct CeilingSettings {
    std::string path;            /* empty: nothing remembered */
    std::string firmware, kombi; /* "" unknown */
    uint64_t max_kb = 5500, floor_kb = 2000, step_kb = 500;
    bool user_set = false;       /* upload_kb_per_s set in local_conf */
};

class CeilingMemory {
public:
    static const int kCleanRuns = 3;
    static const int64_t kCleanShownMs = 10 * 60000;

    /* Reads the file and logs what the run starts at. */
    explicit CeilingMemory(const CeilingSettings &s);

    /* The run's ceiling in KB/s. */
    uint64_t start_kb() const { return start_kb_; }

    /* shown_ms: how long a target was shown since the last call;
     * removal_kb: the governor's removal_level() in KB/s (0: none). */
    void update(int64_t shown_ms, uint64_t removal_kb);

    /* One line for the status. */
    std::string status_text() const;

private:
    void save(const char *why);

    CeilingSettings s_;
    CeilingRecord rec_;
    bool active_ = false;
    bool probe_ = false;
    uint64_t start_kb_ = 0;
    int64_t shown_ms_ = 0;
    uint64_t removal_kb_ = 0;
    bool counted_ = false;   /* this run's outcome is in rec_ */
    bool warned_ = false;
};

}  // namespace crs

#endif
