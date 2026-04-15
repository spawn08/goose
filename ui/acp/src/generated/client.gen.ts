// This file is auto-generated — do not edit manually.

export interface ExtMethodProvider {
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

import type {
  AddExtensionRequest,
  ArchiveSessionRequest,
  CallToolRequest,
  CallToolResponse,
  CheckSecretRequest,
  CheckSecretResponse,
  DeleteSessionRequest,
  ExportSessionRequest,
  ExportSessionResponse,
  GetExtensionsRequest,
  GetExtensionsResponse,
  GetProviderDetailsRequest,
  GetProviderDetailsResponse,
  GetProviderModelsRequest,
  GetProviderModelsResponse,
  GetToolsRequest,
  GetToolsResponse,
  ImportSessionRequest,
  ImportSessionResponse,
  ListPromptsRequest,
  ListPromptsResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResponse,
  ListResourcesRequest,
  ListResourcesResponse,
  ReadConfigRequest,
  ReadConfigResponse,
  ReadResourceRequest,
  ReadResourceResponse,
  RemoveConfigRequest,
  RemoveExtensionRequest,
  RemoveSecretRequest,
  UnarchiveSessionRequest,
  UpdateProviderRequest,
  UpdateProviderResponse,
  UpdateWorkingDirRequest,
  UpsertConfigRequest,
  UpsertSecretRequest,
} from './types.gen.js';
import {
  zCallToolResponse,
  zCheckSecretResponse,
  zExportSessionResponse,
  zGetExtensionsResponse,
  zGetProviderDetailsResponse,
  zGetProviderModelsResponse,
  zGetToolsResponse,
  zImportSessionResponse,
  zListPromptsResponse,
  zListProvidersResponse,
  zListResourceTemplatesResponse,
  zListResourcesResponse,
  zReadConfigResponse,
  zReadResourceResponse,
  zUpdateProviderResponse,
} from './zod.gen.js';

export class GooseExtClient {
  constructor(private conn: ExtMethodProvider) {}

  async GooseExtensionsAdd(params: AddExtensionRequest): Promise<void> {
    await this.conn.extMethod("_goose/extensions/add", params);
  }

  async GooseExtensionsRemove(params: RemoveExtensionRequest): Promise<void> {
    await this.conn.extMethod("_goose/extensions/remove", params);
  }

  async GooseTools(params: GetToolsRequest): Promise<GetToolsResponse> {
    const raw = await this.conn.extMethod("_goose/tools", params);
    return zGetToolsResponse.parse(raw) as GetToolsResponse;
  }

  async GooseToolsCall(params: CallToolRequest): Promise<CallToolResponse> {
    const raw = await this.conn.extMethod("_goose/tools/call", params);
    return zCallToolResponse.parse(raw) as CallToolResponse;
  }

  async GooseResourcesList(
    params: ListResourcesRequest,
  ): Promise<ListResourcesResponse> {
    const raw = await this.conn.extMethod("_goose/resources/list", params);
    return zListResourcesResponse.parse(raw) as ListResourcesResponse;
  }

  async GooseResourcesTemplatesList(
    params: ListResourceTemplatesRequest,
  ): Promise<ListResourceTemplatesResponse> {
    const raw = await this.conn.extMethod(
      "_goose/resources/templates/list",
      params,
    );
    return zListResourceTemplatesResponse.parse(
      raw,
    ) as ListResourceTemplatesResponse;
  }

  async GooseResourceRead(
    params: ReadResourceRequest,
  ): Promise<ReadResourceResponse> {
    const raw = await this.conn.extMethod("_goose/resource/read", params);
    return zReadResourceResponse.parse(raw) as ReadResourceResponse;
  }

  async GoosePromptsList(
    params: ListPromptsRequest,
  ): Promise<ListPromptsResponse> {
    const raw = await this.conn.extMethod("_goose/prompts/list", params);
    return zListPromptsResponse.parse(raw) as ListPromptsResponse;
  }

  async GooseWorkingDirUpdate(params: UpdateWorkingDirRequest): Promise<void> {
    await this.conn.extMethod("_goose/working_dir/update", params);
  }

  async sessionDelete(params: DeleteSessionRequest): Promise<void> {
    await this.conn.extMethod("session/delete", params);
  }

  async GooseConfigExtensions(
    params: GetExtensionsRequest,
  ): Promise<GetExtensionsResponse> {
    const raw = await this.conn.extMethod("_goose/config/extensions", params);
    return zGetExtensionsResponse.parse(raw) as GetExtensionsResponse;
  }

  async GooseSessionProviderUpdate(
    params: UpdateProviderRequest,
  ): Promise<UpdateProviderResponse> {
    const raw = await this.conn.extMethod(
      "_goose/session/provider/update",
      params,
    );
    return zUpdateProviderResponse.parse(raw) as UpdateProviderResponse;
  }

  async GooseProvidersList(
    params: ListProvidersRequest,
  ): Promise<ListProvidersResponse> {
    const raw = await this.conn.extMethod("_goose/providers/list", params);
    return zListProvidersResponse.parse(raw) as ListProvidersResponse;
  }

  async GooseProvidersDetails(
    params: GetProviderDetailsRequest,
  ): Promise<GetProviderDetailsResponse> {
    const raw = await this.conn.extMethod("_goose/providers/details", params);
    return zGetProviderDetailsResponse.parse(raw) as GetProviderDetailsResponse;
  }

  async GooseProvidersModels(
    params: GetProviderModelsRequest,
  ): Promise<GetProviderModelsResponse> {
    const raw = await this.conn.extMethod("_goose/providers/models", params);
    return zGetProviderModelsResponse.parse(raw) as GetProviderModelsResponse;
  }

  async GooseConfigRead(
    params: ReadConfigRequest,
  ): Promise<ReadConfigResponse> {
    const raw = await this.conn.extMethod("_goose/config/read", params);
    return zReadConfigResponse.parse(raw) as ReadConfigResponse;
  }

  async GooseConfigUpsert(params: UpsertConfigRequest): Promise<void> {
    await this.conn.extMethod("_goose/config/upsert", params);
  }

  async GooseConfigRemove(params: RemoveConfigRequest): Promise<void> {
    await this.conn.extMethod("_goose/config/remove", params);
  }

  async GooseSecretCheck(
    params: CheckSecretRequest,
  ): Promise<CheckSecretResponse> {
    const raw = await this.conn.extMethod("_goose/secret/check", params);
    return zCheckSecretResponse.parse(raw) as CheckSecretResponse;
  }

  async GooseSecretUpsert(params: UpsertSecretRequest): Promise<void> {
    await this.conn.extMethod("_goose/secret/upsert", params);
  }

  async GooseSecretRemove(params: RemoveSecretRequest): Promise<void> {
    await this.conn.extMethod("_goose/secret/remove", params);
  }

  async GooseSessionExport(
    params: ExportSessionRequest,
  ): Promise<ExportSessionResponse> {
    const raw = await this.conn.extMethod("_goose/session/export", params);
    return zExportSessionResponse.parse(raw) as ExportSessionResponse;
  }

  async GooseSessionImport(
    params: ImportSessionRequest,
  ): Promise<ImportSessionResponse> {
    const raw = await this.conn.extMethod("_goose/session/import", params);
    return zImportSessionResponse.parse(raw) as ImportSessionResponse;
  }

  async GooseSessionArchive(params: ArchiveSessionRequest): Promise<void> {
    await this.conn.extMethod("_goose/session/archive", params);
  }

  async GooseSessionUnarchive(params: UnarchiveSessionRequest): Promise<void> {
    await this.conn.extMethod("_goose/session/unarchive", params);
  }
}
