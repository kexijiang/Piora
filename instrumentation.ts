export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { applyPendingApplicationRestore } = await import("./lib/app-backup");
    await applyPendingApplicationRestore();
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    registerNodeInstrumentation();
  }
}
