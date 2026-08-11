/**
 * Fixed UDS session name. The local mesh is single per machine — every Pi
 * process on the host shares this broker.
 */
export declare const LOCAL_SESSION_NAME = "local";
/** Ensures the subdirs exist inside ~/.pi/remote/. */
export declare function ensureGlobalDirs(): void;
/**
 * Local-IPC address for a session's broker. POSIX → a `.sock` file under the
 * session dir; Windows → a per-user named pipe (plan/40). The `net` API treats
 * both the same; only the address string differs.
 */
export declare function sessionSockPath(name: string): string;
/** Path to the audit log for a named session. */
export declare function sessionAuditPath(name: string): string;
export declare function skillsDir(): string;
