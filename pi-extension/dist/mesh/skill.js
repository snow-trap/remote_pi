/**
 * agent-network skill deployment.
 *
 * The packaged `skills/agent-network/SKILL.md` is the single source of truth.
 * Deployment = copy into `~/.pi/remote/skills/agent-network/SKILL.md`, which
 * pi discovers via the extension's `resources_discover` hook. When the mesh
 * is OFF (no `--mesh` flag, never joined manually) the deployed file is
 * REMOVED so an off extension is fully invisible to the agent.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillsDir } from "./paths.js";
/** Extension install root (dist/ or src/ is one level below it). */
function resolveExtensionDir() {
    const here = fileURLToPath(import.meta.url);
    // dist/mesh/skill.js → <root>; src/mesh/skill.ts → <root>
    return dirname(dirname(here));
}
function packagedSkillPath() {
    const root = resolveExtensionDir();
    const src1 = join(root, "skills", "agent-network", "SKILL.md");
    const src2 = join(root, "..", "skills", "agent-network", "SKILL.md");
    if (existsSync(src1))
        return src1;
    if (existsSync(src2))
        return src2;
    return null;
}
/** Copy the packaged skill into the discovered skills dir. Best-effort. */
export function deployAgentNetworkSkill() {
    const src = packagedSkillPath();
    if (!src)
        return;
    const dstDir = join(skillsDir(), "agent-network");
    const dst = join(dstDir, "SKILL.md");
    try {
        mkdirSync(dstDir, { recursive: true });
        copyFileSync(src, dst);
        // Cleanup legacy flat deploy (~/.pi/remote/skills/agent-network.md),
        // which fails the Pi SDK's name-vs-parent-dir validation.
        const legacy = join(skillsDir(), "agent-network.md");
        if (existsSync(legacy)) {
            try {
                unlinkSync(legacy);
            }
            catch { /* ignored */ }
        }
    }
    catch { /* best-effort */ }
}
/** Remove the deployed skill so an off-mode extension is invisible. */
export function undeployAgentNetworkSkill() {
    const dstDir = join(skillsDir(), "agent-network");
    try {
        if (existsSync(dstDir))
            rmSync(dstDir, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
}
//# sourceMappingURL=skill.js.map