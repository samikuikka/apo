import type { TableAction } from "@/components/table";

export const bulkActions: TableAction[] = [
  {
    id: "export",
    label: "Export",
    type: "export",
    confirmMessage: "Export selected traces as JSON?",
  },
  {
    id: "delete",
    label: "Delete",
    type: "delete",
    isDestructive: true,
    confirmMessage: "This will permanently delete the selected traces. Are you sure?",
  },
];
