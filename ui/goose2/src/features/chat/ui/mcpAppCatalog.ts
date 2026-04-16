import { useEffect, useMemo, useState } from "react";
import { acpGetTools, type AcpToolInfo } from "@/shared/api/acp";

const LEGACY_RESOURCE_URI_META_KEY = "ui/resourceUri";

const sessionToolsPromiseCache = new Map<string, Promise<AcpToolInfo[]>>();
const sessionToolsValueCache = new Map<string, AcpToolInfo[]>();

export type McpAppCatalogEntry = {
  tool: AcpToolInfo;
  extensionName: string;
  resourceUri: string;
  catalogToolName: string;
  canonicalToolName: string;
};

type McpAppCatalogEntryState = {
  status: "idle" | "loading" | "ready";
  entry: McpAppCatalogEntry | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function formatCatalogToolName(toolName: string): string {
  const separatorIndex = toolName.indexOf("__");
  if (separatorIndex === -1) {
    return toolName.replaceAll("_", " ").trim();
  }

  const extension = toolName.slice(0, separatorIndex);
  const tool = toolName.slice(separatorIndex + 2);
  return `${extension.replaceAll("_", " ").trim()}: ${tool.replaceAll("_", " ").trim()}`;
}

function splitOwnedToolName(toolName: string): {
  extensionName: string;
  toolName: string;
} {
  const separatorIndex = toolName.indexOf("__");
  if (separatorIndex === -1) {
    return {
      extensionName: "",
      toolName,
    };
  }

  return {
    extensionName: toolName.slice(0, separatorIndex),
    toolName: toolName.slice(separatorIndex + 2),
  };
}

export function extractToolTitle(toolName: string): string {
  const separatorIndex = toolName.indexOf(":");
  if (separatorIndex === -1) {
    return toolName.trim();
  }

  return toolName.slice(separatorIndex + 1).trim();
}

export function getToolMetaResourceUri(meta: unknown): string | null {
  if (!isRecord(meta)) {
    return null;
  }

  const ui = meta.ui;
  if (
    isRecord(ui) &&
    typeof ui.resourceUri === "string" &&
    ui.resourceUri.length > 0
  ) {
    return ui.resourceUri;
  }

  const legacy = meta[LEGACY_RESOURCE_URI_META_KEY];
  return typeof legacy === "string" && legacy.length > 0 ? legacy : null;
}

export function getToolMetaExtensionName(tool: AcpToolInfo): string | null {
  if (isRecord(tool._meta) && typeof tool._meta.goose_extension === "string") {
    return tool._meta.goose_extension;
  }

  return splitOwnedToolName(tool.name).extensionName || null;
}

function getToolVisibility(meta: unknown): Set<"model" | "app"> {
  if (
    !isRecord(meta) ||
    !isRecord(meta.ui) ||
    !Array.isArray(meta.ui.visibility)
  ) {
    return new Set(["model", "app"]);
  }

  const visibility = meta.ui.visibility.filter(
    (value): value is "model" | "app" => value === "model" || value === "app",
  );

  return visibility.length > 0
    ? new Set(visibility)
    : new Set(["model", "app"]);
}

export function isToolVisibleToApp(tool: AcpToolInfo): boolean {
  return getToolVisibility(tool._meta).has("app");
}

export function getCanonicalToolDisplayName(tool: AcpToolInfo): string {
  return splitOwnedToolName(tool.name).toolName || tool.name;
}

function matchesCatalogToolName(tool: AcpToolInfo, toolName: string): boolean {
  const target = canonicalize(toolName);
  if (!target) {
    return false;
  }

  return (
    canonicalize(tool.name) === target ||
    canonicalize(formatCatalogToolName(tool.name)) === target
  );
}

function buildCatalogEntry(tool: AcpToolInfo): McpAppCatalogEntry | null {
  const resourceUri = getToolMetaResourceUri(tool._meta);
  const extensionName = getToolMetaExtensionName(tool);
  if (!resourceUri || !extensionName) {
    return null;
  }

  return {
    tool,
    extensionName,
    resourceUri,
    catalogToolName: formatCatalogToolName(tool.name),
    canonicalToolName: getCanonicalToolDisplayName(tool),
  };
}

function findMcpAppCatalogEntry(
  tools: AcpToolInfo[],
  toolName: string,
): McpAppCatalogEntry | null {
  for (const tool of tools) {
    if (!matchesCatalogToolName(tool, toolName)) {
      continue;
    }

    return buildCatalogEntry(tool);
  }

  return null;
}

export function getSessionTools(sessionId: string): Promise<AcpToolInfo[]> {
  const cached = sessionToolsPromiseCache.get(sessionId);
  if (cached) {
    return cached;
  }

  const request = acpGetTools(sessionId)
    .then((tools) => {
      sessionToolsValueCache.set(sessionId, tools);
      return tools;
    })
    .catch((error) => {
      sessionToolsPromiseCache.delete(sessionId);
      sessionToolsValueCache.delete(sessionId);
      throw error;
    });

  sessionToolsPromiseCache.set(sessionId, request);
  return request;
}

export function warmSessionToolsCatalog(sessionId: string): void {
  void getSessionTools(sessionId).catch(() => undefined);
}

export function invalidateSessionToolsCache(sessionId: string): void {
  sessionToolsPromiseCache.delete(sessionId);
  sessionToolsValueCache.delete(sessionId);
}

export function getCachedMcpAppCatalogEntry(
  sessionId: string,
  toolName: string,
): McpAppCatalogEntry | null {
  const tools = sessionToolsValueCache.get(sessionId);
  return tools ? findMcpAppCatalogEntry(tools, toolName) : null;
}

export async function resolveMcpAppCatalogEntry(
  sessionId: string,
  toolName: string,
): Promise<McpAppCatalogEntry | null> {
  const tools = await getSessionTools(sessionId);
  return findMcpAppCatalogEntry(tools, toolName);
}

export async function resolveCatalogToolInfo(
  sessionId: string,
  toolName: string,
  extensionName: string | null,
): Promise<AcpToolInfo | null> {
  const tools = await getSessionTools(sessionId);
  const targetTool = canonicalize(toolName);
  const targetExtension = extensionName ? canonicalize(extensionName) : null;

  for (const tool of tools) {
    const catalogExtension = getToolMetaExtensionName(tool);
    if (
      targetExtension &&
      (!catalogExtension ||
        canonicalize(catalogExtension) !== targetExtension)
    ) {
      continue;
    }

    if (canonicalize(getCanonicalToolDisplayName(tool)) !== targetTool) {
      continue;
    }

    return tool;
  }

  return null;
}

function getInitialEntryState(
  sessionId: string | undefined,
  toolName: string | undefined,
  enabled: boolean,
): McpAppCatalogEntryState {
  if (!enabled || !sessionId || !toolName) {
    return {
      status: "idle",
      entry: null,
    };
  }

  const cachedEntry = getCachedMcpAppCatalogEntry(sessionId, toolName);
  if (cachedEntry) {
    return {
      status: "ready",
      entry: cachedEntry,
    };
  }

  return {
    status: "loading",
    entry: null,
  };
}

export function useMcpAppCatalogEntry(
  sessionId: string | undefined,
  toolName: string | undefined,
  enabled = true,
): McpAppCatalogEntryState {
  const initialState = useMemo(
    () => getInitialEntryState(sessionId, toolName, enabled),
    [enabled, sessionId, toolName],
  );
  const [state, setState] = useState<McpAppCatalogEntryState>(initialState);

  useEffect(() => {
    if (!enabled || !sessionId || !toolName) {
      setState({
        status: "idle",
        entry: null,
      });
      return;
    }

    const cachedEntry = getCachedMcpAppCatalogEntry(sessionId, toolName);
    if (cachedEntry) {
      setState({
        status: "ready",
        entry: cachedEntry,
      });
      return;
    }

    let cancelled = false;
    setState({
      status: "loading",
      entry: null,
    });

    void resolveMcpAppCatalogEntry(sessionId, toolName)
      .then((entry) => {
        if (cancelled) {
          return;
        }

        setState({
          status: "ready",
          entry,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            status: "ready",
            entry: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId, toolName]);

  return state;
}

export function useHasMcpAppCatalogEntries(
  sessionId: string | undefined,
  toolNames: string[],
): boolean {
  const normalizedToolNames = useMemo(
    () =>
      toolNames
        .map((toolName) => toolName.trim())
        .filter(Boolean)
        .filter((toolName, index, values) => values.indexOf(toolName) === index),
    [toolNames],
  );
  const [hasEntry, setHasEntry] = useState(() => {
    if (!sessionId) {
      return false;
    }

    return normalizedToolNames.some(
      (toolName) => getCachedMcpAppCatalogEntry(sessionId, toolName) !== null,
    );
  });

  useEffect(() => {
    if (!sessionId || normalizedToolNames.length === 0) {
      setHasEntry(false);
      return;
    }

    const cachedMatch = normalizedToolNames.some(
      (toolName) => getCachedMcpAppCatalogEntry(sessionId, toolName) !== null,
    );
    if (cachedMatch) {
      setHasEntry(true);
      return;
    }

    let cancelled = false;
    setHasEntry(false);

    void Promise.all(
      normalizedToolNames.map((toolName) =>
        resolveMcpAppCatalogEntry(sessionId, toolName),
      ),
    )
      .then((entries) => {
        if (!cancelled) {
          setHasEntry(entries.some((entry) => entry !== null));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasEntry(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedToolNames, sessionId]);

  return hasEntry;
}
