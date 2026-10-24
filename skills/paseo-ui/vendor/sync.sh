#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="${SCRIPT_DIR}/LOCK.json"

if [ ! -f "${LOCK_FILE}" ]; then
  echo "Error: LOCK.json not found in ${SCRIPT_DIR}" >&2
  exit 1
fi

echo "=== Syncing paseo-ui vendor dependencies from LOCK.json ==="

python3 - << 'EOF'
import json, os, subprocess, shutil, tempfile, time

script_dir = os.environ.get("SCRIPT_DIR")
lock_file = os.environ.get("LOCK_FILE")

with open(lock_file, "r") as f:
    lock_data = json.load(f)

vendors = lock_data.get("vendors", {})

# Group by repository to avoid multiple clones
by_repo = {}
for name, meta in vendors.items():
    repo = meta["repo"]
    by_repo.setdefault(repo, []).append((name, meta))

for repo, items in by_repo.items():
    # If all items for this repo are already installed, check if they exist
    needed = False
    for name, meta in items:
        target_sub = meta["targetPath"].replace("vendor/", "")
        target_full = os.path.join(script_dir, target_sub)
        if not os.path.exists(target_full):
            needed = True
            break
    if not needed:
        print(f"\n--> All items for {repo} already present. Skipping clone.")
        continue

    # Special check for /tmp/imp cache for pbakaus/impeccable
    if repo == "pbakaus/impeccable" and os.path.exists("/tmp/imp/.claude/skills/impeccable"):
        print(f"\n--> Reusing local cache /tmp/imp for {repo}...")
        for name, meta in items:
            target_sub = meta["targetPath"].replace("vendor/", "")
            target_full = os.path.join(script_dir, target_sub)
            src_full = "/tmp/imp/.claude/skills/impeccable"
            if os.path.exists(target_full):
                shutil.rmtree(target_full)
            shutil.copytree(src_full, target_full)
            print(f"  ✓ Copied {name} from /tmp/imp to {target_full}")
        continue

    url = f"https://github.com/{repo}.git"
    td = tempfile.mkdtemp()
    print(f"\n--> Fetching {repo}...")
    success = False
    for attempt in range(3):
        try:
            cmd = ["git", "-c", "http.version=HTTP/1.1", "clone", "-q", "--depth", "1", url, td]
            subprocess.run(cmd, check=True)
            success = True
            break
        except subprocess.CalledProcessError as e:
            print(f"  Attempt {attempt+1} failed ({e}), retrying...")
            shutil.rmtree(td, ignore_errors=True)
            td = tempfile.mkdtemp()
            time.sleep(2)

    if not success:
        subprocess.run(["git", "clone", "-q", url, td], check=True)

    try:
        current_head = subprocess.check_output(["git", "-C", td, "rev-parse", "HEAD"]).decode().strip()
        for name, meta in items:
            commit = meta["commit"]
            source_sub = meta["sourcePath"]
            target_sub = meta["targetPath"].replace("vendor/", "")
            target_full = os.path.join(script_dir, target_sub)

            print(f"  [Processing] {commit[:12]} for {name} -> {target_sub}")
            if current_head != commit:
                print(f"    HEAD ({current_head[:12]}) != target ({commit[:12]}), fetching commit...")
                subprocess.run(["git", "-C", td, "fetch", "-q", "--depth", "1", "origin", commit], check=True)
                subprocess.run(["git", "-C", td, "checkout", "-q", commit], check=True)

            src_full = os.path.join(td, source_sub)
            if not os.path.exists(src_full):
                raise RuntimeError(f"Source path {source_sub} does not exist in {repo} at {commit}")

            if os.path.exists(target_full):
                shutil.rmtree(target_full)
            os.makedirs(os.path.dirname(target_full), exist_ok=True)

            if os.path.isdir(src_full):
                shutil.copytree(src_full, target_full)
            else:
                shutil.copy2(src_full, target_full)

            for extra in meta.get("extraPaths", []):
                extra_src = os.path.join(td, extra)
                extra_dst = os.path.join(target_full, os.path.basename(extra))
                if os.path.exists(extra_src):
                    print(f"    + Copying extra path {extra} -> {os.path.basename(extra)}")
                    if os.path.isdir(extra_src):
                        shutil.copytree(extra_src, extra_dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(extra_src, extra_dst)

            print(f"  ✓ Installed {name} to {target_full}")
    finally:
        shutil.rmtree(td, ignore_errors=True)

# Ensure executable bit on scripts if present
for root, dirs, files in os.walk(script_dir):
    for f in files:
        if f in ["impeccable", "sync.sh"] or f.endswith(".sh"):
            p = os.path.join(root, f)
            os.chmod(p, 0o755)

print("\n=== All vendor dependencies synchronized successfully ===")
EOF
