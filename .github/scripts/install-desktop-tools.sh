#!/usr/bin/env bash
# CI-only dependency setup. Never called by the application or its installer.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l

case ${1:-desktop} in
    desktop) task_packages=(python3-venv python3-gi gir1.2-adw-1 gjs gnome-shell-common libglib2.0-bin nodejs shellcheck) ;;
    gnome50) task_packages=(gjs gir1.2-mutter-18 python3) ;;
    *) printf 'Unknown CI dependency set\n' >&2; exit 2 ;;
esac
task_options=(-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Dpkg::Options::=--force-confold)
task_log=$(mktemp)
trap 'rm -f "$task_log"' EXIT

run_apt() {
    local task_deadline=$1 task_status task_line
    shift
    set +e
    timeout --kill-after=10s "$task_deadline" apt-get "${task_options[@]}" "$@" 2>&1 | tee "$task_log"
    task_status=${PIPESTATUS[0]}
    set -e
    if [[ $task_status -ne 0 ]]; then
        printf '::error::Desktop package setup failed or timed out (exit %s)\n' "$task_status"
        # Public check annotations remain readable even when live logs require login.
        while IFS= read -r task_line; do
            task_line=${task_line//%/%25}
            task_line=${task_line//$'\r'/%0D}
            printf '::notice title=APT diagnostic::%s\n' "$task_line"
        done < <(tail -n 30 "$task_log")
        exit "$task_status"
    fi
}

run_apt 90s update
run_apt 180s install -y --no-install-recommends "${task_packages[@]}"
