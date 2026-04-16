import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AppBridge,
  PostMessageTransport,
  type JSONRPCRequest,
  type McpUiHostContext,
  type SandboxConfig,
} from "@mcp-ui/client";
import {
  acpCallTool,
  acpListResources,
  acpListPrompts,
  acpListResourceTemplates,
  acpReadResource,
  type AcpCallToolResult,
  type AcpListPromptsResult,
  type AcpListResourceTemplatesResult,
  type AcpReadResourceResponse,
  type AcpToolInfo,
} from "@/shared/api/acp";
import { saveDownloadedFile } from "@/shared/api/system";
import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Button } from "@/shared/ui/button";
import { Collapsible, CollapsibleContent } from "@/shared/ui/collapsible";
import { ToolInput, ToolOutput } from "@/shared/ui/ai-elements/tool";
import type { ToolCallStatus } from "@/shared/types/messages";
import { ChevronDown, Server as ServerIcon } from "lucide-react";
import {
  extractToolTitle,
  getCanonicalToolDisplayName,
  getSessionTools,
  getToolMetaExtensionName,
  isToolVisibleToApp,
  resolveCatalogToolInfo,
  type McpAppCatalogEntry,
} from "./mcpAppCatalog";

const MCP_APP_HOST_DEBUG = import.meta.env.DEV;
const INITIAL_APP_FRAME_HEIGHT = 460;

export const MCP_APP_FRAME_RESIZE_EVENT = "goose2:mcp-app-frame-resize";

type PromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

const resourceCache = new Map<string, Promise<AcpReadResourceResponse>>();

const HOST_APP_INFO = {
  name: "Goose2",
  version: "0.1.0",
} as const;

type AppSandboxCsp = NonNullable<SandboxConfig["csp"]>;
type AppBridgeHostCapabilities = ConstructorParameters<typeof AppBridge>[2];
type AppResourcePermissions = NonNullable<
  NonNullable<AppBridgeHostCapabilities["sandbox"]>["permissions"]
>;
type AppCallToolHandler = NonNullable<AppBridge["oncalltool"]>;
type AppCallToolParams = Parameters<AppCallToolHandler>[0];
type AppToolResult = Awaited<ReturnType<AppCallToolHandler>>;
type AppToolContent = AppToolResult["content"];
type AppListResourcesHandler = NonNullable<AppBridge["onlistresources"]>;
type AppListResourcesResult = Awaited<ReturnType<AppListResourcesHandler>>;
type AppListResourceTemplatesHandler = NonNullable<
  AppBridge["onlistresourcetemplates"]
>;
type AppListResourceTemplatesResult = Awaited<
  ReturnType<AppListResourceTemplatesHandler>
>;
type AppReadResourceHandler = NonNullable<AppBridge["onreadresource"]>;
type AppReadResourceParams = Parameters<AppReadResourceHandler>[0];
type AppReadResourceResult = Awaited<ReturnType<AppReadResourceHandler>>;
type AppListPromptsHandler = NonNullable<AppBridge["onlistprompts"]>;
type AppListPromptsResult = Awaited<ReturnType<AppListPromptsHandler>>;
type AppSizeChangedParams = Parameters<
  NonNullable<AppBridge["onsizechange"]>
>[0];
type AppMessageHandler = NonNullable<AppBridge["onmessage"]>;
type AppMessageParams = Parameters<AppMessageHandler>[0];
type AppMessageResult = Awaited<ReturnType<AppMessageHandler>>;
type AppRequestDisplayModeHandler = NonNullable<
  AppBridge["onrequestdisplaymode"]
>;
type AppRequestDisplayModeResult = Awaited<
  ReturnType<AppRequestDisplayModeHandler>
>;
type AppUpdateModelContextHandler = NonNullable<
  AppBridge["onupdatemodelcontext"]
>;
type AppUpdateModelContextParams = Parameters<AppUpdateModelContextHandler>[0];
type AppDownloadFileHandler = NonNullable<AppBridge["ondownloadfile"]>;
type AppDownloadFileParams = Parameters<AppDownloadFileHandler>[0];
type AppDownloadFileResult = Awaited<ReturnType<AppDownloadFileHandler>>;
type AppDownloadContent = AppDownloadFileParams["contents"][number];
type HostToolDefinition = NonNullable<
  NonNullable<McpUiHostContext["toolInfo"]>["tool"]
>;
type HostStyles = NonNullable<McpUiHostContext["styles"]>;
type SupportedAppTextBlock = Extract<
  NonNullable<AppMessageParams["content"]>[number],
  { type: "text" }
>;

export type McpAppMessageRequest = AppMessageParams;

type AppBridgeFallbackHandler = (
  request: JSONRPCRequest,
  extra?: unknown,
) => Promise<unknown>;

type AppBridgeWithFallback = AppBridge & {
  fallbackRequestHandler?: AppBridgeFallbackHandler;
  onrequestteardown?: () => void;
};

function logMcpAppHost(message: string, details?: unknown): void {
  if (!MCP_APP_HOST_DEBUG) {
    return;
  }

  if (details === undefined) {
    console.debug(`[MCP app host] ${message}`);
    return;
  }

  console.debug(`[MCP app host] ${message}`, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPromptArgument(value: unknown): value is PromptArgument {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.description === undefined ||
      typeof value.description === "string") &&
    (value.required === undefined || typeof value.required === "boolean")
  );
}

function getResourceCsp(meta: unknown): AppSandboxCsp | undefined {
  if (!isRecord(meta) || !isRecord(meta.ui) || !isRecord(meta.ui.csp)) {
    return undefined;
  }

  const csp = meta.ui.csp as Record<string, unknown>;
  return {
    connectDomains: Array.isArray(csp.connectDomains)
      ? csp.connectDomains.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
    resourceDomains: Array.isArray(csp.resourceDomains)
      ? csp.resourceDomains.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
    frameDomains: Array.isArray(csp.frameDomains)
      ? csp.frameDomains.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
    baseUriDomains: Array.isArray(csp.baseUriDomains)
      ? csp.baseUriDomains.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  };
}

function getResourcePermissions(
  meta: unknown,
): AppResourcePermissions | undefined {
  if (!isRecord(meta) || !isRecord(meta.ui) || !isRecord(meta.ui.permissions)) {
    return undefined;
  }

  const permissions = meta.ui.permissions as Record<string, unknown>;

  return {
    camera: permissions.camera !== undefined ? {} : undefined,
    microphone: permissions.microphone !== undefined ? {} : undefined,
    geolocation: permissions.geolocation !== undefined ? {} : undefined,
    clipboardWrite: permissions.clipboardWrite !== undefined ? {} : undefined,
  };
}

function getResourcePrefersBorder(meta: unknown): boolean | undefined {
  return isRecord(meta) && isRecord(meta.ui) && typeof meta.ui.prefersBorder === "boolean"
    ? meta.ui.prefersBorder
    : undefined;
}

function decodeBase64Utf8(value: string): string {
  const bytes = Uint8Array.from(window.atob(value), (char) =>
    char.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function getResourceDocumentHtml(
  resource: AcpReadResourceResponse,
): string | null {
  if (typeof resource.text === "string") {
    return resource.text;
  }

  if (typeof resource.blob === "string") {
    return decodeBase64Utf8(resource.blob);
  }

  return null;
}

function getDefaultFileExtension(mimeType?: string | null): string {
  switch (mimeType) {
    case "text/html":
    case "text/html;profile=mcp-app":
      return ".html";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "text/csv":
      return ".csv";
    default:
      return "";
  }
}

function sanitizeFilenamePart(value: string): string {
  return Array.from(value)
    .map((character) =>
      '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) < 32
        ? "-"
        : character,
    )
    .join("")
    .trim();
}

function getDefaultFilename(uri: string, mimeType?: string | null): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
  const lastSegment = withoutQuery.split("/").pop() ?? withoutQuery;
  const fallbackName = withoutQuery
    .replace(/^ui:\/\//, "")
    .replace(/[:/]+/g, "-");
  const baseName = sanitizeFilenamePart(
    lastSegment || fallbackName || "download",
  );
  const extension = getDefaultFileExtension(mimeType);

  if (extension && !baseName.toLowerCase().endsWith(extension)) {
    return `${baseName}${extension}`;
  }

  return baseName || `download${extension}`;
}

function buildInnerIframeAllowAttribute(
  permissions: AppResourcePermissions | undefined,
): string | undefined {
  if (!permissions) {
    return undefined;
  }

  const granted: string[] = [];
  if (permissions.camera) {
    granted.push("camera");
  }
  if (permissions.microphone) {
    granted.push("microphone");
  }
  if (permissions.geolocation) {
    granted.push("geolocation");
  }
  if (permissions.clipboardWrite) {
    granted.push("clipboard-write");
  }

  return granted.length > 0 ? granted.join("; ") : undefined;
}

function getResourceCacheKey(
  sessionId: string,
  uri: string,
  extensionName: string,
): string {
  return `${sessionId}::${extensionName}::${uri}`;
}

function getResourceHtml(
  sessionId: string,
  uri: string,
  extensionName: string,
): Promise<AcpReadResourceResponse> {
  const cacheKey = getResourceCacheKey(sessionId, uri, extensionName);
  const cached = resourceCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const request = acpReadResource(sessionId, uri, extensionName).catch(
    (error) => {
      resourceCache.delete(cacheKey);
      throw error;
    },
  );
  resourceCache.set(cacheKey, request);
  return request;
}

function getFallbackToolResult(
  resultText?: string,
  isError?: boolean,
): AppToolResult | undefined {
  if (!resultText) {
    return undefined;
  }

  return {
    content: [{ type: "text", text: resultText }] as AppToolContent,
    isError,
  };
}

function getStructuredToolResult(
  rawOutput: unknown,
  resultText?: string,
  isError?: boolean,
): AppToolResult | undefined {
  if (!isRecord(rawOutput) || !Array.isArray(rawOutput.content)) {
    return getFallbackToolResult(resultText, isError);
  }

  const toolResult: AppToolResult = {
    content: rawOutput.content as AppToolContent,
  };

  if (typeof rawOutput.isError === "boolean") {
    toolResult.isError = rawOutput.isError;
  } else if (typeof isError === "boolean") {
    toolResult.isError = isError;
  }

  if (isRecord(rawOutput.structuredContent)) {
    toolResult.structuredContent = rawOutput.structuredContent;
  }

  if (isRecord(rawOutput._meta)) {
    toolResult._meta = rawOutput._meta;
  }

  return toolResult;
}

function normalizeCallToolResult(result: AcpCallToolResult): AppToolResult {
  return {
    content: Array.isArray(result.content)
      ? (result.content as AppToolContent)
      : [],
    isError: result.isError ?? false,
    structuredContent: isRecord(result.structuredContent)
      ? result.structuredContent
      : undefined,
    _meta: isRecord(result._meta) ? result._meta : undefined,
  };
}

function normalizeListResourcesResult(
  result: AcpListResourcesResult,
): AppListResourcesResult {
  return {
    resources: result.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name ?? resource.uri,
      description: resource.description,
      mimeType: resource.mimeType ?? undefined,
      _meta: isRecord(resource._meta) ? resource._meta : undefined,
    })),
    nextCursor: result.nextCursor ?? undefined,
  };
}

function normalizeListResourceTemplatesResult(
  result: AcpListResourceTemplatesResult,
): AppListResourceTemplatesResult {
  return {
    resourceTemplates: result.resourceTemplates.map((resourceTemplate) => ({
      uriTemplate: resourceTemplate.uriTemplate,
      name: resourceTemplate.name,
      title: resourceTemplate.title,
      description: resourceTemplate.description,
      mimeType: resourceTemplate.mimeType ?? undefined,
      _meta: isRecord(resourceTemplate._meta)
        ? resourceTemplate._meta
        : undefined,
    })),
    nextCursor: result.nextCursor ?? undefined,
  };
}

function normalizeListPromptsResult(
  result: AcpListPromptsResult,
): AppListPromptsResult {
  return {
    prompts: result.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: Array.isArray(prompt.arguments)
        ? prompt.arguments.filter(isPromptArgument)
        : undefined,
      _meta: isRecord(prompt._meta) ? prompt._meta : undefined,
    })),
    nextCursor: result.nextCursor ?? undefined,
  };
}

function normalizeListToolsResult(
  tools: AcpToolInfo[],
  extensionName: string | null,
): { tools: HostToolDefinition[] } {
  const targetExtension = extensionName ?? null;

  return {
    tools: tools
      .filter((tool) => {
        const catalogExtension = getToolMetaExtensionName(tool);
        if (targetExtension && catalogExtension !== targetExtension) {
          return false;
        }

        return isToolVisibleToApp(tool);
      })
      .map(
        (tool) =>
          ({
            name: getCanonicalToolDisplayName(tool),
            description: tool.description || "",
            inputSchema:
              (isRecord(tool.inputSchema) &&
              tool.inputSchema.type === "object"
                ? tool.inputSchema
                : null) ?? {
                type: "object",
                properties: {},
                additionalProperties: true,
              },
            _meta: isRecord(tool._meta) ? tool._meta : undefined,
          }) as HostToolDefinition,
      ),
  };
}

function toStartCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getCatalogServerDisplayName(toolName?: string): string | null {
  if (!toolName) {
    return null;
  }

  const separatorIndex = toolName.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const prefix = toolName.slice(0, separatorIndex).trim();
  return prefix.length > 0 ? prefix : null;
}

function getServerDisplayName(
  meta: unknown,
  catalogToolName: string | undefined,
  extensionName: string | null,
): string {
  if (isRecord(meta) && isRecord(meta.server)) {
    if (
      typeof meta.server.title === "string" &&
      meta.server.title.trim().length > 0
    ) {
      return meta.server.title;
    }

    if (
      typeof meta.server.name === "string" &&
      meta.server.name.trim().length > 0
    ) {
      return meta.server.name;
    }
  }

  return (
    getCatalogServerDisplayName(catalogToolName) ??
    (extensionName ? toStartCase(extensionName) : "MCP Server")
  );
}

function getCatalogToolDisplayName(
  tool: AcpToolInfo | null,
  catalogToolName: string | undefined,
  fallbackToolName: string,
): string {
  if (tool) {
    return getCanonicalToolDisplayName(tool);
  }

  if (catalogToolName) {
    return extractToolTitle(catalogToolName);
  }

  return extractToolTitle(fallbackToolName);
}

function getServerIconSrc(meta: unknown): string | null {
  const candidates = [
    meta,
    isRecord(meta) && isRecord(meta.ui) ? meta.ui : null,
    isRecord(meta) && isRecord(meta.server) ? meta.server : null,
  ];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }

    if (typeof candidate.icon === "string" && candidate.icon.length > 0) {
      return candidate.icon;
    }

    if (
      isRecord(candidate.icon) &&
      typeof candidate.icon.src === "string" &&
      candidate.icon.src.length > 0
    ) {
      return candidate.icon.src;
    }

    if (Array.isArray(candidate.icons)) {
      for (const icon of candidate.icons) {
        if (
          isRecord(icon) &&
          typeof icon.src === "string" &&
          icon.src.length > 0
        ) {
          return icon.src;
        }
      }
    }
  }

  return null;
}

function getTextBlocks(
  content?:
    | AppMessageParams["content"]
    | AppUpdateModelContextParams["content"],
): SupportedAppTextBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block) =>
    isRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim()
      ? [{ type: "text", text: block.text }]
      : [],
  );
}

function getUnsupportedContentTypes(
  content?:
    | AppMessageParams["content"]
    | AppUpdateModelContextParams["content"],
): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const unsupportedTypes = new Set<string>();

  for (const block of content) {
    if (!isRecord(block)) {
      unsupportedTypes.add("unknown");
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      continue;
    }

    if (typeof block.type === "string") {
      unsupportedTypes.add(block.type);
    } else {
      unsupportedTypes.add("unknown");
    }
  }

  return [...unsupportedTypes];
}

function inferSchemaForValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: "array",
      items:
        value.length > 0 ? inferSchemaForValue(value[0]) : { type: "string" },
    };
  }

  if (typeof value === "string") {
    return { type: "string" };
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }

  if (typeof value === "boolean") {
    return { type: "boolean" };
  }

  if (isRecord(value)) {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
          key,
          inferSchemaForValue(nestedValue),
        ]),
      ),
      additionalProperties: true,
    };
  }

  return {};
}

function buildFallbackInputSchema(
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const properties = Object.fromEntries(
    Object.entries(toolInput).map(([key, value]) => [
      key,
      inferSchemaForValue(value),
    ]),
  );

  return {
    type: "object",
    properties,
    additionalProperties: true,
  };
}

function buildHostToolDefinition(
  tool: AcpToolInfo | null,
  fallbackToolName: string,
  toolInput: Record<string, unknown>,
): HostToolDefinition {
  return {
    name: tool
      ? getCanonicalToolDisplayName(tool)
      : extractToolTitle(fallbackToolName),
    description: tool?.description ?? "",
    inputSchema:
      (isRecord(tool?.inputSchema) ? tool.inputSchema : null) ??
      buildFallbackInputSchema(toolInput),
    _meta: isRecord(tool?._meta) ? tool._meta : undefined,
  } as HostToolDefinition;
}

type DownloadPayload = {
  defaultFilename: string;
  mimeType?: string | null;
  contentsText?: string | null;
  contentsBase64?: string | null;
};

async function resolveDownloadPayload(
  sessionId: string,
  extensionName: string | null,
  content: AppDownloadContent,
): Promise<DownloadPayload> {
  if (content.type === "resource") {
    const resource = content.resource;
    return {
      defaultFilename: getDefaultFilename(resource.uri, resource.mimeType),
      mimeType: resource.mimeType ?? null,
      contentsText: "text" in resource ? resource.text : null,
      contentsBase64: "blob" in resource ? resource.blob : null,
    };
  }

  if (content.uri.startsWith("ui://")) {
    if (!extensionName) {
      throw new Error("Downloading UI resources requires an extension name");
    }

    const resource = await acpReadResource(
      sessionId,
      content.uri,
      extensionName,
    );
    return {
      defaultFilename: getDefaultFilename(content.uri, resource.mimeType),
      mimeType: resource.mimeType ?? content.mimeType ?? null,
      contentsText: resource.text ?? null,
      contentsBase64: resource.blob ?? null,
    };
  }

  const response = await fetch(content.uri);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch downloadable resource (${response.status} ${response.statusText})`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const mimeType =
    response.headers.get("content-type") ?? content.mimeType ?? null;

  return {
    defaultFilename: getDefaultFilename(content.uri, mimeType),
    mimeType,
    contentsBase64: encodeBase64(bytes),
  };
}

function readCssVariable(
  styles: CSSStyleDeclaration,
  name: string,
  fallback?: string,
): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

function buildHostStyles(): HostStyles | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const sansFont =
    readCssVariable(rootStyles, "--font-sans") ||
    bodyStyles.fontFamily ||
    "system-ui, sans-serif";
  const monoFont =
    readCssVariable(rootStyles, "--font-mono") ??
    "ui-monospace, SFMono-Regular, Menlo, monospace";
  const hairlineShadowColor =
    readCssVariable(rootStyles, "--dark-04") ?? "rgba(26, 26, 26, 0.04)";

  return {
    variables: {
      "--color-background-primary":
        readCssVariable(rootStyles, "--background-default") ?? "#ffffff",
      "--color-background-secondary":
        readCssVariable(rootStyles, "--background-muted") ?? "#f5f5f5",
      "--color-background-tertiary":
        readCssVariable(rootStyles, "--background-alt") ?? "#fafafa",
      "--color-background-inverse":
        readCssVariable(rootStyles, "--background-inverse") ?? "#000000",
      "--color-background-ghost": "transparent",
      "--color-background-info":
        readCssVariable(rootStyles, "--background-info") ?? "#5c98f9",
      "--color-background-danger":
        readCssVariable(rootStyles, "--background-danger") ?? "#f94b4b",
      "--color-background-success":
        readCssVariable(rootStyles, "--background-success") ?? "#91cb80",
      "--color-background-warning":
        readCssVariable(rootStyles, "--background-warning") ?? "#fbcd44",
      "--color-background-disabled":
        readCssVariable(rootStyles, "--background-muted") ?? "#f0f0f0",
      "--color-text-primary":
        readCssVariable(rootStyles, "--text-default") ?? "#1a1a1a",
      "--color-text-secondary":
        readCssVariable(rootStyles, "--text-subtle") ?? "#666666",
      "--color-text-tertiary":
        readCssVariable(rootStyles, "--text-muted") ?? "#999999",
      "--color-text-inverse":
        readCssVariable(rootStyles, "--text-inverse") ?? "#ffffff",
      "--color-text-ghost":
        readCssVariable(rootStyles, "--text-muted") ?? "#999999",
      "--color-text-info":
        readCssVariable(rootStyles, "--text-info") ?? "#5c98f9",
      "--color-text-danger":
        readCssVariable(rootStyles, "--text-danger") ?? "#f94b4b",
      "--color-text-success":
        readCssVariable(rootStyles, "--text-success") ?? "#91cb80",
      "--color-text-warning":
        readCssVariable(rootStyles, "--text-warning") ?? "#fbcd44",
      "--color-text-disabled":
        readCssVariable(rootStyles, "--text-muted") ?? "#999999",
      "--color-border-primary":
        readCssVariable(rootStyles, "--border-default") ?? "#e8e8e8",
      "--color-border-secondary":
        readCssVariable(rootStyles, "--border-input") ?? "#e5e5e5",
      "--color-border-tertiary":
        readCssVariable(rootStyles, "--border-input-hover") ?? "#cccccc",
      "--color-border-inverse":
        readCssVariable(rootStyles, "--border-inverse") ?? "#000000",
      "--color-border-ghost": "transparent",
      "--color-border-info":
        readCssVariable(rootStyles, "--border-info") ?? "#5c98f9",
      "--color-border-danger":
        readCssVariable(rootStyles, "--border-danger") ?? "#f94b4b",
      "--color-border-success":
        readCssVariable(rootStyles, "--border-success") ?? "#91cb80",
      "--color-border-warning":
        readCssVariable(rootStyles, "--border-warning") ?? "#fbcd44",
      "--color-border-disabled":
        readCssVariable(rootStyles, "--border-input") ?? "#e5e5e5",
      "--color-ring-primary":
        readCssVariable(rootStyles, "--ring") ?? "#cccccc",
      "--color-ring-secondary":
        readCssVariable(rootStyles, "--ring") ?? "#cccccc",
      "--color-ring-inverse":
        readCssVariable(rootStyles, "--border-inverse") ?? "#000000",
      "--color-ring-info":
        readCssVariable(rootStyles, "--border-info") ?? "#5c98f9",
      "--color-ring-danger":
        readCssVariable(rootStyles, "--border-danger") ?? "#f94b4b",
      "--color-ring-success":
        readCssVariable(rootStyles, "--border-success") ?? "#91cb80",
      "--color-ring-warning":
        readCssVariable(rootStyles, "--border-warning") ?? "#fbcd44",
      "--font-sans": sansFont,
      "--font-mono": monoFont,
      "--font-weight-normal": "400",
      "--font-weight-medium": "500",
      "--font-weight-semibold": "600",
      "--font-weight-bold": "700",
      "--font-text-xs-size": "0.75rem",
      "--font-text-sm-size": "0.875rem",
      "--font-text-md-size": "1rem",
      "--font-text-lg-size": "1.125rem",
      "--font-heading-xs-size": "1rem",
      "--font-heading-sm-size": "1.125rem",
      "--font-heading-md-size": "1.25rem",
      "--font-heading-lg-size": "1.5rem",
      "--font-heading-xl-size": "1.875rem",
      "--font-heading-2xl-size": "2.25rem",
      "--font-heading-3xl-size": "3rem",
      "--font-text-xs-line-height": "1rem",
      "--font-text-sm-line-height": "1.25rem",
      "--font-text-md-line-height": "1.5rem",
      "--font-text-lg-line-height": "1.75rem",
      "--font-heading-xs-line-height": "1.25rem",
      "--font-heading-sm-line-height": "1.5rem",
      "--font-heading-md-line-height": "1.75rem",
      "--font-heading-lg-line-height": "2rem",
      "--font-heading-xl-line-height": "2.25rem",
      "--font-heading-2xl-line-height": "2.5rem",
      "--font-heading-3xl-line-height": "1",
      "--border-radius-xs": "4px",
      "--border-radius-sm": "8px",
      "--border-radius-md": "12px",
      "--border-radius-lg": "16px",
      "--border-radius-xl": readCssVariable(rootStyles, "--radius") ?? "20px",
      "--border-radius-full": "9999px",
      "--border-width-regular": "1px",
      "--shadow-hairline": `0 0 0 1px ${hairlineShadowColor}`,
      "--shadow-sm":
        readCssVariable(rootStyles, "--shadow-mini") ??
        "0 2px 8px rgba(0,0,0,0.12)",
      "--shadow-md":
        readCssVariable(rootStyles, "--shadow-card") ??
        "0 4px 12px rgba(0,0,0,0.16)",
      "--shadow-lg":
        readCssVariable(rootStyles, "--shadow-modal") ??
        "0 20px 60px rgba(0,0,0,0.2)",
    },
  };
}

interface McpAppViewProps {
  sessionId: string;
  catalogEntry: McpAppCatalogEntry;
  status?: ToolCallStatus;
  toolInput: Record<string, unknown>;
  rawOutput?: unknown;
  resultText?: string;
  isError?: boolean;
  onMessage?: (request: McpAppMessageRequest) => void | Promise<void>;
  onFrameResize?: () => void;
}

export function McpAppView({
  sessionId,
  catalogEntry,
  status,
  toolInput,
  rawOutput,
  resultText,
  isError,
  onMessage,
  onFrameResize,
}: McpAppViewProps) {
  const { resolvedTheme } = useTheme();
  const frameContainerRef = useRef<HTMLDivElement>(null);
  const sandboxFrameRef = useRef<HTMLIFrameElement>(null);
  const teardownRequestedRef = useRef(false);
  const cancelSentRef = useRef(false);
  const sandboxResourceSentRef = useRef(false);
  const toolInputSentRef = useRef(false);
  const toolResultSentRef = useRef(false);
  const pendingInitialFrameHeightRef = useRef<number | null>(null);
  const appInitializedRef = useRef(false);
  const appVisibleRef = useRef(false);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [resourceCsp, setResourceCsp] = useState<AppSandboxCsp | undefined>();
  const [resourcePermissions, setResourcePermissions] = useState<
    AppResourcePermissions | undefined
  >();
  const [resourcePrefersBorder, setResourcePrefersBorder] = useState<
    boolean | undefined
  >();
  const [frameHeight, setFrameHeight] = useState(INITIAL_APP_FRAME_HEIGHT);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [sandboxReady, setSandboxReady] = useState(false);
  const [appInitialized, setAppInitialized] = useState(false);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [appVisible, setAppVisible] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const catalogTool = catalogEntry.tool;
  const activeExtensionName = catalogEntry.extensionName;
  const catalogToolName = catalogEntry.catalogToolName;
  const sdkToolName = catalogEntry.catalogToolName;

  useEffect(() => {
    let cancelled = false;

    teardownRequestedRef.current = false;
    cancelSentRef.current = false;
    sandboxResourceSentRef.current = false;
    toolInputSentRef.current = false;
    toolResultSentRef.current = false;
    pendingInitialFrameHeightRef.current = null;
    setDismissed(false);
    setFrameHeight(INITIAL_APP_FRAME_HEIGHT);
    setSandboxReady(false);
    setAppInitialized(false);
    setBridgeConnected(false);
    setAppVisible(false);
    setDetailsOpen(false);

    setLoading(true);
    setError(null);
    setHtml(null);
    setResourceCsp(undefined);
    setResourcePermissions(undefined);
    setResourcePrefersBorder(undefined);

    void getResourceHtml(
      sessionId,
      catalogEntry.resourceUri,
      catalogEntry.extensionName,
    )
      .then((resource) => {
        if (cancelled) {
          return;
        }

        setResourceCsp(getResourceCsp(resource._meta));
        setResourcePermissions(getResourcePermissions(resource._meta));
        setResourcePrefersBorder(
          getResourcePrefersBorder(resource._meta),
        );
        setHtml(getResourceDocumentHtml(resource));
        setLoading(false);
      })
      .catch((resourceError) => {
        if (cancelled) {
          return;
        }

        setError(
          resourceError instanceof Error
            ? resourceError.message
            : String(resourceError),
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [catalogEntry.extensionName, catalogEntry.resourceUri, sessionId]);

  const shouldRenderFrameBorder = resourcePrefersBorder !== false;
  const sandboxUrl = useMemo(
    () => new URL("/sandbox_proxy.html", window.location.origin),
    [],
  );
  const toolResult = useMemo(
    () => getStructuredToolResult(rawOutput, resultText, isError),
    [isError, rawOutput, resultText],
  );
  const hasToolInput = Object.keys(toolInput).length > 0;
  const hasToolResult = Boolean(toolResult || resultText || isError);

  useEffect(() => {
    const container = frameContainerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateWidth = () => {
      const nextWidth = Math.round(container.getBoundingClientRect().width);
      setContainerWidth((currentWidth) => {
        const normalizedWidth = nextWidth > 0 ? nextWidth : null;
        return currentWidth === normalizedWidth
          ? currentWidth
          : normalizedWidth;
      });
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  const hostTool = useMemo(
    () => buildHostToolDefinition(catalogTool, sdkToolName, toolInput),
    [catalogTool, sdkToolName, toolInput],
  );
  const serverDisplayName = useMemo(
    () =>
      getServerDisplayName(
        catalogTool?._meta,
        catalogToolName,
        activeExtensionName,
      ),
    [activeExtensionName, catalogTool?._meta, catalogToolName],
  );
  const catalogToolDisplayName = useMemo(
    () => getCatalogToolDisplayName(catalogTool, catalogToolName, sdkToolName),
    [catalogTool, catalogToolName, sdkToolName],
  );
  const serverIconSrc = useMemo(
    () => getServerIconSrc(catalogTool?._meta),
    [catalogTool?._meta],
  );
  const appResultOutput = (rawOutput ?? resultText) as
    | ComponentProps<typeof ToolOutput>["output"]
    | undefined;

  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      toolInfo: {
        tool: hostTool,
      },
      theme: resolvedTheme,
      styles: buildHostStyles(),
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions:
        containerWidth != null
          ? {
              width: containerWidth,
              height: frameHeight,
            }
          : {
              height: frameHeight,
            },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: navigator.userAgent,
      platform: "desktop",
      deviceCapabilities: {
        touch: navigator.maxTouchPoints > 0,
        hover: window.matchMedia("(hover: hover)").matches,
      },
      safeAreaInsets: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
    }),
    [containerWidth, frameHeight, hostTool, resolvedTheme],
  );

  const hostCapabilities = useMemo<AppBridgeHostCapabilities>(
    () => ({
      openLinks: {},
      serverTools: {
        listChanged: false,
      },
      serverResources: {
        listChanged: false,
      },
      logging: {},
      downloadFile: {},
      sandbox: {
        permissions: resourcePermissions,
        csp: resourceCsp,
      },
      message: {
        text: {},
      },
      updateModelContext: {
        text: {},
        structuredContent: {},
      },
    }),
    [resourceCsp, resourcePermissions],
  );

  const bridgeHostContextRef = useRef<McpUiHostContext>(hostContext);
  bridgeHostContextRef.current = hostContext;
  const bridge = useMemo(
    () =>
      new AppBridge(null, HOST_APP_INFO, hostCapabilities, {
        hostContext: bridgeHostContextRef.current,
      }),
    [hostCapabilities],
  );

  const handleOpenLink = useCallback(async ({ url }: { url: string }) => {
    await openUrl(url);
    return {};
  }, []);

  const handleMessage = useCallback<AppMessageHandler>(
    async (params): Promise<AppMessageResult> => {
      if (params.role !== "user") {
        throw new Error(`Unsupported MCP app message role: ${params.role}`);
      }

      const unsupportedContentTypes = getUnsupportedContentTypes(
        params.content,
      );
      if (unsupportedContentTypes.length > 0) {
        throw new Error(
          `MCP app message included unsupported content types: ${unsupportedContentTypes.join(", ")}`,
        );
      }

      const textBlocks = getTextBlocks(params.content);
      if (textBlocks.length === 0) {
        throw new Error("MCP app message did not include a text content block");
      }

      await onMessage?.({
        ...params,
        content: textBlocks,
      });
      return {};
    },
    [onMessage],
  );

  const handleCallTool = useCallback<AppCallToolHandler>(
    async ({ name, arguments: args }: AppCallToolParams) => {
      if (!activeExtensionName) {
        throw new Error("MCP app tool calls require an extension name");
      }

      const tool = await resolveCatalogToolInfo(
        sessionId,
        name,
        activeExtensionName,
      );

      if (tool && !isToolVisibleToApp(tool)) {
        throw new Error(`Tool "${name}" is not available to this app`);
      }

      return normalizeCallToolResult(
        await acpCallTool(
          sessionId,
          activeExtensionName,
          tool ? getCanonicalToolDisplayName(tool) : name,
          args ?? {},
        ),
      );
    },
    [activeExtensionName, sessionId],
  );

  const handleListResources = useCallback<AppListResourcesHandler>(async () => {
    if (!activeExtensionName) {
      return { resources: [] };
    }

    return normalizeListResourcesResult(
      await acpListResources(sessionId, activeExtensionName),
    );
  }, [activeExtensionName, sessionId]);

  const handleListResourceTemplates =
    useCallback<AppListResourceTemplatesHandler>(async () => {
      if (!activeExtensionName) {
        return { resourceTemplates: [] };
      }

      return normalizeListResourceTemplatesResult(
        await acpListResourceTemplates(sessionId, activeExtensionName),
      );
    }, [activeExtensionName, sessionId]);

  const handleReadResource = useCallback<AppReadResourceHandler>(
    async ({ uri }: AppReadResourceParams): Promise<AppReadResourceResult> => {
      if (!activeExtensionName) {
        throw new Error("MCP app resource reads require an extension name");
      }

      const resource = await acpReadResource(
        sessionId,
        uri,
        activeExtensionName,
      );
      return {
        contents: [
          typeof resource.text === "string"
            ? {
                uri: resource.uri,
                text: resource.text,
                mimeType: resource.mimeType ?? undefined,
                _meta: resource._meta ?? undefined,
              }
            : {
                uri: resource.uri,
                blob: resource.blob ?? "",
                mimeType: resource.mimeType ?? undefined,
                _meta: resource._meta ?? undefined,
              },
        ],
      };
    },
    [activeExtensionName, sessionId],
  );

  const handleListPrompts = useCallback<AppListPromptsHandler>(async () => {
    if (!activeExtensionName) {
      return { prompts: [] };
    }

    return normalizeListPromptsResult(
      await acpListPrompts(sessionId, activeExtensionName),
    );
  }, [activeExtensionName, sessionId]);

  const handleRequestDisplayMode = useCallback<AppRequestDisplayModeHandler>(
    async (): Promise<AppRequestDisplayModeResult> => ({
      mode: "inline",
    }),
    [],
  );

  const handleUpdateModelContext = useCallback<AppUpdateModelContextHandler>(
    async (
      params: AppUpdateModelContextParams,
    ): Promise<Record<string, never>> => {
      const unsupportedContentTypes = getUnsupportedContentTypes(
        params.content,
      );
      if (unsupportedContentTypes.length > 0) {
        throw new Error(
          `MCP app model context included unsupported content types: ${unsupportedContentTypes.join(", ")}`,
        );
      }

      return {};
    },
    [],
  );

  const handleDownloadFile = useCallback<AppDownloadFileHandler>(
    async ({
      contents,
    }: AppDownloadFileParams): Promise<AppDownloadFileResult> => {
      let savedCount = 0;

      for (const content of contents) {
        const payload = await resolveDownloadPayload(
          sessionId,
          activeExtensionName,
          content,
        );

        const savedPath = await saveDownloadedFile(payload);
        if (savedPath) {
          savedCount += 1;
        }
      }

      return savedCount > 0 ? {} : { isError: true };
    },
    [activeExtensionName, sessionId],
  );

  const handleFallbackRequest = useCallback(
    async (request: JSONRPCRequest) => {
      if (request.method === "tools/list") {
        const tools = await getSessionTools(sessionId);
        return normalizeListToolsResult(tools, activeExtensionName);
      }

      if (request.method === "ui/get-context") {
        return hostContext as Record<string, unknown>;
      }

      if (request.method === "ping") {
        return {};
      }

      if (request.method === "x/clipboard/write") {
        const text =
          isRecord(request.params) && typeof request.params.text === "string"
            ? request.params.text
            : null;

        if (!text) {
          throw new Error("Clipboard write request did not include text");
        }

        await navigator.clipboard.writeText(text);
        return { success: true };
      }

      throw new Error(`Unhandled JSON-RPC method: ${request.method}`);
    },
    [activeExtensionName, hostContext, sessionId],
  );

  const handleLoggingMessage = useCallback(
    (params: { level?: string; logger?: string; data?: unknown }) => {
      console.debug("[MCP app]", sdkToolName, params.level ?? "info", params);
    },
    [sdkToolName],
  );

  const handleSizeChanged = useCallback(({ height }: AppSizeChangedParams) => {
    if (typeof height === "number" && Number.isFinite(height) && height > 0) {
      const nextHeight = Math.max(Math.round(height), 260);

      if (!appInitializedRef.current || !appVisibleRef.current) {
        pendingInitialFrameHeightRef.current = nextHeight;
        return;
      }

      setFrameHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    }
  }, []);

  useEffect(() => {
    appInitializedRef.current = appInitialized;
  }, [appInitialized]);

  useEffect(() => {
    appVisibleRef.current = appVisible;
  }, [appVisible]);

  useEffect(() => {
    bridge.onopenlink = handleOpenLink;
    bridge.onmessage = handleMessage;
    bridge.oncalltool = handleCallTool;
    bridge.ondownloadfile = handleDownloadFile;
    bridge.onlistresources = handleListResources;
    bridge.onlistresourcetemplates = handleListResourceTemplates;
    bridge.onreadresource = handleReadResource;
    bridge.onlistprompts = handleListPrompts;
    bridge.onrequestdisplaymode = handleRequestDisplayMode;
    bridge.onupdatemodelcontext = handleUpdateModelContext;
    bridge.onloggingmessage = handleLoggingMessage;
    (bridge as AppBridgeWithFallback).onrequestteardown = () => {
      if (teardownRequestedRef.current) {
        return;
      }

      teardownRequestedRef.current = true;
      void bridge
        .teardownResource({})
        .catch((teardownError) => {
          setError(
            teardownError instanceof Error
              ? teardownError.message
              : String(teardownError),
          );
        })
        .finally(() => {
          setDismissed(true);
        });
    };
    (bridge as AppBridgeWithFallback).fallbackRequestHandler =
      handleFallbackRequest;
  }, [
    bridge,
    handleCallTool,
    handleDownloadFile,
    handleFallbackRequest,
    handleListPrompts,
    handleListResourceTemplates,
    handleListResources,
    handleLoggingMessage,
    handleMessage,
    handleOpenLink,
    handleReadResource,
    handleRequestDisplayMode,
    handleUpdateModelContext,
  ]);

  const sandboxUrlWithCsp = useMemo(() => {
    const url = new URL(sandboxUrl);
    if (resourceCsp) {
      url.searchParams.set("csp", JSON.stringify(resourceCsp));
    } else {
      url.searchParams.delete("csp");
    }
    return url.toString();
  }, [resourceCsp, sandboxUrl]);

  const hostContextSignature = useMemo(
    () => JSON.stringify(hostContext),
    [hostContext],
  );
  const lastSentHostContextSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!html || !sandboxReady || !bridgeConnected || !appInitialized) {
      setAppVisible(false);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      setAppVisible(true);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [appInitialized, bridgeConnected, html, sandboxReady]);

  useEffect(() => {
    if (!appVisible) {
      return;
    }

    const pendingInitialHeight = pendingInitialFrameHeightRef.current;
    if (pendingInitialHeight === null) {
      return;
    }

    pendingInitialFrameHeightRef.current = null;
    setFrameHeight((currentHeight) =>
      currentHeight === pendingInitialHeight
        ? currentHeight
        : pendingInitialHeight,
    );
  }, [appVisible]);

  useEffect(() => {
    if (!appVisible || loading || !html) {
      return;
    }

    onFrameResize?.();
    window.dispatchEvent(
      new CustomEvent(MCP_APP_FRAME_RESIZE_EVENT, {
        detail: {
          sessionId,
          toolName: sdkToolName,
          height: frameHeight,
        },
      }),
    );
  }, [
    appVisible,
    frameHeight,
    html,
    loading,
    onFrameResize,
    sdkToolName,
    sessionId,
  ]);

  useEffect(() => {
    if (!appInitialized) {
      return;
    }

    if (lastSentHostContextSignatureRef.current === hostContextSignature) {
      return;
    }

    lastSentHostContextSignatureRef.current = hostContextSignature;
    bridge.setHostContext(hostContext);
  }, [appInitialized, bridge, hostContext, hostContextSignature]);

  useEffect(() => {
    const iframe = sandboxFrameRef.current;
    const frameWindow = iframe?.contentWindow;

    if (!iframe || !frameWindow || !html) {
      return;
    }

    let cancelled = false;
    setSandboxReady(false);
    setAppInitialized(false);
    setBridgeConnected(false);

    bridge.oninitialized = () => {
      logMcpAppHost("app initialized", {
        sessionId,
        toolName: sdkToolName,
      });
      if (!cancelled) {
        setAppInitialized(true);
      }
    };

    bridge.onsizechange = (params) => {
      if (!cancelled) {
        handleSizeChanged(params);
      }
    };

    void bridge
      .connect(new PostMessageTransport(frameWindow, frameWindow))
      .then(() => {
        if (!cancelled) {
          setBridgeConnected(true);
        }
      })
      .catch((connectionError) => {
        if (!cancelled) {
          setError(
            connectionError instanceof Error
              ? connectionError.message
              : String(connectionError),
          );
        }
      });

    return () => {
      cancelled = true;
      setSandboxReady(false);
      setAppInitialized(false);
      setBridgeConnected(false);
      void bridge.close().catch(() => undefined);
    };
  }, [bridge, handleSizeChanged, html, sdkToolName, sessionId]);

  useEffect(() => {
    if (
      !sandboxReady ||
      !bridgeConnected ||
      !html ||
      sandboxResourceSentRef.current
    ) {
      return;
    }

    sandboxResourceSentRef.current = true;
    void bridge
      .sendSandboxResourceReady({
        html,
        sandbox: "allow-scripts allow-same-origin",
        csp: resourceCsp,
        permissions: resourcePermissions,
      })
      .catch((sandboxError) => {
        sandboxResourceSentRef.current = false;
        setError(
          sandboxError instanceof Error
            ? sandboxError.message
            : String(sandboxError),
        );
      });
  }, [
    bridge,
    bridgeConnected,
    html,
    resourceCsp,
    resourcePermissions,
    sandboxReady,
  ]);

  useEffect(() => {
    if (!appInitialized || toolInputSentRef.current) {
      return;
    }

    toolInputSentRef.current = true;
    void bridge.sendToolInput({ arguments: toolInput });
  }, [appInitialized, bridge, toolInput]);

  useEffect(() => {
    if (!appInitialized || !toolResult || toolResultSentRef.current) {
      return;
    }

    toolResultSentRef.current = true;
    void bridge.sendToolResult(toolResult);
  }, [appInitialized, bridge, toolResult]);

  useEffect(() => {
    if (!appInitialized || status !== "stopped" || cancelSentRef.current) {
      return;
    }

    cancelSentRef.current = true;
    void bridge.sendToolCancelled({
      reason: "The MCP app host cancelled the active tool operation.",
    });
  }, [appInitialized, bridge, status]);

  useEffect(() => {
    return () => {
      if (!appInitialized || teardownRequestedRef.current) {
        return;
      }

      teardownRequestedRef.current = true;
      void bridge.teardownResource({
        reason: "The host is tearing down the MCP app resource.",
      });
    };
  }, [appInitialized, bridge]);

  if (dismissed) {
    return null;
  }

  return (
    <div className="w-full space-y-4 pb-6">
      <div className="space-y-2">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          App
        </h4>
        <Collapsible
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          className="space-y-2"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 py-1">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center">
                {serverIconSrc ? (
                  <img
                    src={serverIconSrc}
                    alt={`${serverDisplayName} icon`}
                    className="max-h-10 max-w-10 object-contain"
                  />
                ) : (
                  <ServerIcon className="size-5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 space-y-0.5">
                <p className="break-words text-sm font-medium text-foreground">
                  {serverDisplayName}
                </p>
                <p className="break-words text-sm text-muted-foreground">
                  {catalogToolDisplayName}
                </p>
              </div>
            </div>
            {(hasToolInput || hasToolResult) && (
              <Button
                type="button"
                size="xs"
                variant="ghost-light"
                className="shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setDetailsOpen((current) => !current)}
                rightIcon={
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform",
                      detailsOpen && "rotate-180",
                    )}
                  />
                }
              >
                Details
              </Button>
            )}
          </div>
          <CollapsibleContent className="space-y-3 data-[state=closed]:animate-out data-[state=open]:animate-in">
            {hasToolInput ? <ToolInput input={toolInput} /> : null}
            {hasToolResult ? (
              <ToolOutput
                output={isError ? undefined : appResultOutput}
                errorText={isError ? resultText : undefined}
              />
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div
        ref={frameContainerRef}
        className={cn(
          "w-full overflow-hidden",
          shouldRenderFrameBorder
            ? "rounded-md border border-border bg-transparent"
            : "rounded-none border-0 bg-transparent shadow-none",
        )}
      >
        {loading ? (
          <div
            className="flex items-center justify-center text-xs text-muted-foreground"
            style={{ height: `${INITIAL_APP_FRAME_HEIGHT}px` }}
          >
            Loading app…
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-destructive">{error}</div>
        ) : html ? (
          <div
            className="relative bg-transparent"
            style={{ height: `${frameHeight}px` }}
          >
            <iframe
              ref={sandboxFrameRef}
              key={sandboxUrlWithCsp}
              src={sandboxUrlWithCsp}
              title={`${sdkToolName} app`}
              data-testid="mcp-app-frame"
              sandbox="allow-scripts allow-same-origin"
              className={cn(
                "block h-full w-full border-0 bg-transparent transition-opacity duration-150",
                appVisible ? "visible opacity-100" : "invisible opacity-0",
              )}
              allow={buildInnerIframeAllowAttribute(resourcePermissions)}
              onLoad={() => {
                setSandboxReady(true);
              }}
            />
            {!appVisible ? (
              <div className="absolute inset-0 flex items-center justify-center bg-transparent text-xs text-muted-foreground">
                Preparing app…
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className="flex items-center justify-center text-xs text-muted-foreground"
            style={{ height: `${INITIAL_APP_FRAME_HEIGHT}px` }}
          >
            App resource returned no HTML.
          </div>
        )}
      </div>
    </div>
  );
}
