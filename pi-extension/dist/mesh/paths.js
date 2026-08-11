import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcAddress } from "./ipc.js";
const HOME_PI_REMOTE = join((process.env["REMOTE_PI_HOME"] || homedir()), ".pi", "remote");
const SESSIONS_DIR = join(HOME_PI_REMOTE, "sessions");
const SKILLS_DIR = join(HOME_PI_REMOTE, "skills");
/**
 * Fixed UDS session name. The local mesh is single per machine — every Pi
 * process on the host shares this broker.
 */
export const LOCAL_SESSION_NAME = "local";
/** Ensures the subdirs exist inside ~/.pi/remote/. */
export function ensureGlobalDirs() {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(SKILLS_DIR, { recursive: true });
}
/**
 * Local-IPC address for a session's broker. POSIX → a `.sock` file under the
 * session dir; Windows → a per-user named pipe (plan/40). The `net` API treats
 * both the same; only the address string differs.
 */
export function sessionSockPath(name) {
    return ipcAddress(`broker-${name}`, join(SESSIONS_DIR, name, "broker.sock"));
}
/** Path to the audit log for a named session. */
export function sessionAuditPath(name) {
    return join(SESSIONS_DIR, name, "audit.jsonl");
}
export function skillsDir() {
    return SKILLS_DIR;
}
//# sourceMappingURL=paths.js.map