// Parsing, catalog overlays, and capability consent account for the same families.
export const PLUGIN_MANIFEST_CONTRACT_KEYS = [
  /** Executor ids implemented by the plugin's code-mode-executor-api artifact. */
  "codeModeExecutors",
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  /** Provider ids whose runtime-only auth hooks let overlays load only the owning plugin. */
  "externalAuthProviders",
  "decisionProviders",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "storageProviders",
  /** Provider ids whose plugin owns usage auth and snapshot hooks. */
  "usageProviders",
  /**
   * Provider ids whose credentials may authorize a usage provider listed above
   * (for example a shared API key across a subscription and a pay-as-you-go
   * sibling). Read-only credential sources: this never transfers ownership.
   */
  "usageCredentialProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const;
