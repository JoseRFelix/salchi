import type { RuntimeMode } from "@salchi/contracts";
import {
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";

export const AUTO_REVIEW_MODEL_OPTION_ID = "autoReview";

type AccessOptionConfig = { label: string; description: string; icon: LucideIcon };

export const runtimeModeConfig: Record<RuntimeMode, AccessOptionConfig> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
export const autoReviewAccessConfig = {
  label: "Auto Review",
  description: "Route approval requests to Codex's automatic approval reviewer.",
  icon: ShieldCheckIcon,
} satisfies AccessOptionConfig;

type AccessMenuValue = RuntimeMode | "auto-review";

function isRuntimeMode(value: string | null | undefined): value is RuntimeMode {
  return runtimeModeOptions.includes(value as RuntimeMode);
}

function getAccessMenuValue(props: {
  runtimeMode: RuntimeMode;
  autoReviewAvailable?: boolean | undefined;
  autoReviewEnabled?: boolean | undefined;
}): AccessMenuValue {
  return props.autoReviewAvailable && props.autoReviewEnabled === true
    ? "auto-review"
    : props.runtimeMode;
}

export function ComposerAccessMenuContent(props: {
  runtimeMode: RuntimeMode;
  autoReviewAvailable?: boolean | undefined;
  autoReviewEnabled?: boolean | undefined;
  showDescriptions?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onAutoReviewChange?: ((enabled: boolean) => void) | undefined;
}) {
  return (
    <>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
      <MenuRadioGroup
        value={getAccessMenuValue(props)}
        onValueChange={(value) => {
          if (!value || value === getAccessMenuValue(props)) return;
          if (value === "auto-review") {
            if (props.runtimeMode !== "approval-required") {
              props.onRuntimeModeChange("approval-required");
            }
            props.onAutoReviewChange?.(true);
            return;
          }
          if (!isRuntimeMode(value)) return;
          if (props.autoReviewAvailable && props.autoReviewEnabled === true) {
            props.onAutoReviewChange?.(false);
          }
          if (value !== props.runtimeMode) {
            props.onRuntimeModeChange(value);
          }
        }}
      >
        {runtimeModeOptions.flatMap((mode) => {
          const entries: Array<[AccessMenuValue, AccessOptionConfig]> = [
            [mode, runtimeModeConfig[mode]],
          ];
          if (props.autoReviewAvailable && mode === "full-access") {
            entries.unshift(["auto-review", autoReviewAccessConfig]);
          }
          return entries.map(([value, option]) => {
            const OptionIcon = option.icon;
            return (
              <MenuRadioItem
                key={value}
                value={value}
                className={props.showDescriptions ? "min-w-64 py-2" : undefined}
              >
                {props.showDescriptions ? (
                  <div className="grid min-w-0 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      {option.label}
                    </span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {option.description}
                    </span>
                  </div>
                ) : (
                  option.label
                )}
              </MenuRadioItem>
            );
          });
        })}
      </MenuRadioGroup>
    </>
  );
}
