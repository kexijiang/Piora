/** Common workspace tools used by the compact coding preset. */
export const BUILTIN_AGENT_TOOLS: readonly string[] = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

/** Explicit phone operations exposed by the Harmony extension. */
export const HARMONY_AGENT_TOOLS: readonly string[] = [
  "harmony_list_devices",
  "harmony_run_scenario",
  "harmony_acquire_control",
  "harmony_observe_screen",
  "harmony_tap",
  "harmony_double_tap",
  "harmony_long_press",
  "harmony_swipe",
  "harmony_fling",
  "harmony_drag",
  "harmony_input_text",
  "harmony_back",
  "harmony_home",
  "harmony_recent_apps",
  "harmony_enter",
  "harmony_launch_app",
  "harmony_wait_for",
  "harmony_wait_until_stable",
  "harmony_wait",
  "harmony_list_processes",
  "harmony_get_raw_logs",
  "harmony_read_logs",
  "harmony_release_control",
];

/** The only Agent tools admitted by the cold-start device-control profile. */
export const DEVICE_CONTROL_AGENT_TOOLS: readonly string[] = [...HARMONY_AGENT_TOOLS, "piora_goal"];

/**
 * Clamp a client-requested tool set to the process profile. Device-control
 * intentionally treats any non-empty UI preset as "enable device control" so
 * existing clients that send the coding preset cannot accidentally disable
 * the only safe tool. An explicit empty preset still disables every tool.
 */
export function resolveAgentToolsForRuntimeProfile(
  profile: "normal" | "device-control",
  requested: readonly string[] | undefined,
): string[] | undefined {
  if (profile === "normal") return requested ? [...requested] : undefined;
  return requested?.length === 0 ? [] : [...DEVICE_CONTROL_AGENT_TOOLS];
}
