import type { SVGProps } from "react";
import type { WorkflowMode } from "@/lib/workflow-types";
import { AliIcon, type AliIconName } from "./AliIcon";

const modeIcons: Record<WorkflowMode, AliIconName> = {
  agent: "sparkles",
  plan: "list-check",
  goal: "target",
};

export function WorkflowModeIcon({ mode, size = 14, ...props }: Omit<SVGProps<SVGSVGElement>, "name"> & {
  mode: WorkflowMode;
  size?: number | string;
}) {
  return <AliIcon name={modeIcons[mode]} size={size} {...props} />;
}
