/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "guard.h"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <ctime>
#include <fstream>
#include <sstream>

#include "log.h"

namespace crs {

/* The file:
 *   version <cluster-render's version>
 *   boot <boot id>
 *   <target> <slot> <scene id> <class> <disabled 0|1> <clean boots> <strike,strike,...|->
 */

Guard::Guard() : clock([] { return (int64_t)time(nullptr); })
{
}

std::string Guard::key(const TargetSpec &t)
{
    char b[160];
    std::snprintf(b, sizeof b, "%s 0x%llx 0x%llx %u", t.name.c_str(), (unsigned long long)t.slot,
                  (unsigned long long)t.scene_id, t.content_class);
    return b;
}

void Guard::load(const std::string &path, const std::string &version, const std::string &boot_id)
{
    path_ = path;
    version_ = version;
    boot_ = boot_id;
    m_.clear();
    std::ifstream f(path);
    if (!f)
        return;
    std::string line, word, file_version, file_boot;
    bool bad = false;
    std::map<std::string, Mapping> m;
    while (std::getline(f, line)) {
        std::istringstream in(line);
        if (!(in >> word))
            continue;
        if (word == "version") {
            in >> file_version;
        } else if (word == "boot") {
            in >> file_boot;
        } else {
            std::string slot, scene, klass, strikes;
            Mapping g;
            bad = bad || !(in >> slot >> scene >> klass >> g.disabled >> g.clean_boots >> strikes);
            if (bad)
                break;
            std::istringstream s(strikes == "-" ? "" : strikes);
            for (std::string t; std::getline(s, t, ',');)
                g.strikes.push_back(std::strtoll(t.c_str(), nullptr, 10));
            m[word + " " + slot + " " + scene + " " + klass] = g;
        }
    }
    if (bad) {
        log_warn("guard: %s does not read; starting over", path.c_str());
    } else if (file_version != version) {
        if (!m.empty())
            log_info("guard: %s is cluster-render %s's; starting over for %s", path.c_str(), file_version.c_str(),
                     version.c_str());
    } else {
        m_ = m;
        if (file_boot != boot_id)
            for (auto &kv : m_)
                if (!kv.second.disabled && !kv.second.strikes.empty())
                    kv.second.clean_boots++;
    }
    expire();
    save();
    for (const auto &kv : m_)
        if (kv.second.disabled)
            log_error("guard: %s stays disabled after %zu cluster restarts (cluster-render guard-reset)",
                      kv.first.c_str(), kv.second.strikes.size());
}

void Guard::expire()
{
    const int64_t now = clock();
    for (auto it = m_.begin(); it != m_.end();) {
        Mapping &g = it->second;
        if (!g.disabled) {
            if (g.clean_boots >= kCleanBoots)
                g.strikes.clear();
            g.strikes.erase(std::remove_if(g.strikes.begin(), g.strikes.end(),
                                           [now](int64_t s) { return now - s >= kExpireS; }),
                            g.strikes.end());
        }
        it = g.disabled || !g.strikes.empty() ? std::next(it) : m_.erase(it);
    }
}

bool Guard::disabled(const TargetSpec &t) const
{
    auto it = m_.find(key(t));
    return it != m_.end() && it->second.disabled;
}

bool Guard::strike(const TargetSpec &t, const std::string &after)
{
    expire();
    Mapping &g = m_[key(t)];
    g.strikes.push_back(clock());
    g.clean_boots = 0;
    const int n = (int)g.strikes.size();
    g.disabled = t.strike_limit > 0 && n >= t.strike_limit;
    if (g.disabled)
        log_error("guard: %s disabled at strike %d: the display service went away %s; not asked for again "
                  "until cluster-render's version changes or `cluster-render guard-reset`",
                  key(t).c_str(), n, after.c_str());
    else
        log_warn("guard: %s: strike %d%s: the display service went away %s", key(t).c_str(), n,
                 t.strike_limit > 0 ? (" of " + std::to_string(t.strike_limit)).c_str() : " (never disabled)",
                 after.c_str());
    save();
    return g.disabled;
}

void Guard::reset()
{
    m_.clear();
    save();
    log_info("guard: reset");
}

std::string Guard::status_text() const
{
    std::string s;
    for (const auto &kv : m_)
        s += "guard: " + kv.first + ": " + (kv.second.disabled ? "disabled, " : "") +
             std::to_string(kv.second.strikes.size()) + " strike" + (kv.second.strikes.size() == 1 ? "" : "s") +
             "\n";
    return s;
}

void Guard::save() const
{
    std::string text = "version " + version_ + "\nboot " + boot_ + "\n";
    for (const auto &kv : m_) {
        std::string strikes;
        for (int64_t s : kv.second.strikes)
            strikes += (strikes.empty() ? "" : ",") + std::to_string(s);
        text += kv.first + " " + (kv.second.disabled ? "1 " : "0 ") + std::to_string(kv.second.clean_boots) + " " +
                (strikes.empty() ? "-" : strikes) + "\n";
    }
    const std::string tmp = path_ + ".tmp";
    const int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    const bool whole = fd >= 0 && write(fd, text.data(), text.size()) == (ssize_t)text.size() && fsync(fd) == 0;
    if (fd >= 0)
        close(fd);
    if (!whole || rename(tmp.c_str(), path_.c_str()) != 0) {
        unlink(tmp.c_str());
        log_warn("guard: cannot write %s; the strikes are kept until cluster-render stops", path_.c_str());
    }
}

}  // namespace crs
