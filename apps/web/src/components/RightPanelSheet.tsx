import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";
import { isToastPortalDismissalRequest } from "./ui/sheetDismissal";

const RightPanelSheetOpenContext = createContext(true);

export function useRightPanelSheetOpen(): boolean {
  return useContext(RightPanelSheetOpenContext);
}

export function RightPanelSheet(props: {
  children: ReactNode;
  closedChildren?: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  // Route state drops expensive panel content as soon as a gesture closes the
  // controlled sheet. Retain the last open tree until Base UI reports that the
  // exit animation finished, then release its workers and subscriptions.
  const retainedOpenChildrenRef = useRef(props.children);
  const [closeAnimationComplete, setCloseAnimationComplete] = useState(!props.open);

  useLayoutEffect(() => {
    if (!props.open) {
      return;
    }
    retainedOpenChildrenRef.current = props.children;
    setCloseAnimationComplete(false);
  }, [props.children, props.open]);

  const renderedChildren = props.open
    ? props.children
    : closeAnimationComplete
      ? (props.closedChildren ?? null)
      : retainedOpenChildrenRef.current;

  return (
    <Sheet
      modal={false}
      open={props.open}
      onOpenChangeComplete={(open) => {
        if (!open) {
          setCloseAnimationComplete(true);
        }
      }}
      onOpenChange={(open, eventDetails) => {
        if (!open) {
          if (isToastPortalDismissalRequest(eventDetails)) {
            eventDetails.cancel();
            return;
          }

          props.onClose();
        }
      }}
    >
      <SheetPopup
        allowOutsidePointerEvents
        data-right-panel-sheet="true"
        side="right"
        showCloseButton={false}
        showBackdrop={false}
        keepMounted
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        <div className="flex h-full min-h-0 w-full flex-col max-[760px]:pb-safe max-[760px]:pr-safe max-[760px]:pt-safe">
          <RightPanelSheetOpenContext value={props.open}>
            {renderedChildren}
          </RightPanelSheetOpenContext>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
