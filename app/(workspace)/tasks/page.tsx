import type { Metadata } from "next";
import { currentActor } from "@/lib/authz";
import { listTasks } from "@/lib/repository";
import { TaskBoard } from "@/components/task-board";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage() {
  const actor = await currentActor();
  return <TaskBoard initialTasks={await listTasks()} canEdit={actor?.role === "admin" || actor?.role === "editor"} />;
}
