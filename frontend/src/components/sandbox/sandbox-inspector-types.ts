import type {
  SandboxFieldType,
  SandboxState,
  UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import type { SandboxCommandResult } from "@/components/systems/sandbox/state/commands";
import type { SandboxDesignTarget } from "@/components/systems/sandbox/domain/model";

type SandboxCommand =
  | void
  | SandboxCommandResult<unknown>
  | PromiseLike<SandboxCommandResult<unknown> | void>;

export type SandboxInspectorTargetKind = SandboxDesignTarget["kind"];
export type SandboxInspectorTarget = SandboxDesignTarget;

export interface SandboxInspectorProps {
  /** Render the persistent outline, properties, or both for legacy callers. */
  mode?: "combined" | "outline" | "properties";
  state: SandboxState;
  onRenameDepartment: (departmentId: string, name: string) => SandboxCommand;
  onRenameModule: (moduleId: string, name: string) => SandboxCommand;
  onUpdateField: (
    fieldId: string,
    patch: UpdateSandboxFieldPatch,
  ) => SandboxCommand;
  onUpdateLinkLabel: (linkId: string, label: string) => SandboxCommand;
  onDeleteSelected: (target: SandboxInspectorTarget) => void;
  onAddField: (moduleId: string, type: SandboxFieldType) => void;
  onAddModule: (departmentId: string) => void;
  onAddDepartment: () => void;
  onMoveModule?: (moduleId: string, departmentId: string) => SandboxCommand;
  onSelect: (cellId: string) => void;
  onEdit?: (cellId: string) => void;
  onAddRelationship?: () => void;
  onDuplicate?: (target: SandboxInspectorTarget) => void;
  onToggleLifecycle?: (target: SandboxInspectorTarget) => void;
  pending?: boolean;
}
