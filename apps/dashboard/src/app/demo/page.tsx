import { redirect } from "next/navigation";

/** Shareable demo alias: /demo → the demo tasks page. */
export default function DemoAliasPage() {
  redirect("/project/demo/tasks");
}
