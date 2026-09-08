/**
 * Dedicated CodeRelay Settings Model.
 *
 * Exposes a typed, structured representation of all CodeRelay configuration options
 * across 6 core operational categories. Reads from and persists to VS Code configuration.
 */

export interface CodeRelayGeneralSettings {
  readonly defaultTaskMode: 'code' | 'plan' | 'debug' | 'review' | 'test' | 'ask';
  readonly autoStart: boolean;
  readonly confirmDangerousCommands: boolean;
  readonly enableSoundNotifications: boolean;
}

export interface CodeRelayAiSettings {
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly automaticRouting: boolean;
  readonly allowFallback: boolean;
  readonly autoRelayOnFailure: boolean;
}

export interface CodeRelayExecutionSettings {
  readonly checkpointFrequency: 'each_turn' | 'file_modifications_only' | 'manual';
  readonly permissionMode: 'safe' | 'balanced' | 'autonomous';
  readonly commandTimeoutMs: number;
  readonly maxRetries: number;
}

export interface CodeRelayVerificationSettings {
  readonly runTests: boolean;
  readonly runBuild: boolean;
  readonly runTypecheck: boolean;
  readonly runLint: boolean;
  readonly checkDiagnostics: boolean;
}

export interface CodeRelayAppearanceSettings {
  readonly compactMode: boolean;
  readonly showAdvancedMetrics: boolean;
  readonly timelineDensity: 'compact' | 'comfortable';
}

export interface CodeRelayDataSettings {
  readonly taskRetentionDays: number;
  readonly recordDetailedLedger: boolean;
}

export interface CodeRelaySettingsModel {
  readonly general: CodeRelayGeneralSettings;
  readonly ai: CodeRelayAiSettings;
  readonly execution: CodeRelayExecutionSettings;
  readonly verification: CodeRelayVerificationSettings;
  readonly appearance: CodeRelayAppearanceSettings;
  readonly data: CodeRelayDataSettings;
}

export const DEFAULT_SETTINGS: CodeRelaySettingsModel = {
  general: {
    defaultTaskMode: 'code',
    autoStart: true,
    confirmDangerousCommands: true,
    enableSoundNotifications: true,
  },
  ai: {
    // Empty means "whatever is configured", not a specific vendor's model.
    // Naming one here made the settings screen display a provider and model the
    // user may never have set up, and pinned the default to models that age:
    // anything released later could never become the default without an
    // extension update.
    defaultProvider: '',
    defaultModel: '',
    automaticRouting: true,
    allowFallback: true,
    autoRelayOnFailure: true,
  },
  execution: {
    checkpointFrequency: 'file_modifications_only',
    permissionMode: 'balanced',
    commandTimeoutMs: 120_000,
    maxRetries: 3,
  },
  verification: {
    runTests: true,
    runBuild: true,
    runTypecheck: true,
    runLint: true,
    checkDiagnostics: true,
  },
  appearance: {
    compactMode: false,
    showAdvancedMetrics: true,
    timelineDensity: 'comfortable',
  },
  data: {
    taskRetentionDays: 30,
    recordDetailedLedger: true,
  },
};
