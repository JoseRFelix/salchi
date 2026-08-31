import type { SidebarProjectSortOrder } from "@salchi/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@salchi/contracts/settings";
import {
  findTranscriptionModel,
  isTranscriptionModel,
  TRANSCRIPTION_MODELS,
} from "@salchi/shared/transcriptionModel";
import { useEffect, useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const PROJECT_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Recent activity",
  created_at: "Recently created",
  manual: "Manual",
};

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  readonly value: number;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  return (
    <Input
      nativeInput
      className="w-20"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      step={1}
      value={draft}
      aria-label="Days of inactivity before auto-settle"
      onChange={(event) => {
        const nextDraft = event.currentTarget.value;
        setDraft(nextDraft);
        const next = Number(nextDraft);
        if (
          Number.isInteger(next) &&
          next >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          next <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(next);
        }
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

export function InboxSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Organization">
        <SettingsRow
          title="Project order"
          description="Choose how projects are ordered in the inbox picker. Manual order can be changed from the picker."
          resetAction={
            settings.sidebarProjectSortOrder !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="project order"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (value === "updated_at" || value === "created_at" || value === "manual") {
                  updateSettings({ sidebarProjectSortOrder: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Project order">
                <SelectValue>{PROJECT_SORT_LABELS[settings.sidebarProjectSortOrder]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(
                  Object.entries(PROJECT_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>
                ).map(([value, label]) => (
                  <SelectItem key={value} hideIndicator value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Lifecycle">
        <SettingsRow
          title="Auto-settle merged threads"
          description="Move threads whose pull request was merged into History. Sending new work brings them back."
          resetAction={
            settings.sidebarAutoSettleOnMerge !==
            DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
              <SettingResetButton
                label="auto-settle merged threads"
                onClick={() =>
                  updateSettings({
                    sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarAutoSettleOnMerge}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
              }
              aria-label="Auto-settle merged threads"
            />
          }
        />

        <SettingsRow
          title="Auto-settle inactive threads"
          description="Move inactive threads without an open pull request into History."
          resetAction={
            settings.sidebarAutoSettleAfterDays !==
            DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
              <SettingResetButton
                label="auto-settle inactive threads"
                onClick={() =>
                  updateSettings({
                    sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              {settings.sidebarAutoSettleAfterDays !== null ? (
                <>
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(value) => updateSettings({ sidebarAutoSettleAfterDays: value })}
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                </>
              ) : null}
              <Switch
                checked={settings.sidebarAutoSettleAfterDays !== null}
                onCheckedChange={(checked) =>
                  updateSettings({
                    sidebarAutoSettleAfterDays: checked
                      ? (DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3)
                      : null,
                  })
                }
                aria-label="Auto-settle inactive threads"
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Confirmations">
        <SettingsRow
          title="Unpin confirmation"
          description="Ask before removing a thread from Pinned."
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="unpin confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="Confirm thread unpinning"
            />
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function WorkspaceSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="New work">
        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Add project starts in"
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Panels">
        <SettingsRow
          title="Auto-open task panel"
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ChatSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const transcriptionModel = findTranscriptionModel(settings.transcriptionModel);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Responses">
        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Input">
        <SettingsRow
          title="Dictation model"
          description={`Runs locally on this server. ${transcriptionModel.label} downloads ${transcriptionModel.downloadSizeLabel} and uses ${transcriptionModel.memorySizeLabel}. Larger models improve accuracy but transcribe more slowly.`}
          resetAction={
            settings.transcriptionModel !== DEFAULT_UNIFIED_SETTINGS.transcriptionModel ? (
              <SettingResetButton
                label="dictation model"
                onClick={() =>
                  updateSettings({
                    transcriptionModel: DEFAULT_UNIFIED_SETTINGS.transcriptionModel,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.transcriptionModel}
              onValueChange={(value) => {
                if (value && isTranscriptionModel(value)) {
                  updateSettings({ transcriptionModel: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Dictation model">
                <SelectValue>
                  {transcriptionModel.label} · {transcriptionModel.downloadSizeLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {TRANSCRIPTION_MODELS.map((model) => (
                  <SelectItem key={model.id} hideIndicator value={model.id}>
                    {model.label} · {model.downloadSizeLabel}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
