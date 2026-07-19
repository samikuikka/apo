export type TaskDefinition<
  TAdapterName extends string = string,
  TDeliverable extends string = string,
> = {
  id: string;
  adapter: TAdapterName;
  description?: string;
  deliverables: TDeliverable[];
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  checks?: string | false;
};

export type TaskConfig<TDeliverable extends string = string> = Omit<
  TaskDefinition<string, TDeliverable>,
  "adapter"
>;

export type FileEntry = {
  relativePath: string;
  absolutePath: string;
};
