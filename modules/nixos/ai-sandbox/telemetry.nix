# Opt-outs for the telemetry and update checks of the tools the AI sandbox
# runs. ONNX Runtime (loaded by opencode-mem and chromadb) reports to
# Microsoft by default since 1.29; the rest are the variables other tools honor.
{
  ORT_DISABLE_TELEMETRY = "1";
  ANONYMIZED_TELEMETRY = "False";
  HF_HUB_DISABLE_TELEMETRY = "1";
  DO_NOT_TRACK = "1";
  DISABLE_TELEMETRY = "1";
  DISABLE_ERROR_REPORTING = "1";
  NPM_CONFIG_UPDATE_NOTIFIER = "false";
  DOTNET_CLI_TELEMETRY_OPTOUT = "1";
  POWERSHELL_TELEMETRY_OPTOUT = "1";
  AZURE_CORE_COLLECT_TELEMETRY = "0";
  NEXT_TELEMETRY_DISABLED = "1";
  NUXT_TELEMETRY_DISABLED = "1";
  ASTRO_TELEMETRY_DISABLED = "1";
  GATSBY_TELEMETRY_DISABLED = "1";
  STORYBOOK_DISABLE_TELEMETRY = "1";
  TURBO_TELEMETRY_DISABLED = "1";
}
