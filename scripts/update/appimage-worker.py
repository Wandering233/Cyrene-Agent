#!/usr/bin/env python3
"""Own one AppImage transaction after the Electron process exits."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path


def process_start(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except (OSError, IndexError):
        return None


def digest(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha512").hexdigest()


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(file, value):
    temporary = file.with_name(file.name + f".{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    sync_dir(file.parent)


def copy_synced(source, destination):
    with open(source, "rb") as reader:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
        with os.fdopen(fd, "wb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
    os.chmod(destination, stat.S_IMODE(os.stat(source).st_mode))


def regular_owned(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError(f"Not an owned regular file: {file}")


def load_state(file):
    regular_owned(file)
    state = json.loads(file.read_text())
    token = state.get("token", "")
    target = Path(state.get("target", ""))
    directory = target.parent / ("." + target.name + ".cyrene-update")
    if (state.get("schema") != 1 or not target.is_absolute()
            or not re.fullmatch(r"[a-f0-9]{64}", token)
            or file not in (directory / "state.json", directory / ("candidate-" + token + ".json"))):
        raise ValueError("Invalid update journal")
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe update directory")
    for field, prefix in (("stage", "stage-"), ("backup", "backup-")):
        if state.get(field) != str(directory / (prefix + token + ".AppImage")):
            raise ValueError("Invalid transaction path")
    for field in ("oldSha512", "newSha512"):
        if not re.fullmatch(r"[a-f0-9]{128}", state.get(field, "")):
            raise ValueError("Invalid update checksum")
    return state, directory, target


def kill_launch(child):
    if child is None:
        return
    # Only processes launched by this worker receive a new process group.
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=2)
    except ProcessLookupError:
        pass


def launch(target, directory, state, updated):
    env = dict(os.environ)
    for key in ("APPIMAGE", "APPDIR", "ELECTRON_RUN_AS_NODE", "APPIMAGE_EXIT_AFTER_INSTALL",
                "APPIMAGE_SILENT_INSTALL", "CYRENE_UPDATE_TOKEN", "CYRENE_UPDATE_STATE"):
        env.pop(key, None)
    if updated:
        env["CYRENE_UPDATE_TOKEN"] = state["token"]
        env["CYRENE_UPDATE_STATE"] = str(directory / "state.json")
    fd = os.open(directory / "last-launch.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "ab") as output:
        return subprocess.Popen([str(target), *state.get("restartArgs", [])], env=env,
                                stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                start_new_session=True)


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--mode", choices=("install", "rollback", "relaunch"), required=True)
    parser.add_argument("--parent", type=int, required=True)
    parser.add_argument("--parent-start", required=True)
    args = parser.parse_args()
    candidate = Path(args.state)
    state, directory, target = load_state(candidate)
    state_file = directory / "state.json"
    lock = directory / "lock.json"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    lock_stream = os.fdopen(fd, "r+")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    regular_owned(lock)
    lock_stream.seek(0)
    lock_stream.truncate()
    json.dump({"pid": os.getpid(), "start": process_start(os.getpid()), "token": state["token"]}, lock_stream)
    lock_stream.flush()
    os.fsync(fd)
    if args.mode == "install":
        if state_file.exists():
            previous, _, _ = load_state(state_file)
            if previous["phase"] in ("armed", "installed") and digest(target) == previous["newSha512"]:
                raise ValueError("Interrupted update needs recovery before a new install")
            if previous["phase"] != "healthy" and digest(target) == previous["oldSha512"]:
                Path(previous["stage"]).unlink(missing_ok=True)
                Path(previous["backup"]).unlink(missing_ok=True)
        write_json(state_file, state)
        candidate.unlink(missing_ok=True)
    child = None
    committed = False

    def cancelled(_signal, _frame):
        raise RuntimeError("worker interrupted")

    signal.signal(signal.SIGTERM, cancelled)
    try:
        print(json.dumps({"phase": "ready"}), flush=True)
        if sys.stdin.readline().strip() != "install":
            raise RuntimeError("preparation cancelled")
        committed = True
        if args.mode == "install":
            state["phase"] = "armed"
            write_json(state_file, state)
        print(json.dumps({"phase": "armed"}), flush=True)
        deadline = time.monotonic() + 30
        while process_start(args.parent) == args.parent_start:
            if time.monotonic() >= deadline:
                raise RuntimeError("old application did not exit")
            time.sleep(0.1)
        regular_owned(target)
        if args.mode == "relaunch":
            if digest(target) != state["oldSha512"]:
                raise ValueError("current version changed before relaunch")
            state["phase"] = "failed"
            write_json(state_file, state)
            Path(state["stage"]).unlink(missing_ok=True)
            Path(state["backup"]).unlink(missing_ok=True)
            write_json(directory / "result.json", {"result": "failed", "version": state["oldVersion"],
                                                   "reason": "installation worker stopped before application exit"})
            launch(target, directory, state, False)
            return
        regular_owned(Path(state["backup"]))
        if digest(state["backup"]) != state["oldSha512"]:
            raise ValueError("previous version checksum changed")
        if args.mode == "install":
            regular_owned(Path(state["stage"]))
            if digest(target) != state["oldSha512"] or digest(state["stage"]) != state["newSha512"]:
                raise ValueError("installation files changed after preparation")
            os.replace(state["stage"], target)
            sync_dir(target.parent)
            state["phase"] = "installed"
            write_json(state_file, state)
            child = launch(target, directory, state, True)
            deadline = time.monotonic() + state.get("healthTimeoutMs", 90000) / 1000
            health = directory / ("health-" + state["token"] + ".json")
            while True:
                if health.exists():
                    regular_owned(health)
                    result = json.loads(health.read_text())
                    if (result.get("token") == state["token"] and result.get("version") == state["newVersion"]
                            and isinstance(result.get("hostVersion"), str)
                            and re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.-]+)?", result["hostVersion"])):
                        if digest(target) != state["newSha512"]:
                            raise ValueError("installed AppImage checksum changed")
                        retained = directory / ("previous-" + state["token"] + ".AppImage")
                        os.link(state["backup"], retained)
                        os.replace(retained, directory / "previous.AppImage")
                        sync_dir(directory)
                        state["phase"] = "healthy"
                        state["verifiedHostVersion"] = result["hostVersion"]
                        write_json(state_file, state)
                        write_json(directory / "result.json", {"result": "healthy", "version": state["newVersion"],
                                                               "previousVersion": state["oldVersion"], "hostVersion": result["hostVersion"]})
                        Path(state["backup"]).unlink(missing_ok=True)
                        sync_dir(directory)
                        return
                if child.poll() is not None:
                    raise RuntimeError(f"updated application exited: {child.returncode}")
                if time.monotonic() >= deadline:
                    raise RuntimeError("startup health confirmation timed out")
                time.sleep(0.1)
        raise RuntimeError("interrupted installation recovered on next start")
    except Exception as error:
        kill_launch(child)
        # Never overwrite a file that the user replaced independently.
        current = digest(target)
        if current == state["newSha512"] and committed:
            regular_owned(Path(state["backup"]))
            if digest(state["backup"]) != state["oldSha512"]:
                raise ValueError("rollback checksum changed") from error
            # A previous worker may have died while copying its restore file.
            restore = directory / ("restore-" + state["token"] + "-" + secrets.token_hex(8) + ".AppImage")
            copy_synced(state["backup"], restore)
            os.replace(restore, target)
            sync_dir(target.parent)
            retained = directory / ("previous-" + state["token"] + ".AppImage")
            retained.unlink(missing_ok=True)
            os.link(state["backup"], retained)
            os.replace(retained, directory / "previous.AppImage")
            state["phase"] = "rolled_back"
            write_json(state_file, state)
            write_json(directory / "result.json", {"result": "rolled_back", "version": state["oldVersion"],
                                                   "failedVersion": state["newVersion"], "reason": str(error)})
            Path(state["backup"]).unlink(missing_ok=True)
            sync_dir(directory)
            launch(target, directory, state, False)
        else:
            state["phase"] = "failed"
            write_json(state_file, state)
            write_json(directory / "result.json", {"result": "cancelled" if not committed else "failed",
                                                   "version": state["oldVersion"], "reason": str(error)})
            # Preserve recovery material if the current file was changed externally.
            if current == state["oldSha512"]:
                Path(state["stage"]).unlink(missing_ok=True)
                Path(state["backup"]).unlink(missing_ok=True)
                if committed and process_start(args.parent) != args.parent_start:
                    launch(target, directory, state, False)
    finally:
        # Keep the lock inode: replacing/unlinking it would bypass another flock.
        fcntl.flock(fd, fcntl.LOCK_UN)
        lock_stream.close()


if __name__ == "__main__":
    run()
