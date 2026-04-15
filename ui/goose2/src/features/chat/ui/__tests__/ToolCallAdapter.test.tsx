import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCardDisplay } from "@/features/chat/hooks/ArtifactPolicyContext";
import type { ArtifactPathCandidate } from "@/features/chat/lib/artifactPathPolicy";
import { ToolCallAdapter } from "../ToolCallAdapter";

// ── mocks ────────────────────────────────────────────────────────────

const mockResolveToolCardDisplay =
  vi.fn<
    (
      args: Record<string, unknown>,
      name: string,
      result?: string,
    ) => ToolCardDisplay
  >();
const mockPathExists = vi.fn<(path: string) => Promise<boolean>>();
const mockOpenResolvedPath = vi.fn<(path: string) => Promise<void>>();
const mockAcpReadResource = vi.fn();
const mockAcpGetTools = vi.fn();
const mockAcpListResources = vi.fn();
const { mockAppBridgeInstances } = vi.hoisted(() => ({
  mockAppBridgeInstances: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactPolicyContext: () => ({
    resolveToolCardDisplay: mockResolveToolCardDisplay,
    resolveMarkdownHref: () => null,
    pathExists: mockPathExists,
    openResolvedPath: mockOpenResolvedPath,
  }),
}));

vi.mock("@/shared/api/acp", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/acp")>(
    "@/shared/api/acp",
  );

  return {
    ...actual,
    acpReadResource: (...args: unknown[]) => mockAcpReadResource(...args),
    acpGetTools: (...args: unknown[]) => mockAcpGetTools(...args),
    acpListResources: (...args: unknown[]) => mockAcpListResources(...args),
  };
});

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({
    resolvedTheme: "dark",
  }),
}));

vi.mock("@mcp-ui/client", () => ({
  AppBridge: class {
    oninitialized?: () => void;
    onsizechange?: (params: unknown) => void;
    onrequestteardown?: () => void;
    readonly connect = vi.fn(async () => {
      this.oninitialized?.();
      return undefined;
    });
    readonly close = vi.fn(async () => undefined);
    readonly setHostContext = vi.fn();
    readonly sendSandboxResourceReady = vi.fn(async () => undefined);
    readonly sendToolInput = vi.fn(async () => undefined);
    readonly sendToolResult = vi.fn(async () => undefined);
    readonly sendToolCancelled = vi.fn(async () => undefined);
    readonly teardownResource = vi.fn(async () => undefined);

    constructor() {
      mockAppBridgeInstances.push(this as unknown as Record<string, unknown>);
    }
  },
  PostMessageTransport: class {},
}));

// ── helpers ──────────────────────────────────────────────────────────

const EMPTY_DISPLAY: ToolCardDisplay = {
  role: "none",
  primaryCandidate: null,
  secondaryCandidates: [],
};

function makeCandidate(
  overrides: Partial<ArtifactPathCandidate> = {},
): ArtifactPathCandidate {
  return {
    id: "c-1",
    rawPath: "/project/output.md",
    resolvedPath: "/Users/test/project/output.md",
    source: "arg_key",
    confidence: "high",
    kind: "file",
    allowed: true,
    blockedReason: null,
    toolCallId: "tool-1",
    toolName: "write_file",
    toolCallIndex: 0,
    appearanceIndex: 0,
    ...overrides,
  };
}

function renderAdapter(
  overrides: Partial<Parameters<typeof ToolCallAdapter>[0]> = {},
) {
  return render(
    <ToolCallAdapter
      name="write_file"
      arguments={{ path: "/project/output.md" }}
      status="completed"
      result="Created /project/output.md"
      {...overrides}
    />,
  );
}

// ── tests ────────────────────────────────────────────────────────────

describe("ToolCallAdapter — ArtifactActions", () => {
  beforeEach(() => {
    mockResolveToolCardDisplay.mockReset();
    mockPathExists.mockReset();
    mockOpenResolvedPath.mockReset();
    mockAcpReadResource.mockReset();
    mockAcpGetTools.mockReset();
    mockAcpListResources.mockReset();
    mockAppBridgeInstances.length = 0;
  });

  it("renders MCP apps inline when lookup falls back from a summarized tool title", async () => {
    mockResolveToolCardDisplay.mockReturnValue(EMPTY_DISPLAY);
    mockAcpGetTools.mockResolvedValue([
      {
        name: "mcpappbench___mcp_app_bench",
        _meta: {
          goose_extension: "mcpappbench",
          ui: {
            resourceUri: "ui://mcp-app-bench/launcher",
          },
        },
      },
    ]);
    mockAcpReadResource.mockResolvedValue({
      uri: "ui://mcp-app-bench/launcher",
      text: "<html><body><h1>MCP App Bench</h1></body></html>",
      mimeType: "text/html;profile=mcp-app",
      _meta: null,
    });

    renderAdapter({
      sessionId: "session-summarized-title",
      name: "running mcp app bench tool",
      catalogName: "running mcp app bench tool",
      open: true,
      rawOutput: {
        content: [
          {
            type: "text",
            text: "MCP App Bench launcher loaded. Select an inspector to begin testing.",
          },
        ],
        extensionName: "mcpappbench",
        isError: false,
        structuredContent: {
          name: "mcp-app-bench",
        },
      },
      result: "MCP App Bench launcher loaded.",
    });

    expect(await screen.findByTestId("mcp-app-frame")).toBeInTheDocument();
    expect(mockAcpReadResource).toHaveBeenCalledWith(
      "session-summarized-title",
      "ui://mcp-app-bench/launcher",
      "mcpappbench",
    );
  });

  it("keeps the MCP app path alive when tools/list is briefly unavailable", async () => {
    mockResolveToolCardDisplay.mockReturnValue(EMPTY_DISPLAY);
    mockAcpGetTools
      .mockRejectedValueOnce(new Error("catalog not ready"))
      .mockResolvedValue([
        {
          name: "mcpappbench___mcp_app_bench",
          _meta: {
            goose_extension: "mcpappbench",
            ui: {
              resourceUri: "ui://mcp-app-bench/launcher",
            },
          },
        },
      ]);
    mockAcpReadResource.mockResolvedValue({
      uri: "ui://mcp-app-bench/launcher",
      text: "<html><body><h1>MCP App Bench</h1></body></html>",
      mimeType: "text/html;profile=mcp-app",
      _meta: null,
    });

    renderAdapter({
      sessionId: "session-lookup-retry",
      name: "running mcp app benchmark suite",
      catalogName: "running mcp app benchmark suite",
      open: true,
      rawOutput: {
        content: [
          {
            type: "text",
            text: "MCP App Bench launcher loaded. Select an inspector to begin testing.",
          },
        ],
        extensionName: "mcpappbench",
        isError: false,
        structuredContent: {
          name: "mcp-app-bench",
        },
      },
      result: "MCP App Bench launcher loaded.",
    });

    expect(await screen.findByTestId("mcp-app-frame")).toBeInTheDocument();
    expect(mockAcpGetTools).toHaveBeenCalledTimes(2);
    expect(mockAcpReadResource).toHaveBeenCalledWith(
      "session-lookup-retry",
      "ui://mcp-app-bench/launcher",
      "mcpappbench",
    );
  });

  it("falls back to extension resources when tool metadata omits the resource URI", async () => {
    mockResolveToolCardDisplay.mockReturnValue(EMPTY_DISPLAY);
    mockAcpGetTools.mockResolvedValue([
      {
        name: "mcpappbench___launcher",
        _meta: {
          goose_extension: "mcpappbench",
        },
      },
    ]);
    mockAcpListResources.mockResolvedValue({
      resources: [
        {
          uri: "ui://mcp-app-bench/launcher",
          name: "mcp-app-bench",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    });
    mockAcpReadResource.mockResolvedValue({
      uri: "ui://mcp-app-bench/launcher",
      text: "<html><body><h1>MCP App Bench</h1></body></html>",
      mimeType: "text/html;profile=mcp-app",
      _meta: null,
    });

    renderAdapter({
      sessionId: "session-resource-list-fallback",
      name: "running mcp app benchmark",
      catalogName: "running mcp app benchmark",
      open: true,
      rawOutput: {
        extensionName: "mcpappbench",
        structuredContent: {
          name: "mcp-app-bench",
        },
      },
      result: "Interactive app available",
    });

    expect(await screen.findByTestId("mcp-app-frame")).toBeInTheDocument();
    expect(mockAcpListResources).toHaveBeenCalledWith(
      "session-resource-list-fallback",
      "mcpappbench",
    );
    expect(mockAcpReadResource).toHaveBeenCalledWith(
      "session-resource-list-fallback",
      "ui://mcp-app-bench/launcher",
      "mcpappbench",
    );
  });

  it("uses the exact catalog extension name for resource-list fallback", async () => {
    mockResolveToolCardDisplay.mockReturnValue(EMPTY_DISPLAY);
    mockAcpGetTools.mockResolvedValue([
      {
        name: "axonneighborhood_aharavard___get-restaurants-nearby",
        _meta: {
          goose_extension: "axonneighborhood_aharavard_",
        },
      },
    ]);
    mockAcpListResources.mockResolvedValue({
      resources: [
        {
          uri: "ui://widget/restaurants-widget-5b5f69b9.html",
          name: "restaurants-widget",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    });
    mockAcpReadResource.mockResolvedValue({
      uri: "ui://widget/restaurants-widget-5b5f69b9.html",
      text: "<html><body><h1>Restaurants</h1></body></html>",
      mimeType: "text/html;profile=mcp-app",
      _meta: null,
    });

    renderAdapter({
      sessionId: "session-exact-extension-name",
      name: "getting restaurants near new york",
      catalogName: "axonneighborhood aharavard: get-restaurants-nearby",
      open: true,
      rawOutput: {
        extensionName: "axonneighborhood_aharavard",
        structuredContent: {
          name: "restaurants-widget",
        },
      },
      result: "Interactive app available",
    });

    expect(await screen.findByTestId("mcp-app-frame")).toBeInTheDocument();
    expect(mockAcpListResources).toHaveBeenCalledWith(
      "session-exact-extension-name",
      "axonneighborhood_aharavard_",
    );
    expect(mockAcpReadResource).toHaveBeenCalledWith(
      "session-exact-extension-name",
      "ui://widget/restaurants-widget-5b5f69b9.html",
      "axonneighborhood_aharavard_",
    );
  });

  it('renders "Open file" button when primary candidate exists', () => {
    const primary = makeCandidate();
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: primary,
      secondaryCandidates: [],
    });

    renderAdapter();

    expect(screen.getByRole("button", { name: /open file/i })).toBeEnabled();
    expect(screen.getByText(primary.rawPath)).toBeInTheDocument();
  });

  it("does NOT render artifact actions when display role is none", () => {
    mockResolveToolCardDisplay.mockReturnValue(EMPTY_DISPLAY);

    renderAdapter();

    expect(
      screen.queryByRole("button", { name: /open file/i }),
    ).not.toBeInTheDocument();
  });

  it('shows "More outputs" toggle for secondary candidates', async () => {
    const user = userEvent.setup();
    const primary = makeCandidate();
    const secondary = makeCandidate({
      id: "c-2",
      rawPath: "/project/notes.md",
      resolvedPath: "/Users/test/project/notes.md",
    });
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: primary,
      secondaryCandidates: [secondary],
    });

    renderAdapter();

    const toggle = screen.getByText(/more outputs/i);
    expect(toggle).toBeInTheDocument();

    // Secondary button not visible initially
    expect(screen.queryByText(secondary.rawPath)).not.toBeInTheDocument();

    await user.click(toggle);

    // After expanding, secondary candidate is visible
    expect(screen.getByText(secondary.rawPath)).toBeInTheDocument();
  });

  it("disables button and shows blocked reason for disallowed primary candidate", () => {
    const blocked = makeCandidate({
      allowed: false,
      blockedReason: "Path is outside allowed project/artifacts roots.",
    });
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: blocked,
      secondaryCandidates: [],
    });

    renderAdapter();

    expect(screen.getByRole("button", { name: /open file/i })).toBeDisabled();
    expect(
      screen.getByText("Path is outside allowed project/artifacts roots."),
    ).toBeInTheDocument();
  });

  it("shows blocked reason for disallowed secondary candidates", async () => {
    const user = userEvent.setup();
    const primary = makeCandidate();
    const blockedSecondary = makeCandidate({
      id: "c-2",
      rawPath: "/outside/secret.md",
      resolvedPath: "/Users/test/outside/secret.md",
      allowed: false,
      blockedReason: "Path is outside allowed project/artifacts roots.",
    });
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: primary,
      secondaryCandidates: [blockedSecondary],
    });

    renderAdapter();
    await user.click(screen.getByText(/more outputs/i));

    const secondaryBtn = screen.getByTitle(blockedSecondary.resolvedPath);
    expect(secondaryBtn).toBeDisabled();
    expect(
      screen.getByText("Path is outside allowed project/artifacts roots."),
    ).toBeInTheDocument();
  });

  it('does not show "detected" label for low-confidence primary candidate', () => {
    const lowConf = makeCandidate({ confidence: "low" });
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: lowConf,
      secondaryCandidates: [],
    });

    renderAdapter();

    expect(screen.queryByText("detected")).not.toBeInTheDocument();
  });

  it('does NOT show "detected" label for high-confidence candidate', () => {
    const highConf = makeCandidate({ confidence: "high" });
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: highConf,
      secondaryCandidates: [],
    });

    renderAdapter();

    expect(screen.queryByText("detected")).not.toBeInTheDocument();
  });

  it('does not show "detected" label for low-confidence secondary candidate', async () => {
    const user = userEvent.setup();
    const primary = makeCandidate();
    const lowConfSecondary = makeCandidate({
      id: "c-2",
      rawPath: "/project/maybe.md",
      resolvedPath: "/Users/test/project/maybe.md",
      confidence: "low",
    });
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: primary,
      secondaryCandidates: [lowConfSecondary],
    });

    renderAdapter();
    await user.click(screen.getByText(/more outputs/i));

    expect(screen.queryByText("detected")).not.toBeInTheDocument();
  });

  it("opens file when primary button is clicked", async () => {
    const user = userEvent.setup();
    const primary = makeCandidate();
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: primary,
      secondaryCandidates: [],
    });
    mockPathExists.mockResolvedValue(true);
    mockOpenResolvedPath.mockResolvedValue(undefined);

    renderAdapter();
    await user.click(screen.getByRole("button", { name: /open file/i }));

    expect(mockOpenResolvedPath).toHaveBeenCalledWith(primary.resolvedPath);
  });

  it("shows file-not-found error when path does not exist", async () => {
    const user = userEvent.setup();
    const primary = makeCandidate();
    mockResolveToolCardDisplay.mockReturnValue({
      role: "primary_host",
      primaryCandidate: primary,
      secondaryCandidates: [],
    });
    mockPathExists.mockResolvedValue(false);

    renderAdapter();
    await user.click(screen.getByRole("button", { name: /open file/i }));

    expect(
      await screen.findByText(`File not found: ${primary.resolvedPath}`),
    ).toBeInTheDocument();
  });
});
