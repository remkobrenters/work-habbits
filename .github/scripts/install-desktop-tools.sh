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
# Use the same signed Ubuntu sources on hosted runners, regardless of their default mirror.
task_suite=$(awk -F= '$1 == "VERSION_CODENAME" {gsub(/"/, "", $2); print $2}' /etc/os-release)
task_dir=$(mktemp -d)
trap 'rm -r -- "$task_dir"' EXIT
chmod 755 "$task_dir"  # APT reads the mirror list as its unprivileged download user.
printf '%s\tpriority:%s\n' https://archive.ubuntu.com/ubuntu 1 https://mirrors.mit.edu/ubuntu 2 > "$task_dir/mirrors"
cat > "$task_dir/ubuntu.list" <<EOF
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:$task_dir/mirrors $task_suite main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:$task_dir/mirrors $task_suite-updates main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu $task_suite-security main universe
EOF

task_options=(-o "Dir::Etc::sourcelist=$task_dir/ubuntu.list" -o Dir::Etc::sourceparts=-
    -o Acquire::Retries=1 -o Acquire::https::Timeout=20 -o Dpkg::Options::=--force-confold)
task_log="$task_dir/apt.log"

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

run_apt 120s update --error-on=any
run_apt 180s install -y --no-install-recommends "${task_packages[@]}"
