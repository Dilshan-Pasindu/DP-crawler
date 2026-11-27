/**
 * Explicit, strongly-typed UI actions supported by the shared crawling engine.
 * Adapters must declare capability support before executing any action.
 */
export type UIAction =
  | { readonly type: "invoke" }
  | { readonly type: "setValue"; readonly value: string }
  | { readonly type: "toggle" }
  | { readonly type: "select"; readonly value: string }
  | { readonly type: "expand" }
  | { readonly type: "collapse" }
  | { readonly type: "focus" }
  | { readonly type: "scroll"; readonly direction?: "down" | "up"; readonly amount?: number };

export type UIActionType = UIAction["type"];

/**
 * Returns a deterministic string representation of an action suitable for
 * safety rule matching and canonical signatures.
 */
export function describeAction(action: UIAction): string {
  switch (action.type) {
    case "invoke":
    case "toggle":
    case "expand":
    case "collapse":
    case "focus":
      return action.type;
    case "setValue":
    case "select":
      return `${action.type}:${action.value}`;
    case "scroll":
      return `scroll:${action.direction ?? "down"}`;
  }
}
