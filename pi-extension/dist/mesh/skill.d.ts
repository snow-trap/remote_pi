/**
 * agent-network skill deployment.
 *
 * The packaged `skills/agent-network/SKILL.md` is the single source of truth.
 * Deployment = copy into `~/.pi/remote/skills/agent-network/SKILL.md`, which
 * pi discovers via the extension's `resources_discover` hook. When the mesh
 * is OFF (no `--mesh` flag, never joined manually) the deployed file is
 * REMOVED so an off extension is fully invisible to the agent.
 */
/** Copy the packaged skill into the discovered skills dir. Best-effort. */
export declare function deployAgentNetworkSkill(): void;
/** Remove the deployed skill so an off-mode extension is invisible. */
export declare function undeployAgentNetworkSkill(): void;
