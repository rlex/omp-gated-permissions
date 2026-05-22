import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tools that require interactive permission by default. */
const DEFAULT_GATED_TOOLS: readonly string[] = [
  "bash",
  "write",
  "edit",
  "debug",
  "browser",
];

/** Maximum characters shown in input preview. */
const MAX_PREVIEW_LEN = 200;

/** Custom type key for persisting session-allow state across session restore. */
const SESSION_ALLOW_ENTRY = "gated-perms:session-allow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate with ellipsis indicator. */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/** Build a short human-readable preview of tool input. */
function previewInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cmd = String(input.command ?? "");
      const envKeys = input.env
        ? Object.keys(input.env as Record<string, string>)
        : [];
      let preview = cmd;
      if (envKeys.length > 0) {
        preview += ` (env: ${envKeys.join(", ")})`;
      }
      return trunc(preview, MAX_PREVIEW_LEN);
    }
    case "write": {
      const path = String(input.path ?? "");
      const contentLen = typeof input.content === "string"
        ? input.content.length
        : 0;
      return trunc(`${path} (${contentLen} chars)`, MAX_PREVIEW_LEN);
    }
    case "edit": {
      const path = String(input.path ?? "");
      return trunc(`path: ${path}`, MAX_PREVIEW_LEN);
    }
    case "debug": {
      const action = String(input.action ?? "");
      return trunc(`action: ${action}`, MAX_PREVIEW_LEN);
    }
    case "browser": {
      const action = String(input.action ?? "");
      const url = String(input.url ?? "");
      return trunc(`${action}${url ? ` ${url}` : ""}`, MAX_PREVIEW_LEN);
    }
    default: {
      // Generic: show first few keys.
      const keys = Object.keys(input);
      const summary = keys
        .slice(0, 3)
        .map((k) => `${k}=${trunc(String(input[k] ?? ""), 50)}`)
        .join(", ");
      return trunc(summary, MAX_PREVIEW_LEN);
    }
  }
}

/** Resolve which tools are gated (env override > defaults). */
function getGatedTools(): readonly string[] {
  const envOverride = process.env["OMP_GATED_TOOLS"];
  if (envOverride) {
    // "bash,write,edit" or "*" for all tools
    if (envOverride === "*") return ["*"];
    return envOverride.split(",").map((s) => s.trim());
  }
  return DEFAULT_GATED_TOOLS;
}

/** Check if a tool name is gated. */
function isGatedTool(toolName: string, gated: readonly string[]): boolean {
  if (gated.includes("*")) return true;
  return gated.includes(toolName);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function gatedPermissions(pi: ExtensionAPI): void {
  pi.setLabel?.("Gated Permissions");

  // Session-scoped allow set: tool names the user has "Always Allow"-ed.
  const sessionAllowSet = new Set<string>();

  const gatedTools = getGatedTools();

  // Restore session-allow state from persisted entries on session start.
  pi.on("session_start", async (_event, ctx) => {
    sessionAllowSet.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === SESSION_ALLOW_ENTRY
      ) {
        const tools: string[] = (entry.data as any)?.tools ?? [];
        for (const t of tools) sessionAllowSet.add(t);
      }
    }
  });

  // Core gate: intercept tool calls.
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;

    // Skip if tool is not in gated list.
    if (!isGatedTool(toolName, gatedTools)) return;

    // Skip if tool was "Always Allow"-ed this session (wildcard "*" matches all).
    if (sessionAllowSet.has(toolName) || sessionAllowSet.has("*")) return;

    // Build preview.
    const input = (event.input ?? {}) as Record<string, unknown>;
    const preview = previewInput(toolName, input);

    // Non-interactive: auto-allow (no UI to prompt).
    if (!ctx.hasUI) return;

    // Present interactive prompt.
    const title = `Permission required: ${toolName}\n\n${preview}`;
    const options = ["Allow", "Always Allow (session)", "Deny"];

    const choice = await ctx.ui.select(title, options);

    // No selection (e.g. dismissed) → treat as Deny.
    if (!choice) {
      return {
        block: true,
        reason: `Tool "${toolName}" denied (no selection).`,
      };
    }

    switch (choice) {
      case "Allow": {
        // Allow this one call; next call of same tool will prompt again.
        return;
      }

      case "Always Allow (session)": {
        // Remember for rest of session and persist to session log.
        sessionAllowSet.add(toolName);
        try {
          pi.appendEntry(SESSION_ALLOW_ENTRY, {
            tools: [...sessionAllowSet],
          });
        } catch {
          // appendEntry may throw if runtime not yet initialized;
          // in-memory set still works for this session.
        }
        ctx.ui.notify?.(`${toolName}: always allowed for this session`, "info");
        return; // Allow this call too.
      }

      case "Deny": {
        return {
          block: true,
          reason: `Tool "${toolName}" denied by user.\nPreview: ${preview}`,
        };
      }

      default: {
        // Unknown choice → deny.
        return {
          block: true,
          reason: `Tool "${toolName}" denied (unrecognized choice).`,
        };
      }
    }
  });

  // Slash command: view or manage session allow list.
  pi.registerCommand("perms", {
    description: "View or manage gated-permission session allow list",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "allow-all") {
        sessionAllowSet.add("*");
        try {
          pi.appendEntry(SESSION_ALLOW_ENTRY, {
            tools: [...sessionAllowSet],
          });
        } catch {}
        ctx.ui.notify?.("All tools allowed for this session", "info");
        return;
      }

      if (sub === "reset" || sub === "clear") {
        sessionAllowSet.clear();
        try {
          pi.appendEntry(SESSION_ALLOW_ENTRY, { tools: [] });
        } catch {}
        ctx.ui.notify?.("Session allow list cleared", "info");
        return;
      }

      if (sub === "list" || sub === "" || sub === "status") {
        if (!ctx.hasUI) {
          // Headless: log state to session entries.
          try {
            pi.appendEntry(SESSION_ALLOW_ENTRY + ":status", {
              gated: [...gatedTools],
              allowed: [...sessionAllowSet],
            });
          } catch {}
          return;
        }

        const gatedStr = gatedTools.includes("*")
          ? "all (*)"
          : gatedTools.join(", ");
        const allowedStr =
          sessionAllowSet.size > 0
            ? sessionAllowSet.values().toArray().join(", ")
            : "(none)";

        ctx.ui.notify?.(
          `Gated: ${gatedStr} | Allowed: ${allowedStr}`,
          "info",
        );
        return;
      }

      // Unknown subcommand.
      ctx.ui.notify?.(
        `Usage: /perms [list|allow-all|reset]\n  list      - show gated & allowed tools\n  allow-all  - allow all gated tools for this session\n  reset      - clear session allow list`,
        "info",
      );
    },
  });
}