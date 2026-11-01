// Switching between Scratch and tasks: a tab strip on wide screens, a side curtain on narrow ones.
import { useSignal } from "@preact/signals";
import { t } from "../i18n";
import {
  activeId,
  closeTask,
  deleteRecentTask,
  openTaskIds,
  openTaskReference,
  recentTasks,
  reopenTask,
  switchWorkspace,
  tasksById,
} from "../session";
import { language } from "../settings";
import { localized } from "../tasks/package";
import { SCRATCH_ID, workspaceIdForTask } from "../workspaces";

function useOpenWorkspaces() {
  const lang = language.value;
  return [
    { id: SCRATCH_ID, taskId: null as string | null, title: t("scratch") },
    ...openTaskIds.value.map((taskId) => ({
      id: workspaceIdForTask(taskId),
      taskId: taskId as string | null,
      title: localized(tasksById.value[taskId]?.manifest.title ?? taskId, lang),
    })),
  ];
}

function RecentList({ onPick }: { onPick?(): void }) {
  return (
    <ul class="recent-list">
      {recentTasks.value.map((task) => (
        <li key={task.id}>
          <button
            class="recent-open"
            onClick={() => {
              reopenTask(task.id);
              onPick?.();
            }}
          >
            {task.title}
          </button>
          <button
            class="recent-delete"
            aria-label={t("recentDelete", { title: task.title })}
            title={t("recentDelete", { title: task.title })}
            onClick={() => {
              if (confirm(t("recentDeleteConfirm", { title: task.title }))) deleteRecentTask(task.id);
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function WorkspaceTabs() {
  const workspaces = useOpenWorkspaces();
  if (workspaces.length === 1 && !recentTasks.value.length) return null;
  return (
    <div class="workspace-tabs" role="tablist" aria-label={t("workspaces")}>
      {workspaces.map((workspace) => (
        <div key={workspace.id} class="workspace-tab" data-active={activeId.value === workspace.id}>
          <button role="tab" aria-selected={activeId.value === workspace.id} onClick={() => switchWorkspace(workspace.id)}>
            {workspace.title}
          </button>
          {workspace.taskId && (
            <button
              class="tab-close"
              aria-label={t("closeTab", { title: workspace.title })}
              title={t("closeTab", { title: workspace.title })}
              onClick={() => closeTask(workspace.taskId!)}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {recentTasks.value.length > 0 && (
        <details class="recent-menu">
          <summary>{t("recent")}</summary>
          <div class="recent-popup">
            <RecentList />
          </div>
        </details>
      )}
    </div>
  );
}

export function WorkspaceCurtain({ onClose }: { onClose(): void }) {
  const workspaces = useOpenWorkspaces();
  return (
    <div class="curtain-backdrop" onClick={onClose}>
      <nav class="curtain" aria-label={t("workspaces")} onClick={(event) => event.stopPropagation()}>
        <ul class="curtain-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id} data-active={activeId.value === workspace.id}>
              <button
                class="curtain-item"
                aria-current={activeId.value === workspace.id}
                onClick={() => {
                  switchWorkspace(workspace.id);
                  onClose();
                }}
              >
                {workspace.title}
              </button>
              {workspace.taskId && (
                <button class="recent-delete" aria-label={t("closeTab", { title: workspace.title })} onClick={() => closeTask(workspace.taskId!)}>×</button>
              )}
            </li>
          ))}
        </ul>
        {recentTasks.value.length > 0 && (
          <>
            <h2>{t("recent")}</h2>
            <RecentList onPick={onClose} />
          </>
        )}
      </nav>
    </div>
  );
}

export function OpenTaskDialog({ onClose, onPickFile }: { onClose(): void; onPickFile(): void }) {
  const value = useSignal("");
  const invalid = useSignal(false);
  const submit = (event: Event) => {
    event.preventDefault();
    if (openTaskReference(value.value)) onClose();
    else invalid.value = true;
  };
  return (
    <div class="curtain-backdrop dialog-backdrop" onClick={onClose}>
      <form class="dialog" aria-label={t("openTask")} onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>{t("openTask")}</h2>
        <label>
          {t("openTaskPrompt")}
          <input
            ref={(element) => element?.focus()}
            value={value.value}
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            onInput={(event) => {
              value.value = event.currentTarget.value;
              invalid.value = false;
            }}
          />
        </label>
        {invalid.value && <p class="dialog-error" role="alert">{t("openTaskInvalid")}</p>}
        <div class="dialog-actions">
          <button type="button" onClick={onPickFile}>{t("openTaskFile")}</button>
          <span class="dialog-spacer" />
          <button type="button" onClick={onClose}>{t("cancel")}</button>
          <button class="primary">{t("openTaskSubmit")}</button>
        </div>
      </form>
    </div>
  );
}
