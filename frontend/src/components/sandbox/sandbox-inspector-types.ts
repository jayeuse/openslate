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
  state: SandboxState;
  onRenameDepartment: (departmentId: string, name: string) => SandboxCommand;
  onRenameModule: (moduleId: string, name: string) => SandboxCommand;
  onUpdateField: (
    fieldId: string,
    patch: UpdateSandboxFieldPatch,
  ) => SandboxCommand;
  onDeleteSelected: (target: SandboxInspectorTarget) => void;
  onAddField: (moduleId: string, type: SandboxFieldType) => void;
  onAddModule: (departmentId: string) => void;
  onAddDepartment: () => void;
  onSelect: (cellId: string) => void;
  onEdit?: (cellId: string) => void;
  onAddRelationship?: () => void;
  onDuplicate?: (target: SandboxInspectorTarget) => void;
  onToggleLifecycle?: (target: SandboxInspectorTarget) => void;
  lifecycleState?: (target: SandboxInspectorTarget) => {
    closed: boolean;
    canPurge: boolean;
    disabled: boolean;
  };
  onPurge?: (target: SandboxInspectorTarget) => SandboxCommand;
  onEditingChange?: (editing: boolean) => void;
  pending?: boolean;
}
