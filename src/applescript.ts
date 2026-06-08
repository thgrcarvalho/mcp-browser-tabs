/**
 * AppleScript (Apple Events) control of Google Chrome on macOS.
 *
 * This path is used when the companion extension is NOT connected. It can list
 * tabs and close/activate them, but CANNOT manage tab groups (Chrome's
 * AppleScript dictionary does not expose tab groups at all).
 *
 * SECURITY: AppleScript only ever reads window/tab/title/URL and issues
 * close/activate. It cannot read cookies, sessions, history, or page content —
 * the Chrome scripting dictionary does not expose them. See SECURITY.md.
 *
 * NOTE: These tab IDs are Chrome's AppleScript tab ids, a DIFFERENT id space
 * from chrome.tabs ids used by the extension. They are also NOT stable across
 * browser restarts.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Defense-in-depth: these ids are interpolated into an osascript string.
 * Callers are already Zod-validated, but assert here too so a future caller
 * that bypasses validation can never inject shell/AppleScript metacharacters.
 */
function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: expected an integer, got ${value}`);
  }
}

export interface AppleScriptTab {
  id: number;
  windowId: number;
  title: string;
  url: string;
  isActive: boolean;
  windowIndex: number;
  tabIndex: number;
}

export interface AppleScriptWindow {
  windowId: number;
  windowIndex: number;
  tabs: AppleScriptTab[];
}

/** List all Chrome tabs grouped by window, via AppleScript. */
export async function getChromeTabsWithIds(): Promise<AppleScriptWindow[]> {
  const script = `
    tell application "Google Chrome"
      set windowList to windows
      set output to ""
      repeat with windowIndex from 1 to count of windowList
        set theWindow to item windowIndex of windowList
        set windowID to id of theWindow
        set activeTabIndex to active tab index of theWindow
        set tabList to tabs of theWindow
        repeat with tabIndexInWindow from 1 to count of tabList
          set theTab to item tabIndexInWindow of tabList
          set tabID to id of theTab
          set isActive to (tabIndexInWindow = activeTabIndex)
          set output to output & windowID & "|||" & windowIndex & "|||" & tabID & "|||" & tabIndexInWindow & "|||" & isActive & "|||" & (title of theTab) & "|||" & (URL of theTab) & "\\n"
        end repeat
      end repeat
      return output
    end tell
  `;

  try {
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    const tabsData = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [windowId, windowIndex, tabId, tabIndex, isActive, title, url] = line.split("|||");
        return {
          windowId: Number.parseInt(windowId, 10),
          windowIndex: Number.parseInt(windowIndex, 10),
          tabId: Number.parseInt(tabId, 10),
          tabIndex: Number.parseInt(tabIndex, 10),
          isActive: isActive === "true",
          title: title || "",
          url: url || "",
        };
      });

    const windowMap = new Map<number, AppleScriptWindow>();
    for (const tabData of tabsData) {
      if (!windowMap.has(tabData.windowId)) {
        windowMap.set(tabData.windowId, {
          windowId: tabData.windowId,
          windowIndex: tabData.windowIndex,
          tabs: [],
        });
      }
      windowMap.get(tabData.windowId)!.tabs.push({
        id: tabData.tabId,
        windowId: tabData.windowId,
        title: tabData.title,
        url: tabData.url,
        isActive: tabData.isActive,
        windowIndex: tabData.windowIndex,
        tabIndex: tabData.tabIndex,
      });
    }
    return Array.from(windowMap.values());
  } catch (error) {
    throw new Error(
      `Failed to get Chrome tabs: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Close a tab by its AppleScript tab id. */
export async function closeChromeTabById(tabId: number): Promise<void> {
  assertInteger(tabId, "tabId");
  const script = `
    tell application "Google Chrome"
      set targetTabID to "${tabId}"
      set tabFound to false

      repeat with w in (every window)
        repeat with t in (every tab of w)
          if (id of t) as string = targetTabID then
            close t
            set tabFound to true
            exit repeat
          end if
        end repeat
        if tabFound then exit repeat
      end repeat

      if not tabFound then
        error "Tab with ID " & targetTabID & " not found"
      end if
    end tell
  `;
  try {
    await execAsync(`osascript -e '${script}'`);
  } catch (error) {
    throw new Error(
      `Failed to close Chrome tab with ID ${tabId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Activate (focus) a tab by its AppleScript tab id. */
export async function activateChromeTabById(tabId: number): Promise<void> {
  assertInteger(tabId, "tabId");
  const script = `
    tell application "Google Chrome"
      set targetTabID to "${tabId}"
      set tabFound to false

      repeat with w in (every window)
        repeat with i from 1 to count of (every tab of w)
          set t to item i of (every tab of w)
          if (id of t) as string = targetTabID then
            set (active tab index of w) to i
            set index of w to 1
            set tabFound to true
            exit repeat
          end if
        end repeat
        if tabFound then exit repeat
      end repeat

      if not tabFound then
        error "Tab with ID " & targetTabID & " not found"
      end if
    end tell
  `;
  try {
    await execAsync(`osascript -e '${script}'`);
  } catch (error) {
    throw new Error(
      `Failed to activate Chrome tab with ID ${tabId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Legacy: close a tab by window/tab index (DEPRECATED — fragile). */
export async function closeChromeTabByIndex(windowIndex: number, tabIndex: number): Promise<void> {
  assertInteger(windowIndex, "windowIndex");
  assertInteger(tabIndex, "tabIndex");
  const script = `
    tell application "Google Chrome"
      try
        set targetWindow to window ${windowIndex}
        set targetTab to tab ${tabIndex} of targetWindow
        close targetTab
      on error errMsg
        return "Error: " & errMsg
      end try
    end tell
  `;
  try {
    await execAsync(`osascript -e '${script}'`);
  } catch (error) {
    throw new Error(
      `Failed to close Chrome tab: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
