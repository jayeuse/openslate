export interface RuntimeStageOptions {
  mode: "native" | "container";
  source: string;
  staging: string;
}

export interface RuntimePackageOptions {
  mode: "native" | "container";
  source: string;
  output: string;
  maxBytes?: number;
}

export function stageRuntime(options: RuntimeStageOptions): void;
export function packageRuntime(options: RuntimePackageOptions): {
  bytes: number;
  output: string;
};
